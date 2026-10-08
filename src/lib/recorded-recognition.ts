/**
 * スマホ用の聞き取り。ブラウザの音声認識（SpeechRecognition）と同じ形で使えるようにした代わりの仕組み。
 * スマホのブラウザの音声認識は、マイクが付いても声を拾わないことがある（iPhone のホーム画面から開いたときなど）ため、
 *   マイクの音を自分で録る → 声の始まりと終わりを音量で見分ける → 話し終わったら /api/stt で文字にする
 * という流れにする。録った音声は文字にするためだけに送り、保存しない。
 * 1 回の start() で 1 発言（ブラウザの音声認識の continuous=false と同じ）。
 */
import { getAudioContext, type RecognitionErrorEvent, type RecognitionLike, type RecognitionResultEvent } from "./speech";

/** 送る音声の速さ（16kHz・モノラル。声の文字起こしには十分で、軽い） */
const RATE = 16_000;
/** 話し終わりとみなす無音の長さ */
const END_SILENCE_MS = 650;
/** 何も話さなかったときに区切るまでの時間（ブラウザの音声認識と同じく、区切られたら呼び出し側がまた始める） */
const NO_SPEECH_MS = 7_000;
/** 1 発言の最長 */
const MAX_UTTER_MS = 30_000;
/** 話し始めの直前も少し残す（最初の音を切らないように） */
const PRE_ROLL_MS = 350;
/** これだけ黙ったら、話し終わりの判定を待たずに文字起こしを先に始める */
const EARLY_SEND_MS = 300;

/** 音声を送って文字にしてもらう */
async function sendForText(samples: Float32Array, signal: AbortSignal): Promise<string> {
  const res = await fetch("/api/stt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ audio: toBase64(toWav(samples, RATE)), mimeType: "audio/wav" }),
    signal,
  });
  const json = (await res.json().catch(() => ({}))) as { ok?: boolean; text?: string };
  if (!res.ok || !json.ok) throw new Error("stt");
  return (json.text ?? "").trim();
}

export function canRecord(): boolean {
  return typeof window !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia) && typeof AudioContext !== "undefined";
}

/** 16bit・モノラルの WAV にする */
function toWav(samples: Float32Array, rate: number): Uint8Array {
  const out = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const str = (o: number, s: string) => [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  out.setUint32(4, 36 + samples.length * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  out.setUint32(16, 16, true);
  out.setUint16(20, 1, true);
  out.setUint16(22, 1, true);
  out.setUint32(24, rate, true);
  out.setUint32(28, rate * 2, true);
  out.setUint16(32, 2, true);
  out.setUint16(34, 16, true);
  str(36, "data");
  out.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    out.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  return new Uint8Array(out.buffer);
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** マイクの音を 16kHz に間引く（平均を取る） */
export function downsample(input: Float32Array, from: number): Float32Array {
  if (from === RATE) return input.slice();
  const ratio = from / RATE;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j];
    out[i] = sum / Math.max(1, end - start);
  }
  return out;
}

const result = (text: string): RecognitionResultEvent => {
  const r = Object.assign([{ transcript: text }], { isFinal: true });
  return { resultIndex: 0, results: [r] };
};

export class RecordedRecognition implements RecognitionLike {
  lang = "ja-JP";
  continuous = false;
  interimResults = false;
  maxAlternatives = 1;
  onresult: ((e: RecognitionResultEvent) => void) | null = null;
  onerror: ((e: RecognitionErrorEvent) => void) | null = null;
  onend: (() => void) | null = null;
  /** 声が聞こえている間、ときどき呼ぶ（呼び出し側が聞き取りの受付時間を延ばせるように） */
  onspeechstart: (() => void) | null = null;
  /**
   * 指定すると、文字にせずに録った声（WAV・base64）をそのまま渡す（会話のサーバーが文字にする。往復が 1 回で済む）。
   * 指定しなければ /api/stt で文字にして onresult で返す。
   */
  onaudio: ((audio: { mimeType: string; data: string }) => void) | null = null;
  /** 声紋認証。録った 1 発言が本人の声か確かめる（false なら文字にも送りもせず、聞き直す） */
  verify: ((samples: Float32Array) => Promise<boolean>) | null = null;

  private session = 0;
  private stream: MediaStream | null = null;
  private nodes: AudioNode[] = [];
  private controller: AbortController | null = null;
  private ended = true;

  start(): void {
    if (!this.ended) throw new Error("already started");
    this.ended = false;
    const id = ++this.session;
    // 話している間に、文字起こしのサーバーを起こしておく（話し終えてから待たされないように）
    if (!this.onaudio) void fetch("/api/stt", { method: "GET", cache: "no-store" }).catch(() => {});
    void this.run(id).catch((err: unknown) => {
      if (id !== this.session) return;
      const name = err instanceof Error ? err.name : "";
      this.onerror?.({ error: name === "NotAllowedError" || name === "SecurityError" ? "not-allowed" : name === "NotFoundError" ? "audio-capture" : "network" });
      this.finish(id);
    });
  }

  stop(): void {
    this.abort();
  }

  abort(): void {
    if (this.ended) return;
    const id = this.session;
    this.session++;
    this.controller?.abort();
    this.release();
    setTimeout(() => this.finish(id, true), 0);
  }

  private finish(id: number, aborted = false) {
    if (this.ended || (!aborted && id !== this.session)) return;
    this.ended = true;
    this.release();
    this.onend?.();
  }

  /** マイクを離す（iPhone はマイクを使っている間、読み上げの音が小さくなるため、使い終わったらすぐ離す） */
  private release() {
    this.nodes.forEach((n) => {
      try {
        n.disconnect();
      } catch {
        /* noop */
      }
    });
    this.nodes = [];
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }

  private async run(id: number) {
    const ctx = getAudioContext() ?? new AudioContext();
    if (ctx.state !== "running") await ctx.resume().catch(() => {});
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    if (id !== this.session) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    this.stream = stream;
    const source = ctx.createMediaStreamSource(stream);
    const proc = ctx.createScriptProcessor(2048, 1, 1);
    const mute = ctx.createGain();
    mute.gain.value = 0;
    source.connect(proc);
    proc.connect(mute);
    mute.connect(ctx.destination); // つながっていないと音の処理が動かない端末があるため（音は出さない）
    this.nodes = [source, proc, mute];

    const frameMs = (2048 / ctx.sampleRate) * 1000;
    const chunks: Float32Array[] = [];
    const preRoll: Float32Array[] = [];
    let floor = 0.004; // まわりの雑音の大きさ（少しずつ合わせる）
    let loudFrames = 0;
    let speaking = false;
    let silentMs = 0;
    let spokeMs = 0;
    let waitedMs = 0;
    let lastPing = 0;

    const concat = () => {
      const all = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
      let o = 0;
      for (const c of chunks) {
        all.set(c, o);
        o += c.length;
      }
      return all;
    };
    // 少し黙った時点で、話し終わりを待たずに文字起こしを先に始める（続きを話したら取り消す）
    let early: { controller: AbortController; promise: Promise<string> } | null = null;
    const cancelEarly = () => {
      early?.controller.abort();
      early = null;
    };

    const utterance = await new Promise<Float32Array | null>((resolve) => {
      proc.onaudioprocess = (e) => {
        if (id !== this.session) return resolve(null);
        const input = e.inputBuffer.getChannelData(0);
        let sum = 0;
        for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
        const rms = Math.sqrt(sum / input.length);
        const small = downsample(input, ctx.sampleRate);
        const threshold = Math.max(0.01, floor * 3);
        if (!speaking) {
          waitedMs += frameMs;
          preRoll.push(small);
          while (preRoll.length * frameMs > PRE_ROLL_MS) preRoll.shift();
          if (rms > threshold) loudFrames++;
          else {
            loudFrames = 0;
            floor = floor * 0.95 + rms * 0.05;
          }
          if (loudFrames >= 2) {
            speaking = true;
            chunks.push(...preRoll);
            this.onspeechstart?.();
            lastPing = 0;
          } else if (waitedMs > NO_SPEECH_MS) resolve(null);
          return;
        }
        chunks.push(small);
        spokeMs += frameMs;
        lastPing += frameMs;
        if (lastPing > 2500) {
          lastPing = 0;
          this.onspeechstart?.();
        }
        if (rms > threshold * 0.7) {
          silentMs = 0;
          cancelEarly();
        } else silentMs += frameMs;
        if (!early && !this.onaudio && silentMs >= EARLY_SEND_MS && spokeMs - silentMs >= 350) {
          const controller = new AbortController();
          early = { controller, promise: sendForText(concat(), controller.signal) };
          early.promise.catch(() => {}); // 取り消したときのエラーは無視（使うときに改めて受け取る）
        }
        if (silentMs >= END_SILENCE_MS || spokeMs >= MAX_UTTER_MS) resolve(concat());
      };
    });
    proc.onaudioprocess = null;
    this.release();
    if (id !== this.session) return cancelEarly();
    // 短すぎる音（せき・物音）は送らない
    if (!utterance || utterance.length < RATE * 0.35) {
      cancelEarly();
      return this.finish(id);
    }

    if (this.verify) {
      const ok = await this.verify(utterance).catch(() => true);
      if (id !== this.session) return cancelEarly();
      if (!ok) {
        cancelEarly();
        return this.finish(id);
      }
    }

    // 声のまま渡す（会話のサーバーで文字にする）
    if (this.onaudio) {
      cancelEarly();
      this.onaudio({ mimeType: "audio/wav", data: toBase64(toWav(utterance, RATE)) });
      return this.finish(id);
    }

    const pending = early as { controller: AbortController; promise: Promise<string> } | null;
    this.controller = pending?.controller ?? new AbortController();
    const text = await (pending?.promise ?? sendForText(utterance, this.controller.signal));
    if (id !== this.session) return;
    if (text) this.onresult?.(result(text));
    this.finish(id);
  }
}
