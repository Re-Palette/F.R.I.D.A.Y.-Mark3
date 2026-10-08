/**
 * 音声会話の小道具（ブラウザ標準の Web Speech API を使う。追加ライブラリなし）。
 *  - 音声認識: SpeechRecognition（Chrome / Edge / Safari）
 *  - 読み上げ: speechSynthesis
 */

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
 * 音声認識での表記ゆれをまとめて拾う。
 * フライデー / フライデイ / フライディ / プライデー / ブライデー / ふらいでー / フライ デー / Friday / ＦＲＩＤＡＹ など。
 */
const WAKE_RE =
  /(?:[フふプぷブぶ]\s*[ラら]\s*[イいィぃ]\s*[デでテて]\s*[ーィぃイいエえ〜]?|f\s*r\s*i\s*d\s*a\s*y|ｆ\s*ｒ\s*ｉ\s*ｄ\s*ａ\s*ｙ)[\s、。,.!！?？ー〜]*/i;

export function splitWake(text: string): { woke: boolean; command: string } {
  const m = WAKE_RE.exec(text);
  if (!m) return { woke: false, command: "" };
  const command = text.slice(m.index + m[0].length).trim();
  return { woke: true, command };
}

/** 発言の先頭に付いた呼びかけを取り除く（「フライデー、今日の予定は？」→「今日の予定は？」） */
export function stripWake(text: string): string {
  const m = WAKE_RE.exec(text);
  return m && m.index <= 2 ? text.slice(m.index + m[0].length).trim() : text.trim();
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
  const ja = voices.filter((v) => /^ja(-|_|$)/i.test(v.lang));
  const preferred = ["Nanami", "Google 日本語", "Kyoko", "O-ren", "Otoya", "Haruka", "Ayumi", "Keita"];
  for (const name of preferred) {
    const v = ja.find((x) => x.name.includes(name));
    if (v) return v;
  }
  return ja[0] ?? null;
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
