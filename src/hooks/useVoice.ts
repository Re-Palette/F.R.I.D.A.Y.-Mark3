"use client";

/**
 * 音声会話。「フライデー」と呼ぶと起動し、話した内容を送り、返答を読み上げる。
 *
 *   off ──(VOICE MODE ON)──▶ standby ──「フライデー」──▶ listening ──発言──▶ thinking
 *                              ▲                             ▲                   │
 *                              └──── 8 秒沈黙 ────────────────┴──── 読み上げ終了 ◀─ speaking
 *
 * - 「フライデー」とだけ呼ばれたら「ピコン」と鳴らして次の一言を聞く。
 * - 「フライデー、〇〇」と続けて言えば、そのまま〇〇を送る。
 * - 返答の読み上げ中はマイクを止める（自分の声を拾わないため）。
 * - 読み上げ後 8 秒間は呼びかけなしで続けて話せる。
 * - 拍手 2 回でも起動できる（boot。起動の音と一言のあと、呼びかけなしで聞く）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  chime,
  echoScore,
  getAudioContext,
  normalizeForEcho,
  getRecognitionCtor,
  pickJapaneseVoice,
  splitWake,
  stripWake,
  takeSentences,
  toSpeakable,
  unlockAudio,
  shouldRecognizeLocally,
  voiceOffline,
  type RecognitionLike,
} from "@/lib/speech";
import { withReadings } from "@/lib/reading";
import { canRecord, RecordedRecognition } from "@/lib/recorded-recognition";
import { detectTone } from "@/lib/tone";
import { trackSpeech, voiceLevel } from "@/lib/voice-level";

export type VoiceState = "off" | "standby" | "listening" | "thinking" | "speaking";

const FOLLOW_UP_MS = 8000;
/** 拍手 2 回で起動したときの一言 */
const BOOT_LINE = "全システム、起動しました。";
/** 聞き取り途中の文字がこの時間変わらなければ「話し終わった」とみなす（ブラウザの確定待ちより速い） */
const END_OF_SPEECH_MS = 800;
/** ブラウザが 1 区切りを確定したあと、続きを話し始めるのを待つ時間（息継ぎで途中送信しないため） */
const AFTER_FINAL_MS = 450;
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
  /** 直前に読んだ文（声の抑揚を前の文から自然につなげるため ElevenLabs に渡す） */
  prev?: string;
}

/** これより短い文は次の文とまとめて声にする（リクエスト数削減・抑揚も自然に） */
const MIN_CHUNK = 12;
/**
 * まだ声にし始めていない次のかたまりには、届いた文をこの長さまで足していく。
 * 一文ずつ別々に声にすると、文と文の間に毎回すき間ができ、抑揚も途切れてぶつ切りに聞こえるため。
 */
const MAX_CHUNK = 140;
/** 今の声の残りがこの秒数になったら、次のかたまりの声を作り始める（それまでは文を足し続ける） */
const PREFETCH_LEAD_S = 1.4;

/** 聞こえた言葉がこれ以上「読み上げ中の文章」と一致していたら自分の声とみなす */
const ECHO_THRESHOLD = 0.4;
/** 読み上げ終了直後も、この間は自分の声の残響を無視する */
const ECHO_TAIL_MS = 4000;
/**
 * 読み上げ後しばらくは、聞こえた言葉が「さっき自分が話した文章」とほぼ同じなら自分の声とみなす。
 * （ブラウザの聞き取り結果は数秒遅れて届くことがあるため）
 */
const ECHO_WINDOW_MS = 45_000;
/** 話している最中は、これくらい似ていれば自分の声とみなす（誤って割り込まないよう厳しめ） */
const ECHO_THRESHOLD_SPEAKING = 0.3;
/** 読み終えてしばらく後は、ほぼ同じ文章のときだけ自分の声とみなす（ユーザーの返事を消さないため） */
const ECHO_THRESHOLD_LATE = 0.75;
/** 自分の声でも必ず割り込みとして扱う言葉 */
const STOP_WORDS = /ストップ|止めて|とめて|待って|まって|フライデー|ふらいでー|friday/i;

export function useVoice({
  onCommand,
  onBargeIn,
  cloudVoice = false,
  speed = 0.95,
  bargeIn = true,
  wakeWord = true,
  recorded = false,
  onAudio,
  onWoke,
  verifyVoice,
}: {
  onCommand: (text: string) => void;
  /** 返答の途中でユーザーが話し始めた（返答の生成を止める） */
  onBargeIn?: () => void;
  /** ElevenLabs の声を使う（サーバー側で設定済みのとき） */
  cloudVoice?: boolean;
  /** 読み上げの速さ（SETTINGS。ElevenLabs 基準の 0.7〜1.2。ブラウザの声は換算する） */
  speed?: number;
  /** 話している間も聞く（割り込み）。false なら話している間はマイクを止める（スピーカーで自分の声を拾う環境向け） */
  bargeIn?: boolean;
  /** 「フライデー」の呼びかけを待つか。false（スマホ）なら待機中はマイクを止め、コアのタップで話しかける */
  wakeWord?: boolean;
  /** ブラウザの音声認識の代わりに、録った音声をサーバーで文字にする（スマホ。ブラウザの認識が声を拾わないことがあるため） */
  recorded?: boolean;
  /** 「フライデー」と呼ばれたとき（タブが裏にあれば前に出すため。前に出し終わるまでの Promise を返してよい） */
  onWoke?: () => void | Promise<unknown>;
  /** 録った声をそのまま会話に送る（recorded のとき。会話のサーバーが文字にするので往復が 1 回で済む） */
  onAudio?: (audio: { mimeType: string; data: string }) => void;
  /**
   * 声紋認証（陽大の声か確かめる）。指定すると、呼びかけ・発言・割り込みの前に確かめ、違えば無視する。
   * utterance は録音で聞いたときの 1 発言（16kHz）。null なら直近のマイクの声で確かめる（パソコン）。
   */
  verifyVoice?: (utterance: Float32Array | null) => Promise<boolean>;
}) {
  const wakeWordOn = useRef(wakeWord);
  /** 開いた時点で自分から聞き始めたところ（ブラウザに止められたら、黙って最初の操作を待つ） */
  const autoStarting = useRef(false);
  wakeWordOn.current = wakeWord;
  const bargeInOn = useRef(bargeIn);
  bargeInOn.current = bargeIn;
  const speedRef = useRef(speed);
  speedRef.current = speed;
  const [state, setState] = useState<VoiceState>("off");
  /**
   * 音声モードを使いたいか（あなたがオンにしたか）。聞き取りがエラーで止まっても（オフラインなど）オンのまま。
   * 拍手 2 回の起動は、これがオンの間マイクを開いて聞き続ける（聞き取りが動いていなくても拍手で起動できるように）
   */
  const [wanted, setWanted] = useState(false);
  useEffect(() => {
    try {
      setWanted(localStorage.getItem(STORAGE_KEY) === "on");
    } catch {
      /* noop */
    }
  }, []);
  /** 直近に「ネットに届かない」で聞き取りが止まった時刻（すぐ再開を繰り返さないように） */
  const netErrorAt = useRef(0);
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [supported, setSupported] = useState(true);

  const stateRef = useRef<VoiceState>("off");
  const recRef = useRef<RecognitionLike | null>(null);
  const runningRef = useRef(false);
  /** 停止を要求して終了通知（onend）待ちの間は true。この間に再開すると状態が食い違うので待つ */
  const abortingRef = useRef(false);
  /** 聞き取りの結果が最後に届いた時刻（止まっていないかの見張り用） */
  const lastResultAt = useRef(0);
  const followTimer = useRef(0);
  /** 確定前の聞き取り途中テキスト（確定の合図が来ないブラウザでは、区切りでこれを使う） */
  const pendingRef = useRef("");
  /** 確定済みで、続きを待っている発言（息継ぎをはさんだ長い発言を 1 つにまとめる） */
  const heldRef = useRef("");
  const silenceTimer = useRef(0);
  const restartTimer = useRef(0);
  const onCommandRef = useRef(onCommand);
  onCommandRef.current = onCommand;
  const onAudioRef = useRef(onAudio);
  onAudioRef.current = onAudio;
  const onWokeRef = useRef(onWoke);
  onWokeRef.current = onWoke;
  const onBargeInRef = useRef(onBargeIn);
  onBargeInRef.current = onBargeIn;
  const verifyRef = useRef(verifyVoice);
  verifyRef.current = verifyVoice;
  /** 最後に本人の声と確かめた時刻（呼びかけに続けて話した内容を、二重に確かめないため） */
  const verifiedAt = useRef(0);
  const rejectTimer = useRef(0);
  /** 割り込み処理（読み上げの停止など。下で定義する関数を後から入れる） */
  const bargeInRef = useRef<() => void>(() => {});
  /** 「フライデー」とだけ呼ばれたときの一言（下で定義する関数を後から入れる） */
  const acknowledgeRef = useRef<() => void>(() => {});
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
    audible: "", // いまスピーカーから出ている（前後を含む）文章。自分の声の聞き取りを見分けるのに使う
    lastSpokeAt: 0,
    log: [] as { text: string; at: number }[], // 最近読み上げた文章（自分の声の聞き取りを見分けるのに使う）
  });

  /** 聞こえた言葉が、F.R.I.D.A.Y. 自身の声をマイクが拾ったものか */
  const looksLikeEcho = useCallback((heard: string, talking: boolean): boolean => {
    const sp = speech.current;
    const now = Date.now();
    sp.log = sp.log.filter((x) => now - x.at < ECHO_WINDOW_MS);
    const spoken = `${sp.log.map((x) => x.text).join(" ")} ${sp.audible}`;
    if (!spoken.trim()) return false;
    // 「ストップ」「待って」などは、自分がその言葉を話していない限り割り込みとして通す
    const said = normalizeForEcho(spoken);
    for (const m of heard.matchAll(new RegExp(STOP_WORDS.source, "gi"))) {
      if (!said.includes(normalizeForEcho(m[0]))) return false;
    }
    const since = now - sp.lastSpokeAt;
    const score = echoScore(heard, spoken);
    if (talking) return score >= ECHO_THRESHOLD_SPEAKING;
    if (since < ECHO_TAIL_MS) return score >= ECHO_THRESHOLD;
    return since < ECHO_WINDOW_MS && normalizeForEcho(heard).length >= 6 && score >= ECHO_THRESHOLD_LATE;
  }, []);

  const set = useCallback((s: VoiceState) => {
    stateRef.current = s;
    setState(s);
  }, []);

  /** 本人の声か（声紋認証を使っていなければ常に true）。違えば少しの間そう表示する */
  const isOwner = useCallback(async (utterance: Float32Array | null = null): Promise<boolean> => {
    const verify = verifyRef.current;
    if (!verify) return true;
    if (!utterance && Date.now() - verifiedAt.current < 2500) return true;
    const ok = await verify(utterance).catch(() => true);
    if (ok) verifiedAt.current = Date.now();
    else {
      setInterim("登録した声ではないので反応しません");
      clearTimeout(rejectTimer.current);
      rejectTimer.current = window.setTimeout(() => setInterim((t) => (t.startsWith("登録した声") ? "" : t)), 2500);
    }
    return ok;
  }, []);

  /* ---------- マイク ---------- */

  const startRec = useCallback(() => {
    const rec = recRef.current;
    // 停止処理の途中なら、終了通知（onend）のあとで自動的に再開される
    if (!rec || runningRef.current || abortingRef.current) return;
    // ネットが切れているときは、対応している Chrome なら PC の中だけで聞き取る（日本語の音声データが入っている場合）
    if ("processLocally" in rec) (rec as { processLocally?: boolean }).processLocally = shouldRecognizeLocally();
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
    heldRef.current = "";
    const rec = recRef.current;
    if (!rec || !runningRef.current) return;
    abortingRef.current = true;
    try {
      rec.abort();
    } catch {
      abortingRef.current = false;
    }
    runningRef.current = false;
  }, []);

  const toStandby = useCallback(() => {
    clearTimeout(followTimer.current);
    setInterim("");
    set("standby");
    // 呼びかけを使わないときは、待機中にマイクを使わない
    if (wakeWordOn.current) startRec();
    else stopRec();
  }, [set, startRec, stopRec]);

  // 画面の幅が変わって呼びかけの有無が切り替わったら、待機中のマイクも合わせる
  useEffect(() => {
    if (stateRef.current === "standby") toStandby();
  }, [wakeWord, toStandby]);

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

  /** 話している間は、聞き取りの受付時間を延ばす（話の途中で待機に戻らないように） */
  const keepListening = useCallback(() => {
    clearTimeout(followTimer.current);
    followTimer.current = window.setTimeout(() => {
      if (stateRef.current === "listening" && !heldRef.current && !pendingRef.current) toStandby();
    }, FOLLOW_UP_MS);
  }, [toStandby]);

  const dispatch = useCallback(
    async (text: string) => {
      const command = stripWake(text);
      if (!command) return;
      if (verifyRef.current) {
        const before = stateRef.current;
        if (!(await isOwner())) return;
        if (stateRef.current !== before) return; // 確かめている間に止めた・別の操作をした
      }
      clearTimeout(followTimer.current);
      setInterim("");
      stopRec(); // この発言の認識は打ち切る（考え中も割り込みに備えて自動で聞き直す）
      speech.current.armedAt = Date.now();
      set("thinking");
      onCommandRef.current(command);
    },
    [isOwner, set, stopRec],
  );

  /* 音声認識の初期化 */
  useEffect(() => {
    const Ctor = recorded && canRecord() ? RecordedRecognition : getRecognitionCtor();
    if (!Ctor) {
      setSupported(false);
      return;
    }
    setSupported(true);
    const rec = new Ctor();
    // 録音で聞くときは、声が聞こえている間は受付時間を延ばす（途中のテキストが出ないため）
    if (rec instanceof RecordedRecognition) {
      // 声紋認証：録った 1 発言で確かめてから、文字にしたり会話に送ったりする
      rec.verify = (samples) => (verifyRef.current ? isOwner(samples) : Promise.resolve(true));
      // 録った声は文字にせずそのまま会話に送る（送る先があるとき）
      if (onAudioRef.current) {
        rec.onaudio = (audio) => {
          if (stateRef.current !== "listening" || !onAudioRef.current) return;
          clearTimeout(followTimer.current);
          setInterim("");
          stopRec();
          speech.current.armedAt = Date.now();
          set("thinking");
          onAudioRef.current(audio);
        };
      }
      rec.onspeechstart = () => {
        if (stateRef.current !== "listening") return;
        keepListening();
        setInterim("聞いています…");
      };
    }
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
        if (verifyRef.current && !(rec instanceof RecordedRecognition)) {
          void isOwner().then((ok) => {
            if (ok && stateRef.current === "standby") woken(command);
          });
          return;
        }
        woken(command);
      } else if (mode === "listening") {
        // 送る直前にもう一度確かめる（遅れて届いた自分の声の聞き取りを送らない）
        if (looksLikeEcho(text, speech.current.speaking)) {
          if (heldRef.current) hold("");
          else setInterim("");
          return;
        }
        // 録音の聞き取りは 1 発言をまとめて文字にしてくるので、続きを待たずにすぐ送る
        hold(text, rec instanceof RecordedRecognition ? 0 : AFTER_FINAL_MS);
      }
    };

    /** 呼びかけられた（本人の声と確かめたあと） */
    const woken = (command: string) => {
        onWokeRef.current?.();
        if (command.length >= 2) {
          set("listening"); // 呼びかけに続けて話した内容。続きがあるかもしれないので少し待つ
          keepListening();
          hold(command);
        } else {
          setInterim("");
          acknowledgeRef.current();
        }
    };

    /** 確定した区切りを溜め、続きが無ければまとめて送る */
    const hold = (text: string, waitMs = AFTER_FINAL_MS) => {
      heldRef.current += text;
      clearTimeout(silenceTimer.current);
      if (!heldRef.current.trim()) return;
      setInterim(heldRef.current.trim());
      silenceTimer.current = window.setTimeout(() => {
        const all = heldRef.current;
        heldRef.current = "";
        if (all.trim() && !looksLikeEcho(all, speech.current.speaking)) dispatch(all);
        else setInterim("");
      }, waitMs);
    };

    rec.onresult = (e) => {
      lastResultAt.current = Date.now();
      let finalText = "";
      let interimText = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript;
        else interimText += r[0].transcript;
      }
      let mode = stateRef.current;
      clearTimeout(silenceTimer.current);
      const heard = finalText || interimText;
      const sp = speech.current;
      const isEcho = () => looksLikeEcho(heard, mode === "speaking" || sp.speaking);

      // F.R.I.D.A.Y. が話している / 考えている最中にユーザーが話し始めたら割り込む
      if (mode === "speaking" || mode === "thinking") {
        const len = normalizeForEcho(heard).length;
        const stopWord = STOP_WORDS.test(heard);
        // 話している最中は、止める言葉以外は長めの発言だけを割り込みとみなす（自分の声の切れ端を拾わない）
        const minLen = mode === "speaking" ? (finalText ? 6 : 8) : finalText ? 3 : 4;
        if (isEcho() || (!stopWord && len < minLen)) {
          pendingRef.current = ""; // 自分の声・物音は無視
          return;
        }
        if (verifyRef.current && !(rec instanceof RecordedRecognition)) {
          // 本人の声と確かめてから割り込む（テレビやほかの人の声では止めない）
          const was = mode;
          pendingRef.current = "";
          void isOwner().then((ok) => {
            if (!ok || stateRef.current !== was) return;
            bargeInRef.current();
            if (finalText.trim()) handleUtterance(finalText);
            else setInterim(interimText.trim());
          });
          return;
        }
        bargeInRef.current();
        mode = "listening";
      } else if (mode === "listening" && isEcho()) {
        pendingRef.current = ""; // 読み終えた直後の残響
        if (heldRef.current) hold("");
        return;
      }
      if (mode === "listening" && heard.trim()) keepListening();

      if (finalText.trim()) {
        pendingRef.current = "";
        handleUtterance(finalText);
        return;
      }
      if (!interimText.trim() && heldRef.current) {
        hold(""); // 物音だけだった → まとめ待ちを続ける
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
          // もう十分黙っていたので、溜めた分と合わせてすぐ送る
          const waiting = stateRef.current === "listening" ? heldRef.current : "";
          if (waiting) hold(text, 0);
          else {
            handleUtterance(text);
            if (heldRef.current) hold("", 0);
          }
        }, END_OF_SPEECH_MS);
      }
      if (mode === "listening") setInterim(`${heldRef.current}${interimText}`.trim());
      else if (mode === "standby") setInterim(splitWake(interimText).woke ? "…" : `聞こえた：${interimText.trim()}`);
    };

    rec.onerror = (e) => {
      if (e.error === "not-allowed" || (e.error === "service-not-allowed" && !voiceOffline())) {
        // 開いた時点で自分から始めたのを止められただけなら、黙って最初の操作を待つ
        if (!autoStarting.current) setError("マイクの使用が許可されていません。アドレスバーのマイクのアイコンから許可してください。");
        autoStarting.current = false;
        runningRef.current = false;
        set("off");
      } else if (e.error === "network" || e.error === "language-not-supported" || (e.error === "service-not-allowed" && voiceOffline())) {
        // オフラインで聞き取りが使えない：音声モードはオンのまま（拍手 2 回での起動・読み上げは使える）。少し間を空けて試し直す
        netErrorAt.current = Date.now();
        setError(
          voiceOffline()
            ? "オフラインでは声の聞き取りが使えません。オンラインのときに SETTINGS → VOICE の「オフラインの聞き取り」を入れてください（今は文字で入力できます）。"
            : "音声認識サービスに接続できません。ネットワークを確認してください。",
        );
      } else if (e.error === "audio-capture") {
        setError("マイクが見つかりません。");
      }
      // no-speech / aborted などは onend で再開するので無視
    };

    rec.onend = () => {
      runningRef.current = false;
      const wasAborting = abortingRef.current; // こちらから止めた直後か（エラー等ではない）
      abortingRef.current = false;
      // 確定の合図が来ないまま区切られたら、最後に聞こえた内容で判定する
      const leftover = pendingRef.current;
      pendingRef.current = "";
      if (leftover.trim()) handleUtterance(leftover);
      const s = stateRef.current;
      // 待機・聞き取り中に途切れたら自動で再開（ブラウザは一定時間で認識を止めるため）
      const listenWhileTalking = bargeInOn.current;
      if ((s === "standby" && wakeWordOn.current) || s === "listening" || (listenWhileTalking && (s === "speaking" || s === "thinking"))) {
        clearTimeout(restartTimer.current);
        // 自分で止めた直後はすぐ再開（話し始めの言葉を取りこぼさない）。それ以外は少し待つ
        // オフラインで聞き取りが使えないときは 3 秒ごとに試し直す（すぐ繰り返すとマイクを何度も開け閉めして重い）
        const netDown = Date.now() - netErrorAt.current < 2000;
        restartTimer.current = window.setTimeout(startRec, netDown ? 3000 : wasAborting ? 0 : 200);
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
      abortingRef.current = false;
    };
  }, [dispatch, isOwner, keepListening, listenFor, looksLikeEcho, recorded, set, startRec]);

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
    // 読み上げ中の認識には自分の声の残響が混ざるので、いったん打ち切って聞き直す
    if (stateRef.current === "speaking") stopRec();
    if (bargeInOn.current) listenFor(FOLLOW_UP_MS);
    else {
      // 割り込みオフ: スピーカーの残響が消えてから聞き始める
      clearTimeout(followTimer.current);
      followTimer.current = window.setTimeout(() => {
        if (stateRef.current !== "off" && !speech.current.speaking) listenFor(FOLLOW_UP_MS);
      }, 700);
    }
  }, [listenFor, stopRec]);

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
    el.src = `/api/tts?text=${encodeURIComponent(item.text)}${item.prev ? `&prev=${encodeURIComponent(item.prev.slice(-200))}` : ""}`;
    el.dataset.chars = String(item.text.length);
    item.audio = el;
  }, []);

  /** ElevenLabs の音声を再生。再生できなければ false（→ ブラウザの声で代わりに読む） */
  const playCloud = useCallback(
    (el: HTMLAudioElement, gen: number, nearEnd?: () => void): Promise<boolean> =>
      new Promise<boolean>((resolve) => {
        if (gen !== speech.current.gen) return resolve(true);
        let done = false;
        let started = false;
        const finish = (ok: boolean) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          speech.current.stopAudio = null;
          el.onended = el.onerror = el.onplaying = el.ontimeupdate = null;
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
        // 残りが少なくなったら次のかたまりの声を作り始める（届きながら再生する音声は長さが分からないことがあるので、文字数から見積もる）
        const estimate = Math.max(1, (el.dataset.chars ? Number(el.dataset.chars) : 20) / (7.5 * speedRef.current));
        let lead = false;
        el.ontimeupdate = () => {
          if (lead) return;
          const total = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : estimate;
          if (total - el.currentTime <= PREFETCH_LEAD_S) {
            lead = true;
            nearEnd?.();
          }
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
      const u = new SpeechSynthesisUtterance(withReadings(text));
      u.lang = "ja-JP";
      // オフラインに切り替わっていたら、PC の中の声を選び直す
      const voice = sp.voice && (sp.voice.localService || navigator.onLine) ? sp.voice : pickJapaneseVoice(window.speechSynthesis.getVoices());
      if (voice) u.voice = voice;
      // ElevenLabs の 1.15 ≒ ブラウザの 1.25 として換算
      // 落ち着いた低めの声。文の雰囲気で、ほんの少しだけ変える（心配：ゆっくり・低め／前進：少し明るく）
      const tone = detectTone(text);
      u.rate = Math.min(1.8, Math.max(0.8, (speedRef.current / 1.15) * 1.25 * (tone === "concern" ? 0.95 : tone === "warm" ? 1.02 : 1)));
      u.pitch = tone === "warm" ? 0.92 : tone === "curious" ? 0.9 : tone === "concern" ? 0.82 : 0.85;
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
      // 次のかたまりは、今の声の残りが少なくなってから作り始める（それまでに届いた文を足して、まとめて自然に話す）
      sp.audible = [sp.audible.slice(-60), item.text, sp.queue[0]?.text ?? ""].join(" ");
      sp.log.push({ text: item.text, at: Date.now() });
      if (stateRef.current !== "off") {
        set("speaking");
        // 話している間も聞き続ける（割り込みのため）。割り込みオフならマイクを止める
        if (bargeInOn.current) startRec();
        else stopRec();
      }
      let played = false;
      // 声の大きさに合わせて HOME のコアを動かす（ElevenLabs の声は実際の大きさ、ブラウザの声は話し声らしい揺れ）
      let release = item.audio ? trackSpeech(item.audio) : null;
      if (item.audio) played = await playCloud(item.audio, gen, () => ensureFetch(sp.queue[0]));
      release?.();
      if (gen !== sp.gen) return;
      if (!played) {
        release = trackSpeech(null);
        await playBrowser(item.text);
        release();
      }
      sp.lastSpokeAt = Date.now();
      const last = sp.log[sp.log.length - 1];
      if (last) last.at = sp.lastSpokeAt; // 読み終えた時刻から数える
    }
    if (gen !== sp.gen) return;
    sp.speaking = false;
    afterSpeech();
  }, [afterSpeech, ensureFetch, playBrowser, playCloud, set, stopRec]);

  const enqueue = useCallback((raw: string) => {
    const sp = speech.current;
    const text = toSpeakable(raw);
    if (!text) return;
    const last = sp.queue[sp.queue.length - 1];
    // まだ声を作り始めていないかたまりがあれば、そこに足す（つながった文として話す）
    if (last && !last.audio && last.text.length + text.length <= MAX_CHUNK) {
      // 区切りの記号が無い（箇条書きの行など）ときは、句点を補って間を空ける
      last.text = /[。！？!?、,.]$/.test(last.text) ? `${last.text}${text}` : `${last.text}。${text}`;
      return;
    }
    // 同じ返答の中の直前の文（返答の最初の文には付けない）
    const prev = last?.text ?? (sp.chunks > 0 ? sp.log[sp.log.length - 1]?.text : undefined);
    sp.queue.push({ text, prev });
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
      // 最初の一言も、文の終わりまで待ってから話す（読点で切ると、文の途中で不自然に詰まって聞こえるため）
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
    },
    [enqueue, ensureFetch, speakNext],
  );

  /**
   * 返答の文がまだ届かないうちに、先に一言だけ話す（調べものなどで待たせるとき、黙り込まないように）。
   * その返答をまだ何も話していないときだけ。
   */
  const interject = useCallback(
    ({ id, createdAt, text }: { id: string; createdAt: number; text: string }) => {
      const sp = speech.current;
      if (!sp.armedAt || createdAt < sp.armedAt - 100) return;
      if (sp.id !== id) {
        sp.id = id;
        sp.spokenUpTo = 0;
        sp.queue = [];
        sp.carry = "";
        sp.chunks = 0;
        sp.finished = false;
      }
      if (sp.chunks > 0 || sp.finished || sp.speaking) return;
      sp.queue.push({ text });
      sp.chunks++;
      void speakNext();
    },
    [speakNext],
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

  /** 割り込み: 読み上げを止め、返答の生成も止めて、ユーザーの話を聞く */
  bargeInRef.current = () => {
    cancelSpeech();
    onBargeInRef.current?.();
    listenFor(FOLLOW_UP_MS);
  };

  /** 「フライデー」とだけ呼ばれたとき：「ピコン」と鳴らして聞く（一言の返事はしない） */
  acknowledgeRef.current = () => {
    cancelSpeech();
    chime("wake");
    listenFor(FOLLOW_UP_MS);
  };

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
    setWanted(true);
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
    setWanted(false);
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

  /**
   * 呼びかけと同じ（スマホで中央のコアをタップしたとき）。
   * VOICE MODE がオフならオンにして聞く（呼びかけを使う画面では「ピコン」と鳴らしてから）。読み上げ中なら止めて聞く。
   */
  const wake = useCallback(() => {
    if (!recRef.current) {
      setError("このブラウザは音声認識に対応していません。Chrome か Safari で開いてください。");
      return;
    }
    setError(null);
    unlockAudio();
    if (stateRef.current === "off") enable();
    const s = stateRef.current;
    if (s === "speaking") bargeInRef.current();
    // スマホ（呼びかけなし）は一言返さず、タップしたその場で聞き始める
    // （iPhone などは、タップの操作の中で聞き取りを始めないと音声を拾わないことがあるため）
    else if (s === "standby") wakeWordOn.current ? acknowledgeRef.current() : listenFor(FOLLOW_UP_MS);
    // 聞き取り中のタップ：止まっていたらタップの操作の中で聞き取りを始め直す（受付時間も延ばす）
    else if (s === "listening" && !wakeWordOn.current) listenFor(FOLLOW_UP_MS);
  }, [enable, listenFor]);

  /**
   * 拍手 2 回：全システム起動。音声モードがオフならオンにし、読み上げ中なら止めて、
   * 起動の音と「全システム、起動しました。」のあと、呼びかけなしで次の一言を聞く。
   */
  const boot = useCallback(() => {
    if (!recRef.current) return;
    // まず最初にタブを前に出す（拍手とほぼ同時に画面が出るように。声はそのあと）
    const front = Promise.resolve(onWokeRef.current?.()).catch(() => {});
    setError(null);
    unlockAudio();
    if (stateRef.current === "off") enable();
    cancelSpeech();
    chime("boot");
    const sp = speech.current;
    sp.id = `boot-${Date.now()}`;
    sp.spokenUpTo = 0;
    sp.carry = "";
    sp.chunks = 1;
    sp.finished = true; // 読み終えたら afterSpeech が聞き取りに移る
    sp.armedAt = 0;
    sp.queue = [{ text: BOOT_LINE }];
    const gen = sp.gen;
    // 起動の音が鳴り終わり、タブが前に出てから話す（前に出すのが遅くても 1.2 秒で話し始める）
    const chimeDone = new Promise((r) => window.setTimeout(r, 450));
    const capped = Promise.race([front, new Promise((r) => window.setTimeout(r, 1200))]);
    void Promise.all([chimeDone, capped]).then(() => {
      if (speech.current.gen === gen && stateRef.current !== "off") void speakNext();
    });
  }, [cancelSpeech, enable, speakNext]);

  /** 応答がエラー等で終わり、読み上げるものがないとき */
  const replyFinished = useCallback(() => {
    const sp = speech.current;
    sp.finished = true;
    sp.armedAt = 0;
    afterSpeech();
  }, [afterSpeech]);

  /**
   * 聞き取りの見張り。Chrome の音声認識は、マイクの音は届いているのに結果を返さなくなることがある。
   * マイクに声が入っている（音量が上がっている）のに、しばらく結果が 1 つも届かなければ、聞き取りをやり直す。
   */
  useEffect(() => {
    let loud = 0;
    let lastRestart = 0;
    const t = window.setInterval(() => {
      const s = stateRef.current;
      if ((s !== "listening" && s !== "standby") || !runningRef.current || !voiceLevel.live || voiceLevel.talking) {
        loud = 0;
        return;
      }
      loud = voiceLevel.value > 0.35 ? loud + 1 : Math.max(0, loud - 0.5);
      const now = Date.now();
      // 声らしい音が合わせて 3 秒以上あったのに、8 秒間 結果が無い
      if (loud >= 6 && now - lastResultAt.current > 8000 && now - lastRestart > 15000) {
        lastRestart = now;
        loud = 0;
        lastResultAt.current = now;
        setInterim("聞き取りが止まっていたので、やり直しました。もう一度話してください。");
        window.setTimeout(() => setInterim((v) => (v.startsWith("聞き取りが止まって") ? "" : v)), 4000);
        const rec = recRef.current;
        if (rec) {
          abortingRef.current = true;
          try {
            rec.abort(); // 終わったら onend が自動でやり直す
          } catch {
            abortingRef.current = false;
          }
        }
      }
    }, 500);
    return () => window.clearInterval(t);
  }, []);

  // 前回 VOICE MODE をオンにしていたら再開する。
  // パソコン（呼びかけで起動する画面）は、開いた時点で聞き始める（裏で開いておいたタブでも「フライデー」と呼べるように）。
  // ブラウザに止められたら、最初のクリック/キー操作で再開する。声を出す許可は、最初の操作のときに取る
  useEffect(() => {
    let wanted = false;
    try {
      wanted = localStorage.getItem(STORAGE_KEY) === "on";
    } catch {
      /* noop */
    }
    const unlock = () => unlockAudio();
    window.addEventListener("pointerdown", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });
    if (!wanted || !getRecognitionCtor()) {
      return () => {
        window.removeEventListener("pointerdown", unlock);
        window.removeEventListener("keydown", unlock);
      };
    }
    // スマホかどうかが分かってから（最初の描画の直後）。スマホは呼びかけを使わないので自分からは始めない
    const auto = window.setTimeout(() => {
      if (!wakeWordOn.current || stateRef.current !== "off" || !recRef.current) return;
      autoStarting.current = true;
      setError(null);
      toStandby();
      window.setTimeout(() => (autoStarting.current = false), 10_000);
    }, 150);
    const resume = (e: Event) => {
      // 音声ボタン自体の操作はそのボタンの処理に任せる（二重に切り替わらないように）
      if ((e.target as Element | null)?.closest?.("[data-voice-control]")) return;
      if (stateRef.current === "off") enable();
    };
    window.addEventListener("pointerdown", resume, { once: true });
    window.addEventListener("keydown", resume, { once: true });
    return () => {
      clearTimeout(auto);
      window.removeEventListener("pointerdown", resume);
      window.removeEventListener("keydown", resume);
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, [enable, toStandby]);

  useEffect(
    () => () => {
      clearTimeout(followTimer.current);
      clearTimeout(restartTimer.current);
      clearTimeout(speech.current.guard);
      clearTimeout(rejectTimer.current);
    },
    [],
  );

  /** ほかの場所で読み上げた文章（リマインダーなど）も、自分の声として覚えておく */
  const noteSpoken = useCallback((text: string) => {
    const sp = speech.current;
    sp.log.push({ text, at: Date.now() + 8000 }); // 読み上げが終わるまでの分を見込む
    sp.lastSpokeAt = Date.now() + 4000;
  }, []);

  return {
    state,
    wanted,
    interim,
    error,
    supported,
    toggle,
    talkNow,
    wake,
    boot,
    speak,
    interject,
    cancelSpeech,
    replyFinished,
    noteSpoken,
    dismissError: () => setError(null),
  };
}
