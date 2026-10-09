/**
 * 音声会話の小道具（ブラウザ標準の Web Speech API を使う。追加ライブラリなし）。
 *  - 音声認識: SpeechRecognition（Chrome / Edge / Safari）
 *  - 読み上げ: speechSynthesis
 */

import { detectModeCommand, getAiMode } from "./ai-mode";

/* ---------- 音声認識 ---------- */

interface RecognitionAlternative {
  transcript: string;
}
interface RecognitionResult {
  readonly isFinal: boolean;
  readonly length: number;
  [index: number]: RecognitionAlternative;
}
export interface RecognitionResultEvent {
  readonly resultIndex: number;
  readonly results: { readonly length: number; [index: number]: RecognitionResult };
}
export interface RecognitionErrorEvent {
  readonly error: string;
}
export interface RecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: RecognitionResultEvent) => void) | null;
  onerror: ((e: RecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
}

export function getRecognitionCtor(): (new () => RecognitionLike) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: new () => RecognitionLike;
    webkitSpeechRecognition?: new () => RecognitionLike;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/* ---------- 呼びかけ（ウェイクワード）検出 ---------- */

/**
 * 音声認識での表記ゆれを拾う：フライデー / フライデイ / フライディ / ふらいでー / フライ・デー / Friday / ＦＲＩＤＡＹ、
 * 聞き間違いの多い プライデー / ブライデー（伸ばす音まであるときだけ）。
 * 発言の頭で呼んだときだけ起きる（「ねえ」「ヘイ」などは前に付いてよい）。文の途中の「ブラックフライデー」「今日はフライデー」では起きない。
 */
const WAKE_BODY =
  "(?:[フふ][\\s・]*[ラら][\\s・]*[イいィぃ][\\s・]*(?:ディ|でぃ|[デで])[\\s・]*[ーィぃイいエえ〜]?|[プぷブぶ][\\s・]*[ラら][\\s・]*[イい][\\s・]*[デで][\\s・]*[ーイい]|f\\s*r\\s*i\\s*d\\s*a\\s*y|ｆ\\s*ｒ\\s*ｉ\\s*ｄ\\s*ａ\\s*ｙ)";
/** 呼びかけの前に付いてよい言葉 */
const WAKE_LEAD = "(?:(?:ねえ|ねぇ|ねー|ヘイ|へい|hey|おい|あの|えっと|えーと|ちょっと|ok|オッケー)[\\s、。,.!！ー〜]*)?";
const WAKE_TAIL = "[\\s、。,.!！?？ー〜]*";
const WAKE_RE = new RegExp(`^[\\s、。「]*${WAKE_LEAD}${WAKE_BODY}${WAKE_TAIL}`, "i");

/** K.A.R.E.N. の呼び方（カレン / K.A.R.E.N.）。「カレンダー」「カレント」は呼びかけではない。これも発言の頭で呼んだときだけ */
const KAREN_WAKE_RE = new RegExp(
  `^[\\s、。「]*${WAKE_LEAD}(?:[カか]\\s*[レれ]\\s*[ンん](?![ダだトとシし])|k\\.?\\s*a\\.?\\s*r\\.?\\s*e\\.?\\s*n\\.?(?![a-z]))${WAKE_TAIL}`,
  "i",
);

export function splitWake(text: string): { woke: boolean; command: string } {
  const m = WAKE_RE.exec(text);
  if (m) {
    const command = text.slice(m[0].length).trim();
    // K.A.R.E.N. の間は「フライデー」では起きない。「フライデーに戻して」のような戻る指示だけ受け付ける
    if (getAiMode() === "karen") return detectModeCommand(command) === "to-friday" ? { woke: true, command } : { woke: false, command: "" };
    return { woke: true, command };
  }
  // 「カレン、起動」でも呼べる。K.A.R.E.N. の間は名前を取り除き、F.R.I.D.A.Y. の間は名前ごと渡す（切り替えの言葉として見分けるため）
  const k = KAREN_WAKE_RE.exec(text);
  if (!k) return { woke: false, command: "" };
  return { woke: true, command: getAiMode() === "karen" ? text.slice(k[0].length).trim() : text.trim() };
}

/** 発言の先頭に付いた呼びかけを取り除く（「フライデー、今日の予定は？」→「今日の予定は？」） */
export function stripWake(text: string): string {
  const m = WAKE_RE.exec(text);
  if (m) return text.slice(m[0].length).trim();
  const k = getAiMode() === "karen" ? KAREN_WAKE_RE.exec(text) : null;
  return k ? text.slice(k[0].length).trim() : text.trim();
}

/* ---------- 読み上げ用の整形 ---------- */

/** Markdown・記号を読み上げ向けの文章にする */
export function toSpeakable(text: string): string {
  return text
    .replace(/```[\s\S]*?(```|$)/g, "（コードは画面に表示しています）")
    .replace(/\[([^\]]+)\]\((?:https?:\/\/)[^)]+\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/^\s{0,3}(#{1,6}|[-*・]|\d+[.)])\s+/gm, "")
    .replace(/[*_`#>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** 文の区切り（読み上げを一文ずつ始めて、待ち時間を短くする） */
const SENTENCE_END = /[。！？!?\n]|\.(?=\s)/g;

/** text の from 以降で「言い終わった文」を切り出す */
export function takeSentences(text: string, from: number): { sentences: string[]; next: number } {
  const sentences: string[] = [];
  let next = from;
  SENTENCE_END.lastIndex = from;
  let m: RegExpExecArray | null;
  while ((m = SENTENCE_END.exec(text))) {
    const end = m.index + m[0].length;
    const s = text.slice(next, end).trim();
    if (s) sentences.push(s);
    next = end;
  }
  return { sentences, next };
}

/** 自然に聞こえやすい日本語音声を優先して選ぶ */
export function pickJapaneseVoice(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | null {
  // オフラインのときは、インターネットが要る声（Nanami・Google 日本語など）を避け、PC の中の声を使う
  const offline = typeof navigator !== "undefined" && (!navigator.onLine || offlineVoice);
  const ja = voices.filter((v) => /^ja(-|_|$)/i.test(v.lang) && (!offline || v.localService));
  const preferred = ["Nanami", "Google 日本語", "Kyoko", "O-ren", "Otoya", "Haruka", "Ayumi", "Keita"];
  for (const name of preferred) {
    const v = ja.find((x) => x.name.includes(name));
    if (v) return v;
  }
  return ja[0] ?? null;
}

/** ローカル AI で答えている間（インターネットに届かない）は true にする */
let offlineVoice = false;
export function setOfflineVoice(on: boolean): void {
  offlineVoice = on;
}

/* ---------- 効果音 ---------- */

let audioCtx: AudioContext | null = null;

/** 効果音・ElevenLabs 音声の再生に使う AudioContext（unlockAudio 後に使える） */
export function getAudioContext(): AudioContext | null {
  return audioCtx;
}

/** ユーザー操作の中で呼び、以後の効果音・読み上げを許可させる */
export function unlockAudio(): void {
  try {
    audioCtx ??= new AudioContext();
    void audioCtx.resume();
  } catch {
    /* noop */
  }
  try {
    const u = new SpeechSynthesisUtterance("");
    u.volume = 0;
    window.speechSynthesis?.speak(u);
  } catch {
    /* noop */
  }
}

/** 呼びかけに反応したときの短い効果音 */
export function chime(kind: "wake" | "end" | "boot" = "wake"): void {
  if (!audioCtx) return;
  try {
    const t = audioCtx.currentTime;
    // boot：拍手 2 回で全システムを起動したときの、上がっていく 4 音
    const tones = kind === "wake" ? [880, 1320] : kind === "boot" ? [523, 784, 1047, 1568] : [990, 660];
    tones.forEach((freq, i) => {
      const osc = audioCtx!.createOscillator();
      const gain = audioCtx!.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const start = t + i * 0.09;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.12, start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.12);
      osc.connect(gain).connect(audioCtx!.destination);
      osc.start(start);
      osc.stop(start + 0.13);
    });
  } catch {
    /* noop */
  }
}

/* ---------- 割り込み（自分の声の聞き取りとの区別） ---------- */

const ECHO_STRIP = /[\s、。，．,.!！?？「」『』（）()・…ー〜\-]/g;

/** 表記は違っても同じ音になる言葉（読み上げの文字 → 聞き取りで返ってくる形） */
const SAME_SOUND: [RegExp, string][] = [
  [/f\.?\s*r\.?\s*i\.?\s*d\.?\s*a\.?\s*y\.?|friday/gi, "ふらいでー"],
  [/mark\s*3|mark\s*iii/gi, "まーくすりー"],
];

/** 比較用に記号・空白を除き、カタカナをひらがなにそろえる（聞き取りはどちらで返るか決まらないため） */
export function normalizeForEcho(text: string): string {
  let t = text;
  for (const [re, to] of SAME_SOUND) t = t.replace(re, to);
  return t
    .replace(/[\u30a1-\u30f6]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .replace(ECHO_STRIP, "")
    .toLowerCase();
}

/**
 * 聞こえた言葉が「いま読み上げている文章」の聞き返し（スピーカーの音をマイクが拾ったもの）である度合い。
 * 2 文字ずつの並びがどれだけ読み上げ中の文章に含まれるかで判定（0〜1、高いほど自分の声）。
 */
export function echoScore(heard: string, spoken: string): number {
  const h = normalizeForEcho(heard);
  const s = normalizeForEcho(spoken);
  if (!h) return 1;
  if (!s) return 0;
  if (h.length < 2) return s.includes(h) ? 1 : 0;
  const grams = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) grams.add(s.slice(i, i + 2));
  let hit = 0;
  for (let i = 0; i < h.length - 1; i++) if (grams.has(h.slice(i, i + 2))) hit++;
  return hit / (h.length - 1);
}

/* ---------- オフラインの聞き取り（Chrome の PC の中だけで動く音声認識） ---------- */

export type OnDeviceSpeech = "available" | "downloadable" | "downloading" | "unavailable" | "unsupported";

type OnDeviceCtor = {
  available?: (o: { langs: string[]; processLocally: boolean }) => Promise<string>;
  install?: (o: { langs: string[]; processLocally: boolean }) => Promise<boolean>;
  // 古い版の名前
  availableOnDevice?: (lang: string) => Promise<string>;
  installOnDevice?: (lang: string) => Promise<boolean>;
};

const LANG = "ja-JP";
/**
 * 日本語を PC の中だけで聞き取れると分かっているか（SETTINGS で確かめた結果を覚えておく）。
 * Chrome に「使えるか」を聞く処理は、環境によってはページごと落ちることがあるため、自動では呼ばず、
 * SETTINGS のボタンを押したときだけ呼ぶ。
 */
const ON_DEVICE_KEY = "friday.ondevice-speech.v1";
let onDeviceReady = (() => {
  try {
    return typeof localStorage !== "undefined" && localStorage.getItem(ON_DEVICE_KEY) === "available";
  } catch {
    return false;
  }
})();

/**
 * いま PC の中だけで聞き取るべきか。ネットが切れている（またはローカル AI で答えている）ときで、
 * 日本語の聞き取りデータが入っていれば PC の中で聞き取る（入っていなければ、ふつうの聞き取りを試す）。
 */
export function shouldRecognizeLocally(): boolean {
  if (!onDeviceReady) return false;
  // インターネットにつながっている間は、いつものネットの聞き取りを使う（Gemini が使えないだけのときも、聞き取りはネットで動く）
  return typeof navigator !== "undefined" && !navigator.onLine;
}

/** 前に SETTINGS で確かめた結果（まだなら null） */
export function lastOnDeviceStatus(): OnDeviceSpeech | null {
  try {
    return (localStorage.getItem(ON_DEVICE_KEY) as OnDeviceSpeech | null) ?? null;
  } catch {
    return null;
  }
}

/** 声の聞き取りがネットに届かないとき、オフラインだからか */
export function voiceOffline(): boolean {
  return (typeof navigator !== "undefined" && !navigator.onLine) || offlineVoice;
}

/** 日本語を PC の中だけで聞き取れるか（ネットが切れていても使えるか） */
export async function onDeviceSpeechStatus(): Promise<OnDeviceSpeech> {
  const Ctor = getRecognitionCtor() as unknown as OnDeviceCtor | null;
  if (!Ctor) return "unsupported";
  try {
    const r = Ctor.available
      ? await Ctor.available({ langs: [LANG], processLocally: true })
      : Ctor.availableOnDevice
        ? await Ctor.availableOnDevice(LANG)
        : null;
    onDeviceReady = r === "available";
    try {
      localStorage.setItem(ON_DEVICE_KEY, typeof r === "string" ? r : "unsupported");
    } catch {
      /* noop */
    }
    if (r === "available" || r === "downloadable" || r === "downloading" || r === "unavailable") return r;
    return r === null ? "unsupported" : "unavailable";
  } catch {
    return "unsupported";
  }
}

/** 日本語の聞き取りデータを Chrome に入れる（オンラインのときに 1 回。ボタンの操作の中で呼ぶ） */
export async function installOnDeviceSpeech(): Promise<boolean> {
  const Ctor = getRecognitionCtor() as unknown as OnDeviceCtor | null;
  try {
    if (Ctor?.install) return await Ctor.install({ langs: [LANG], processLocally: true });
    if (Ctor?.installOnDevice) return await Ctor.installOnDevice(LANG);
  } catch {
    /* 失敗 */
  }
  return false;
}
