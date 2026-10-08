/**
 * 声紋認証（陽大の声にだけ反応する）。画面の中だけで動く。
 *   1. 声（16kHz）から特徴（80 帯の対数メルフィルタバンク。Kaldi と同じ作り方）を取り出す
 *   2. 話者の特徴を数字の並び（声紋・512 個）にする AI（CAM++。public/models/ の約 8MB）に通す
 *   3. 登録した声紋とどれだけ近いか（コサイン類似度）で、本人かどうかを決める
 * 保存するのは声紋の数字だけ（声そのものは保存も送信もしない）。登録した声紋は脳（.friday/voiceprint.json）に置き、端末どうしで共有する。
 */

export const VOICEPRINT_RATE = 16_000;
const MODEL_URL = "/models/speaker-campplus-int8.onnx";
const ORT_URL = "/ort/ort.wasm.min.mjs";

/** 本人とみなす近さ（厳しさ） */
export const STRICTNESS = { loose: 0.42, normal: 0.5, strict: 0.6 } as const;
export type Strictness = keyof typeof STRICTNESS;

export interface Voiceprint {
  /** 登録した声紋（長さ 1 にそろえた数字の並び） */
  embedding: number[];
  strictness: Strictness;
  enabled: boolean;
  /** 登録に使った回数 */
  samples: number;
  createdAt: string;
}

/* ---------- 特徴（Kaldi の fbank と同じ。窓 25ms・10ms ずつ・ハミング窓・80 帯） ---------- */

const FRAME = 400;
const SHIFT = 160;
const NFFT = 512;
const MELS = 80;
const mel = (f: number) => 1127 * Math.log(1 + f / 700);

let bank: Float32Array[] | null = null;
let window_: Float32Array | null = null;
function tables() {
  if (bank && window_) return { bank, window: window_ };
  window_ = new Float32Array(FRAME).map((_, n) => 0.54 - 0.46 * Math.cos((2 * Math.PI * n) / (FRAME - 1)));
  const lo = mel(20);
  const hi = mel(VOICEPRINT_RATE / 2);
  const d = (hi - lo) / (MELS + 1);
  bank = [];
  for (let b = 0; b < MELS; b++) {
    const l = lo + b * d;
    const c = l + d;
    const r = c + d;
    const row = new Float32Array(NFFT / 2 + 1);
    for (let i = 0; i < NFFT / 2; i++) {
      const m = mel((VOICEPRINT_RATE / NFFT) * i);
      row[i] = Math.max(0, Math.min((m - l) / (c - l), (r - m) / (r - c)));
    }
    bank.push(row);
  }
  return { bank, window: window_ };
}

/** 長さ 512 の実数 FFT のパワー（0〜256 番目） */
function powerSpectrum(frame: Float64Array, re: Float64Array, im: Float64Array, out: Float64Array) {
  re.fill(0);
  im.fill(0);
  re.set(frame);
  // ビット反転の並べ替え
  for (let i = 1, j = 0; i < NFFT; i++) {
    let bit = NFFT >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= NFFT; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < NFFT; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
  for (let i = 0; i <= NFFT / 2; i++) out[i] = re[i] * re[i] + im[i] * im[i];
}

/** 声（-1〜1・16kHz）→ 特徴（フレーム数 × 80。時間方向の平均を引いたもの） */
export function fbank(samples: Float32Array): { data: Float32Array; frames: number } {
  const { bank, window } = tables();
  const frames = samples.length < FRAME ? 0 : 1 + Math.floor((samples.length - FRAME) / SHIFT);
  const data = new Float32Array(frames * MELS);
  const frame = new Float64Array(FRAME);
  const re = new Float64Array(NFFT);
  const im = new Float64Array(NFFT);
  const spec = new Float64Array(NFFT / 2 + 1);
  const eps = 1.1920928955078125e-7;
  for (let t = 0; t < frames; t++) {
    let mean = 0;
    for (let i = 0; i < FRAME; i++) mean += (frame[i] = samples[t * SHIFT + i] * 32768);
    mean /= FRAME;
    for (let i = 0; i < FRAME; i++) frame[i] -= mean;
    for (let i = FRAME - 1; i > 0; i--) frame[i] -= 0.97 * frame[i - 1];
    frame[0] -= 0.97 * frame[0];
    for (let i = 0; i < FRAME; i++) frame[i] *= window[i];
    powerSpectrum(frame, re, im, spec);
    for (let b = 0; b < MELS; b++) {
      const row = bank[b];
      let e = 0;
      for (let i = 0; i <= NFFT / 2; i++) e += row[i] * spec[i];
      data[t * MELS + b] = Math.log(Math.max(e, eps));
    }
  }
  // 時間方向の平均を引く（マイクや部屋の違いを減らす）
  for (let b = 0; b < MELS; b++) {
    let m = 0;
    for (let t = 0; t < frames; t++) m += data[t * MELS + b];
    m /= Math.max(1, frames);
    for (let t = 0; t < frames; t++) data[t * MELS + b] -= m;
  }
  return { data, frames };
}

/** 声の部分だけを残す（無音・小さな物音を除く）。残った声の長さが短すぎれば null */
export function voicedOnly(samples: Float32Array, minSec = 0.5): Float32Array | null {
  const win = 320; // 20ms
  const n = Math.floor(samples.length / win);
  if (!n) return null;
  const rms = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = 0; k < win; k++) s += samples[i * win + k] ** 2;
    rms[i] = Math.sqrt(s / win);
  }
  const sorted = [...rms].sort((a, b) => a - b);
  const floor = sorted[Math.floor(n * 0.2)];
  const peak = sorted[Math.floor(n * 0.95)];
  const gate = Math.max(0.008, floor * 2.5, peak * 0.12);
  const keep: number[] = [];
  for (let i = 0; i < n; i++) if (rms[i] > gate || (rms[i - 1] ?? 0) > gate || (rms[i + 1] ?? 0) > gate) keep.push(i);
  if (keep.length * win < minSec * VOICEPRINT_RATE) return null;
  const out = new Float32Array(keep.length * win);
  keep.forEach((i, j) => out.set(samples.subarray(i * win, i * win + win), j * win));
  return out;
}

/* ---------- AI（声紋を作る） ---------- */

type Ort = {
  env: { wasm: { wasmPaths: string; numThreads: number } };
  InferenceSession: { create(url: string, opts?: object): Promise<OrtSession> };
  Tensor: new (type: "float32", data: Float32Array, dims: number[]) => unknown;
};
type OrtSession = { run(feeds: Record<string, unknown>): Promise<Record<string, { data: Float32Array }>> };

let session: Promise<{ ort: Ort; s: OrtSession }> | null = null;

/** AI を読み込む（初回だけ。約 8MB と実行部品。以後はブラウザが覚えておく） */
export function loadVoiceprintModel(): Promise<{ ort: Ort; s: OrtSession }> {
  session ??= (async () => {
    const ort = (await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ ORT_URL as string)) as Ort;
    ort.env.wasm.wasmPaths = "/ort/";
    ort.env.wasm.numThreads = 1; // 複数スレッドはページの特別な設定が要るので使わない
    const s = await ort.InferenceSession.create(MODEL_URL, { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
    return { ort, s };
  })().catch((err) => {
    session = null;
    throw err;
  });
  return session;
}

/** 声 → 声紋（長さ 1 にそろえる）。声が短すぎれば null */
export async function embedVoice(samples: Float32Array): Promise<Float32Array | null> {
  const voiced = voicedOnly(samples, 0.4);
  if (!voiced) return null;
  // 長すぎる声は真ん中の 8 秒だけ（計算を軽く）
  const max = VOICEPRINT_RATE * 8;
  const clip = voiced.length > max ? voiced.subarray((voiced.length - max) >> 1, ((voiced.length - max) >> 1) + max) : voiced;
  const { data, frames } = fbank(clip);
  if (frames < 30) return null;
  const { ort, s } = await loadVoiceprintModel();
  const out = await s.run({ feats: new ort.Tensor("float32", data, [1, frames, MELS]) });
  const e = Object.values(out)[0].data;
  return normalize(e);
}

export function normalize(v: ArrayLike<number>): Float32Array {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  return Float32Array.from(v, (x) => x / n);
}

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) s += a[i] * b[i];
  return s;
}

/** 本人の声か（登録が無い・オフなら常に true） */
export async function isOwnerVoice(samples: Float32Array, print: Voiceprint | null): Promise<{ ok: boolean; score?: number; reason?: string }> {
  if (!print?.enabled || !print.embedding.length) return { ok: true };
  const e = await embedVoice(samples).catch(() => null);
  if (!e) return { ok: false, reason: "short" };
  const score = cosine(e, print.embedding);
  return { ok: score >= STRICTNESS[print.strictness], score };
}

/* ---------- 登録した声紋（脳に保存して端末どうしで共有。画面にも覚えておく） ---------- */

const LOCAL_KEY = "friday.voiceprint.v1";
let cached: Voiceprint | null | undefined;
const listeners = new Set<() => void>();

export function currentVoiceprint(): Voiceprint | null {
  if (cached !== undefined) return cached;
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    cached = raw ? (JSON.parse(raw) as Voiceprint) : null;
  } catch {
    cached = null;
  }
  return cached;
}

function remember(v: Voiceprint | null) {
  cached = v;
  try {
    if (v) localStorage.setItem(LOCAL_KEY, JSON.stringify(v));
    else localStorage.removeItem(LOCAL_KEY);
  } catch {
    /* noop */
  }
  listeners.forEach((l) => l());
}

export function onVoiceprintChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 脳から最新の声紋を読む（ほかの端末で登録・変更したもの） */
export async function syncVoiceprint(): Promise<Voiceprint | null> {
  const res = await fetch("/api/voiceprint", { cache: "no-store" }).catch(() => null);
  if (!res?.ok) return currentVoiceprint();
  const j = (await res.json().catch(() => ({}))) as { voiceprint?: Voiceprint | null };
  if (j.voiceprint !== undefined) remember(j.voiceprint);
  return currentVoiceprint();
}

export async function saveVoiceprint(v: Voiceprint | null): Promise<void> {
  remember(v);
  await fetch("/api/voiceprint", {
    method: v ? "POST" : "DELETE",
    headers: { "Content-Type": "application/json" },
    body: v ? JSON.stringify(v) : undefined,
  }).catch(() => {});
}
