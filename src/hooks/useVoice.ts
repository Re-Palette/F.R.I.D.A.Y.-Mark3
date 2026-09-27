"use client";

/**
 * 音声会話。「フライデー」と呼ぶと起動し、話した内容を送り、返答を読み上げる。
 *
 *   off ──(VOICE MODE ON)──▶ standby ──「フライデー」──▶ listening ──発言──▶ thinking
 *                              ▲                             ▲                   │
 *                              └──── 8 秒沈黙 ────────────────┴──── 読み上げ終了 ◀─ speaking
 *
 * - 「フライデー、〇〇」と続けて言えば、そのまま〇〇を送る。
 * - 返答の読み上げ中はマイクを止める（自分の声を拾わないため）。
 * - 読み上げ後 8 秒間は呼びかけなしで続けて話せる。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  chime,
  getAudioContext,
  getRecognitionCtor,
  pickJapaneseVoice,
  splitWake,
  stripWake,
  takeSentences,
  toSpeakable,
  unlockAudio,
  type RecognitionLike,
} from "@/lib/speech";

export type VoiceState = "off" | "standby" | "listening" | "thinking" | "speaking";

const FOLLOW_UP_MS = 8000;
/** 聞き取り途中の文字がこの時間変わらなければ「話し終わった」とみなす（ブラウザの確定待ちより速い） */
const END_OF_SPEECH_MS = 700;
const STORAGE_KEY = "friday.voice.v1";

export interface SpeakInput {
  id: string;
  createdAt: number;
  text: string;
  done: boolean;
}

interface SpeechItem {
  text: string;
  /** ElevenLabs の音声（先読みを始めたら入る。届いた端から再生できる） */
  audio?: HTMLAudioElement;
}

/** これより短い文は次の文とまとめて声にする（リクエスト数削減・抑揚も自然に） */
const MIN_CHUNK = 12;

export function useVoice({
  onCommand,
  cloudVoice = false,
}: {
  onCommand: (text: string) => void;
  /** ElevenLabs の声を使う（サーバー側で設定済みのとき） */
  cloudVoice?: boolean;
}) {
  const [state, setState] = useState<VoiceState>("off");
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [supported, setSupported] = useState(true);

  const stateRef = useRef<VoiceState>("off");
  const recRef = useRef<RecognitionLike | null>(null);
  const runningRef = useRef(false);
  const followTimer = useRef(0);
  /** 確定前の聞き取り途中テキスト（確定の合図が来ないブラウザでは、区切りでこれを使う） */
  const pendingRef = useRef("");
  const silenceTimer = useRef(0);
  const restartTimer = useRef(0);
  const onCommandRef = useRef(onCommand);
  onCommandRef.current = onCommand;
  const cloudRef = useRef(cloudVoice);
  cloudRef.current = cloudVoice;
  /** ElevenLabs が致命的に失敗したら（キー誤り・枠切れ）このセッションでは使わない */
  const cloudDisabled = useRef(false);
  const cloudFailures = useRef(0);

  /* 読み上げの状態 */
  const speech = useRef({
    armedAt: 0, // 音声で話しかけた時刻（これより後の応答だけ読み上げる）
    id: "",
    spokenUpTo: 0,
    queue: [] as SpeechItem[],
    carry: "", // まとめ待ちの短い文
    chunks: 0, // この返答で読み上げに回した数（最初の一言だけ特別扱い）
    speaking: false,
    finished: false,
    gen: 0, // 停止のたびに増やし、古い再生処理を無効にする
    voice: null as SpeechSynthesisVoice | null,
    current: null as SpeechSynthesisUtterance | null,
    stopAudio: null as (() => void) | null,
    controllers: new Set<AbortController>(),
    guard: 0,
  });

  const set = useCallback((s: VoiceState) => {
    stateRef.current = s;
    setState(s);
  }, []);

  /* ---------- マイク ---------- */

  const startRec = useCallback(() => {
    const rec = recRef.current;
    if (!rec || runningRef.current) return;
    try {
      rec.start();
      runningRef.current = true;
    } catch {
      /* 既に開始済みなど */
    }
  }, []);

  const stopRec = useCallback(() => {
    clearTimeout(restartTimer.current);
    clearTimeout(silenceTimer.current);
    pendingRef.current = "";
    const rec = recRef.current;
    if (!rec || !runningRef.current) return;
    try {
      rec.abort();
    } catch {
      /* noop */
    }
    runningRef.current = false;
  }, []);

  const toStandby = useCallback(() => {
    clearTimeout(followTimer.current);
    setInterim("");
    set("standby");
    startRec();
  }, [set, startRec]);

  /** 呼びかけなしで話せる状態（一定時間で待機に戻る） */
  const listenFor = useCallback(
    (ms: number) => {
      clearTimeout(followTimer.current);
      set("listening");
      startRec();
      followTimer.current = window.setTimeout(() => {
        if (stateRef.current === "listening") toStandby();
      }, ms);
    },
    [set, startRec, toStandby],
  );

  const dispatch = useCallback(
    (text: string) => {
      const command = stripWake(text);
      if (!command) return;
      clearTimeout(followTimer.current);
      setInterim("");
      stopRec();
      speech.current.armedAt = Date.now();
      set("thinking");
      onCommandRef.current(command);
    },
    [set, stopRec],
  );

  /* 音声認識の初期化 */
  useEffect(() => {
    const Ctor = getRecognitionCtor();
    if (!Ctor) {
      setSupported(false);
      return;
    }
    const rec = new Ctor();
    rec.lang = "ja-JP";
    // 1 発言ずつ区切って聞く（区切りごとに自動で再開）。連続モードは Safari 等で
    // 「確定」の合図が来ず、呼びかけを判定できないことがあるため使わない。
    rec.continuous = false;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    /** 聞き取れた 1 発言を処理する */
    const handleUtterance = (raw: string) => {
      const text = raw.trim();
      if (!text) return;
      const mode = stateRef.current;
      if (mode === "standby") {
        const { woke, command } = splitWake(text);
        if (!woke) {
          setInterim(`聞こえた：${text}`);
          return;
        }
        if (command.length >= 2) dispatch(command);
        else {
          chime("wake");
          setInterim("");
          listenFor(FOLLOW_UP_MS);
        }
      } else if (mode === "listening") {
        dispatch(text);
      }
    };

    rec.onresult = (e) => {
      let finalText = "";
      let interimText = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript;
        else interimText += r[0].transcript;
      }
      const mode = stateRef.current;
      clearTimeout(silenceTimer.current);
      if (finalText.trim()) {
        pendingRef.current = "";
        handleUtterance(finalText);
        return;
      }
      pendingRef.current = interimText;
      // 少し黙ったら、ブラウザの確定を待たずに話し終わりとして扱う
      if (interimText.trim()) {
        silenceTimer.current = window.setTimeout(() => {
          const text = pendingRef.current;
          pendingRef.current = "";
          if (!text.trim()) return;
          try {
            rec.abort(); // 同じ発言を二重に処理しないよう、この回の認識は打ち切る
          } catch {
            /* noop */
          }
          handleUtterance(text);
        }, END_OF_SPEECH_MS);
      }
      if (mode === "listening") setInterim(interimText.trim());
      else if (mode === "standby") setInterim(splitWake(interimText).woke ? "…" : `聞こえた：${interimText.trim()}`);
    };

    rec.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        setError("マイクの使用が許可されていません。アドレスバーのマイクのアイコンから許可してください。");
        runningRef.current = false;
        set("off");
      } else if (e.error === "network") {
        setError("音声認識サービスに接続できません。ネットワークを確認してください。");
      } else if (e.error === "audio-capture") {
        setError("マイクが見つかりません。");
      }
      // no-speech / aborted などは onend で再開するので無視
    };

    rec.onend = () => {
      runningRef.current = false;
      // 確定の合図が来ないまま区切られたら、最後に聞こえた内容で判定する
      const leftover = pendingRef.current;
      pendingRef.current = "";
      if (leftover.trim()) handleUtterance(leftover);
      const s = stateRef.current;
      // 待機・聞き取り中に途切れたら自動で再開（ブラウザは一定時間で認識を止めるため）
      if (s === "standby" || s === "listening") {
        clearTimeout(restartTimer.current);
        restartTimer.current = window.setTimeout(startRec, 200);
      }
    };

    recRef.current = rec;
    return () => {
      rec.onresult = rec.onerror = rec.onend = null;
      try {
        rec.abort();
      } catch {
        /* noop */
      }
      recRef.current = null;
      runningRef.current = false;
    };
  }, [dispatch, listenFor, set, startRec]);

  /* 日本語の音声を選ぶ（一覧は非同期に読み込まれる） */
  useEffect(() => {
    const synth = typeof window !== "undefined" ? window.speechSynthesis : undefined;
    if (!synth) return;
    const load = () => {
      speech.current.voice = pickJapaneseVoice(synth.getVoices());
    };
    load();
    synth.addEventListener?.("voiceschanged", load);
    return () => synth.removeEventListener?.("voiceschanged", load);
  }, []);

  /* ---------- 読み上げ ---------- */

  const afterSpeech = useCallback(() => {
    const sp = speech.current;
    if (sp.speaking || sp.queue.length || !sp.finished) return;
    if (stateRef.current === "off") return;
    listenFor(FOLLOW_UP_MS);
  }, [listenFor]);

  const canUseCloud = () => cloudRef.current && !cloudDisabled.current && Boolean(getAudioContext());

  /** ElevenLabs が失敗したとき、原因を確認して致命的ならこのセッションでは使わない */
  const checkCloudFailure = useCallback(async () => {
    try {
      const res = await fetch("/api/status", { cache: "no-store" });
      const json = (await res.json()) as { tts?: { provider: string; reason?: string } };
      if (json.tts?.provider !== "elevenlabs") {
        cloudDisabled.current = true;
        setError(`${json.tts?.reason ?? "ElevenLabs が使えません。"}（ブラウザの声で読み上げます）`);
      }
    } catch {
      /* noop */
    }
  }, []);

  /** 音声の取得を始める（<audio> がダウンロードしながら再生するので、全部届くのを待たない） */
  const ensureFetch = useCallback((item: SpeechItem | undefined) => {
    if (!item || item.audio || !canUseCloud()) return;
    const el = new Audio();
    el.preload = "auto";
    el.src = `/api/tts?text=${encodeURIComponent(item.text)}`;
    item.audio = el;
  }, []);

  /** ElevenLabs の音声を再生。再生できなければ false（→ ブラウザの声で代わりに読む） */
  const playCloud = useCallback(
    (el: HTMLAudioElement, gen: number): Promise<boolean> =>
      new Promise<boolean>((resolve) => {
        if (gen !== speech.current.gen) return resolve(true);
        let done = false;
        let started = false;
        const finish = (ok: boolean) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          speech.current.stopAudio = null;
          el.onended = el.onerror = el.onplaying = null;
          if (!ok && !started) {
            // 遅れて鳴り出して声が二重にならないよう止めておく
            el.pause();
            el.removeAttribute("src");
            cloudFailures.current++;
            if (cloudFailures.current >= 2) void checkCloudFailure();
          }
          resolve(ok || started);
        };
        // 一定時間たっても再生が始まらなければ諦める
        const timer = window.setTimeout(() => finish(false), 8000);
        el.onplaying = () => {
          started = true;
          cloudFailures.current = 0;
          clearTimeout(timer);
        };
        el.onended = () => finish(true);
        el.onerror = () => finish(false);
        speech.current.stopAudio = () => {
          el.pause();
          el.removeAttribute("src");
          finish(true);
        };
        el.play().catch(() => finish(false));
      }),
    [checkCloudFailure],
  );

  /** ブラウザ標準の声で読む */
  const playBrowser = useCallback((text: string): Promise<void> => {
    const synth = window.speechSynthesis;
    if (!synth) return Promise.resolve();
    const sp = speech.current;
    return new Promise<void>((resolve) => {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "ja-JP";
      if (sp.voice) u.voice = sp.voice;
      u.rate = 1.25;
      u.pitch = 1;
      let ended = false;
      const end = () => {
        if (ended) return;
        ended = true;
        clearTimeout(sp.guard);
        resolve();
      };
      u.onend = end;
      u.onerror = end;
      sp.current = u; // 参照を保持（ガベージコレクションで onend が来ない不具合の対策）
      sp.guard = window.setTimeout(end, 4000 + text.length * 260); // onend が来ない環境向けの保険
      synth.speak(u);
    });
  }, []);

  /** キューを順に読み上げる（1 つずつ。次の文の音声は再生中に先読みする） */
  const speakNext = useCallback(async () => {
    const sp = speech.current;
    if (sp.speaking) return;
    const gen = sp.gen;
    sp.speaking = true;
    while (sp.queue.length && gen === sp.gen) {
      const item = sp.queue.shift()!;
      ensureFetch(item);
      ensureFetch(sp.queue[0]); // 次の文を先読み
      if (stateRef.current !== "off") {
        stopRec();
        set("speaking");
      }
      let played = false;
      if (item.audio) played = await playCloud(item.audio, gen);
      if (gen !== sp.gen) return;
      if (!played) await playBrowser(item.text);
    }
    if (gen !== sp.gen) return;
    sp.speaking = false;
    afterSpeech();
  }, [afterSpeech, ensureFetch, playBrowser, playCloud, set, stopRec]);

  const enqueue = useCallback((raw: string) => {
    const sp = speech.current;
    const text = toSpeakable(raw);
    if (!text) return;
    sp.queue.push({ text });
    sp.chunks++;
  }, []);

  /** 応答テキストを渡す（ストリーミング中は何度でも呼ぶ）。言い終わった文から順に読み上げる */
  const speak = useCallback(
    ({ id, createdAt, text, done }: SpeakInput) => {
      const sp = speech.current;
      if (!sp.armedAt || createdAt < sp.armedAt - 100) return; // 音声で話しかけた後の応答だけ
      if (sp.id !== id) {
        sp.id = id;
        sp.spokenUpTo = 0;
        sp.queue = [];
        sp.carry = "";
        sp.chunks = 0;
        sp.finished = false;
      }
      if (sp.finished) return;
      const first = sp.chunks === 0 && sp.spokenUpTo === 0 && !sp.carry;
      // 最初の一言はとにかく早く: 文が終わっていなくても、読点までで十分な長さがあれば話し始める
      if (first) {
        const comma = text.search(/[、,]/);
        const end = text.search(/[。！？!?\n]/);
        if (comma >= 12 && (end < 0 || comma < end)) {
          enqueue(text.slice(0, comma + 1));
          sp.spokenUpTo = comma + 1;
        }
      }
      const { sentences, next } = takeSentences(text, sp.spokenUpTo);
      sp.spokenUpTo = next;
      for (const sentence of sentences) {
        const chunk = sp.carry + sentence;
        // 短い文は次の文とまとめる。ただし最初の一言は待たせない
        if (chunk.length < MIN_CHUNK && sp.chunks > 0) sp.carry = chunk;
        else {
          sp.carry = "";
          enqueue(chunk);
        }
      }
      if (done) {
        const rest = sp.carry + text.slice(sp.spokenUpTo);
        sp.carry = "";
        if (rest.trim()) enqueue(rest);
        sp.spokenUpTo = text.length;
        sp.finished = true;
        sp.armedAt = 0;
      }
      if (!sp.speaking) void speakNext();
      else ensureFetch(sp.queue[0]);
    },
    [enqueue, ensureFetch, speakNext],
  );

  const cancelSpeech = useCallback(() => {
    const sp = speech.current;
    sp.gen++;
    clearTimeout(sp.guard);
    sp.queue = [];
    sp.carry = "";
    sp.finished = true;
    sp.speaking = false;
    sp.armedAt = 0;
    sp.controllers.forEach((c) => c.abort());
    sp.controllers.clear();
    sp.stopAudio?.();
    try {
      window.speechSynthesis?.cancel();
    } catch {
      /* noop */
    }
  }, []);

  /* ---------- 操作 ---------- */

  const enable = useCallback(() => {
    if (!recRef.current) {
      setError("このブラウザは音声認識に対応していません。PC の Chrome か Edge で開いてください。");
      return;
    }
    setError(null);
    unlockAudio();
    try {
      localStorage.setItem(STORAGE_KEY, "on");
    } catch {
      /* noop */
    }
    toStandby();
  }, [toStandby]);

  const disable = useCallback(() => {
    clearTimeout(followTimer.current);
    cancelSpeech();
    set("off");
    stopRec();
    setInterim("");
    try {
      localStorage.setItem(STORAGE_KEY, "off");
    } catch {
      /* noop */
    }
  }, [cancelSpeech, set, stopRec]);

  const toggle = useCallback(() => (stateRef.current === "off" ? enable() : disable()), [enable, disable]);

  /** マイクボタン: 呼びかけなしで、すぐ 1 回聞き取る */
  const talkNow = useCallback(() => {
    if (!recRef.current) {
      setError("このブラウザは音声認識に対応していません。PC の Chrome か Edge で開いてください。");
      return;
    }
    setError(null);
    unlockAudio();
    cancelSpeech();
    chime("wake");
    listenFor(FOLLOW_UP_MS);
  }, [cancelSpeech, listenFor]);

  /** 応答がエラー等で終わり、読み上げるものがないとき */
  const replyFinished = useCallback(() => {
    const sp = speech.current;
    sp.finished = true;
    sp.armedAt = 0;
    afterSpeech();
  }, [afterSpeech]);

  // 前回 VOICE MODE をオンにしていたら、最初のクリック/キー操作で自動的に再開する
  // （ブラウザはユーザー操作なしでのマイク・音声の開始を制限するため）
  useEffect(() => {
    let wanted = false;
    try {
      wanted = localStorage.getItem(STORAGE_KEY) === "on";
    } catch {
      /* noop */
    }
    if (!wanted || !getRecognitionCtor()) return;
    const resume = (e: Event) => {
      // 音声ボタン自体の操作はそのボタンの処理に任せる（二重に切り替わらないように）
      if ((e.target as Element | null)?.closest?.("[data-voice-control]")) return;
      if (stateRef.current === "off") enable();
    };
    window.addEventListener("pointerdown", resume, { once: true });
    window.addEventListener("keydown", resume, { once: true });
    return () => {
      window.removeEventListener("pointerdown", resume);
      window.removeEventListener("keydown", resume);
    };
  }, [enable]);

  useEffect(
    () => () => {
      clearTimeout(followTimer.current);
      clearTimeout(restartTimer.current);
      clearTimeout(speech.current.guard);
    },
    [],
  );

  return { state, interim, error, supported, toggle, talkNow, speak, cancelSpeech, replyFinished, dismissError: () => setError(null) };
}
