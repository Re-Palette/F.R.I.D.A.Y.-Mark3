/**
 * リアルタイム音声会話（Gemini Live API）。ChatGPT の音声会話と同じく、声のまま直接やりとりする。
 *   マイクの音を少しずつ送る → Gemini が話し終わりを見分けてすぐ声で返す（文字にする・考える・声を作るを 1 回で）
 * 声は Google と直接やりとりし、F.R.I.D.A.Y. のサーバーにも端末にも保存しない。
 * つなぐ鍵はサーバーが作る使い捨ての鍵（API キーは画面に来ない）。
 * 話しかけが無いまましばらく経ったら会話を閉じる（つなぎっぱなしで料金がかからないように）。
 */
import { getAudioContext } from "./speech";
import { downsample } from "./recorded-recognition";
import { sharedMicStream, trackSpeechNode } from "./voice-level";

/** 送る音声の速さ（16kHz・モノラル・16bit） */
const IN_RATE = 16_000;
/** これだけ溜まったら送る（約 40ms。細かく送るほど返事が速い） */
const SEND_SAMPLES = 640;
/** 話しかけも返事も無いまま、これだけ経ったら会話を閉じる */
export const LIVE_IDLE_MS = 20_000;
/** つながるまで待つ時間 */
const CONNECT_MS = 8_000;
/** F.R.I.D.A.Y. が話している間、これより小さいマイクの音は送らない（自分の声を拾って話を止めないように） */
const ECHO_GATE_RMS = 0.03;

export type LiveStatus = "connecting" | "listening" | "speaking";
export type LiveEndReason = "idle" | "error" | "closed";

export interface LiveHandlers {
  onStatus?: (s: LiveStatus) => void;
  /** ユーザーの発言（ここまでの全文）。done で確定 */
  onUserText?: (text: string, done: boolean) => void;
  /** F.R.I.D.A.Y. の返事（ここまでの全文）。done で確定（stopped は割り込まれて途中で止まった） */
  onModelText?: (text: string, done: boolean, stopped?: boolean) => void;
  onEnd?: (reason: LiveEndReason, error?: string) => void;
  /** AI が画面の操作（K.A.R.E.N. の制作・編集）を頼んできたとき。結果を返すと AI がそれを伝える */
  onTool?: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

/** K.A.R.E.N. の制作・編集を画面に頼む道具（サーバーの integrations/live.ts と同じ名前） */
export const KAREN_TOOL = "karen_operate";
/** F.R.I.D.A.Y. の操作を、これまでの会話の仕組み（予定・メールなどの操作ができる）に頼む道具 */
export const FRIDAY_TOOL = "friday_action";
const FRIDAY_TOOL_DECL = {
  functionDeclarations: [
    {
      name: FRIDAY_TOOL,
      description:
        "F.R.I.D.A.Y. の操作をする：予定の追加・変更・削除、ToDo・リマインダー、覚えておくこと、Gmail の下書き（送信はしない）、音楽、Web ページやパソコンのアプリを開く・タブを閉じる、文書づくり、ホログラム。",
      parameters: {
        type: "OBJECT",
        properties: { request: { type: "STRING", description: "頼みの内容（日本語の 1 文。例：10月14日の15時から1時間、打ち合わせを予定に入れて）" } },
        required: ["request"],
      },
    },
  ],
};
const KAREN_TOOL_DECL = {
  functionDeclarations: [
    {
      name: KAREN_TOOL,
      description:
        "K.A.R.E.N. の制作ワークスペースで 3D の制作・編集をする（3D モデルの作成、形の追加、色・大きさ・向き・位置の変更、削除、回転、保存、書き出し、制作のキャンセル）。",
      parameters: {
        type: "OBJECT",
        properties: { request: { type: "STRING", description: "ユーザーの頼み（日本語のまま。例：未来都市の3Dホログラムを作って、青くして）" } },
        required: ["request"],
      },
    },
  ],
};

export interface LiveStartOptions {
  /** 呼びかけと一緒に話した用件（「フライデー、今日の天気は」の「今日の天気は」）。最初に文字で渡す */
  firstText?: string;
  recent?: { role: "user" | "assistant"; content: string }[];
  /** K.A.R.E.N.（クリエイティブ AI）として話す（制作・編集の道具も渡す） */
  persona?: "karen";
  calendar?: unknown;
}

interface LivePrep {
  ok: boolean;
  url?: string;
  model?: string;
  systemInstruction?: string;
  voiceName?: string | null;
  error?: string;
  /** 画面が古い版（読み込み直す） */
  stale?: boolean;
}

/** この画面の版（サーバーの版と同じでなければ、画面が古い） */
export const CLIENT_BUILD = process.env.NEXT_PUBLIC_FRIDAY_BUILD ?? "dev";
/** 画面が古い版だと分かったときのイベント（呼び出し側が、手が空いたときに読み込み直す） */
export const STALE_CLIENT = "friday:stale-client";

/** サーバーからの 1 通（必要なところだけ） */
export interface LiveServerMessage {
  setupComplete?: unknown;
  serverContent?: {
    modelTurn?: { parts?: { inlineData?: { mimeType?: string; data?: string }; text?: string }[] };
    turnComplete?: boolean;
    interrupted?: boolean;
    inputTranscription?: { text?: string };
    outputTranscription?: { text?: string };
  };
  goAway?: unknown;
  toolCall?: { functionCalls?: { id?: string; name?: string; args?: Record<string, unknown> }[] };
}

/** 最初に送る設定。full=false は、細かい設定を受け付けないモデル向けの最小の設定 */
export function buildSetup(
  prep: Required<Pick<LivePrep, "model" | "systemInstruction">> & { voiceName?: string | null },
  full: boolean,
  persona?: "karen",
) {
  // 操作の道具は、細かい設定を受け付けないモデル向けの最小の設定にも入れる（無いと操作ができない）
  const own = [persona === "karen" ? KAREN_TOOL_DECL : FRIDAY_TOOL_DECL];
  const tools = full ? [{ googleSearch: {} }, ...own] : own;
  return {
    setup: {
      model: prep.model.startsWith("models/") ? prep.model : `models/${prep.model}`,
      generationConfig: {
        responseModalities: ["AUDIO"],
        ...(prep.voiceName ? { speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: prep.voiceName } } } } : {}),
      },
      systemInstruction: { parts: [{ text: prep.systemInstruction }] },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      ...(tools.length ? { tools } : {}),
      ...(full
        ? {
            // 話し終わりを早めに見分ける（返事を速く）
            realtimeInputConfig: { automaticActivityDetection: { endOfSpeechSensitivity: "END_SENSITIVITY_HIGH", silenceDurationMs: 500 } },
          }
        : {}),
    },
  };
}

export function int16ToBase64(samples: Float32Array): string {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function base64ToFloat32(data: string): Float32Array {
  const bin = atob(data);
  const n = bin.length >> 1;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let v = bin.charCodeAt(i * 2) | (bin.charCodeAt(i * 2 + 1) << 8);
    if (v >= 0x8000) v -= 0x10000;
    out[i] = v / 0x8000;
  }
  return out;
}

export function rateOf(mimeType: string | undefined): number {
  const m = mimeType?.match(/rate=(\d+)/);
  return m ? Number(m[1]) : 24_000;
}

let fallbackCtx: AudioContext | null = null;

export class LiveSession {
  private ws: WebSocket | null = null;
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private ownStream = false;
  private nodes: AudioNode[] = [];
  private out: GainNode | null = null;
  private playing: AudioBufferSourceNode[] = [];
  private nextAt = 0;
  private releaseLevel: (() => void) | null = null;
  private idleTimer = 0;
  private doneTimer = 0;
  private pending: Float32Array[] = [];
  private pendingLen = 0;
  private userText = "";
  private modelText = "";
  private ended = false;
  private ready = false;
  private status: LiveStatus = "connecting";
  private inbox: Promise<void> = Promise.resolve();

  constructor(private h: LiveHandlers) {}

  get active(): boolean {
    return !this.ended;
  }

  /** 前もってつないだときの K.A.R.E.N. かどうか・つないだ時刻（古ければつなぎ直す） */
  persona: "karen" | undefined;
  preparedAt = 0;

  /** 前もってつないで、すぐ話せる状態か */
  get isReady(): boolean {
    return this.ready && !this.ended;
  }

  /** 呼び出し側の受け口を差し替える（前もってつないでおいた会話を、話しかけられたときに使い始める） */
  setHandlers(h: LiveHandlers): void {
    this.h = h;
  }

  /** つないで話せる状態にする（つながらなければ例外。呼び出し側はこれまでの聞き取りに戻す） */
  async start(opts: LiveStartOptions = {}): Promise<void> {
    // マイク（パソコンは音量を測るために開いているものを共有）と、つなぐ準備を同時に
    const mic = this.openMic();
    try {
      await this.prepare(opts);
    } catch (err) {
      mic.then((s) => this.ownStream && s.getTracks().forEach((t) => t.stop())).catch(() => {});
      throw err;
    }
    await this.begin(opts.firstText, mic);
  }

  /** 前もってつないでおく（マイクはまだ使わない。話しかけられたら begin ですぐ始められる） */
  async prepare(opts: Omit<LiveStartOptions, "firstText"> = {}): Promise<void> {
    this.setStatus("connecting");
    const ctx = getAudioContext() ?? (fallbackCtx ??= new AudioContext());
    this.ctx = ctx;
    if (ctx.state !== "running") await ctx.resume().catch(() => {});
    this.out = ctx.createGain();
    this.out.connect(ctx.destination);
    let lastError: unknown = null;
    for (const full of [true, false]) {
      if (this.ended) break;
      try {
        await this.connect(full, opts);
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
        if (err instanceof Error && err.name === "STALE") {
          window.dispatchEvent(new Event(STALE_CLIENT));
          break;
        }
      }
    }
    if (lastError || this.ended) {
      this.cleanup();
      throw lastError ?? new Error("closed");
    }
    this.persona = opts.persona;
    this.preparedAt = Date.now();
  }

  private openMic(): Promise<MediaStream> {
    const task = (async () => {
      const shared = sharedMicStream();
      if (shared) return shared;
      this.ownStream = true;
      return navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    })();
    task.catch(() => {});
    return task;
  }

  /** 話し始める（マイクの声を送り始める。firstText があれば最初の一言として渡す） */
  async begin(firstText?: string, mic: Promise<MediaStream> = this.openMic()): Promise<void> {
    let stream: MediaStream;
    try {
      stream = await mic;
    } catch (err) {
      this.stop("error", "マイクを使えませんでした。");
      throw err;
    }
    if (this.ended) {
      if (this.ownStream) stream.getTracks().forEach((t) => t.stop());
      return;
    }
    this.stream = stream;
    this.startMic();
    if (firstText?.trim()) {
      this.h.onUserText?.(firstText.trim(), true);
      this.send({ realtimeInput: { text: firstText.trim() } });
    } else this.setStatus("listening");
    this.bumpIdle();
  }

  /** 会話を閉じる */
  stop(reason: LiveEndReason = "closed", error?: string): void {
    if (this.ended) return;
    this.ended = true;
    this.finishModel(true);
    this.cleanup();
    this.h.onEnd?.(reason, error);
  }

  private setStatus(s: LiveStatus) {
    if (this.status === s && s !== "connecting") return;
    this.status = s;
    this.h.onStatus?.(s);
  }

  private send(msg: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private async connect(full: boolean, opts: LiveStartOptions): Promise<void> {
    const res = await fetch("/api/live", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recent: opts.recent ?? [], calendar: opts.calendar, persona: opts.persona, build: CLIENT_BUILD }),
      cache: "no-store",
    });
    const prep = (await res.json().catch(() => ({ ok: false }))) as LivePrep;
    if (prep.stale) throw Object.assign(new Error(prep.error || "画面が古い版です。"), { name: "STALE" });
    if (!res.ok || !prep.ok || !prep.url || !prep.model || !prep.systemInstruction) throw new Error(prep.error || "リアルタイム会話を始められませんでした。");
    if (this.ended) throw new Error("closed");
    const ws = new WebSocket(prep.url);
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        reject(new Error("timeout"));
        try {
          ws.close();
        } catch {
          /* noop */
        }
      }, CONNECT_MS);
      ws.onopen = () => ws.send(JSON.stringify(buildSetup({ model: prep.model!, systemInstruction: prep.systemInstruction!, voiceName: prep.voiceName }, full, opts.persona)));
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error("リアルタイム会話につながりませんでした。"));
      };
      ws.onclose = (e) => {
        clearTimeout(timer);
        reject(new Error(e.reason || "リアルタイム会話につながりませんでした。"));
      };
      ws.onmessage = (e) => {
        // 届いた順に処理する（バイナリで届いた分は読み出しが非同期なので、順番が入れ替わらないようにつなぐ）
        this.inbox = this.inbox.then(() => parse(e.data)).then((msg) => {
          if (!msg) return;
          if (msg.setupComplete !== undefined && !this.ready) {
            clearTimeout(timer);
            this.ready = true;
            ws.onerror = () => this.stop("error", "リアルタイム会話が切れました。");
            ws.onclose = (ev) => this.stop(ev.code === 1000 ? "closed" : "error", ev.reason || undefined);
            resolve();
            return;
          }
          this.onMessage(msg);
        }).catch(() => {});
      };
    });
  }

  private onMessage(msg: LiveServerMessage) {
    if (msg.toolCall?.functionCalls?.length) {
      void this.runTools(msg.toolCall.functionCalls);
      return;
    }
    if (msg.goAway !== undefined) {
      // 会話の時間切れが近い：いま話している分を言い終えたら閉じる（次は呼びかけでまたつなぐ）
      this.bumpIdle(3000);
      return;
    }
    const sc = msg.serverContent;
    if (!sc) return;
    if (sc.inputTranscription?.text) {
      this.userText += sc.inputTranscription.text;
      this.h.onUserText?.(this.userText.trim(), false);
      this.bumpIdle();
    }
    if (sc.interrupted) {
      // ユーザーが話し始めた：読み上げをすぐ止める
      this.stopPlayback();
      this.finishModel(true);
      this.setStatus("listening");
    }
    const parts = sc.modelTurn?.parts ?? [];
    for (const p of parts) {
      if (p.inlineData?.data && /^audio\//.test(p.inlineData.mimeType ?? "audio/pcm")) {
        this.flushUser();
        this.play(base64ToFloat32(p.inlineData.data), rateOf(p.inlineData.mimeType));
      }
    }
    if (sc.outputTranscription?.text) {
      this.flushUser();
      this.modelText += sc.outputTranscription.text;
      this.h.onModelText?.(this.modelText.trim(), false);
    }
    if (sc.turnComplete) {
      this.flushUser();
      this.finishModel(false);
      this.afterPlayback(() => this.setStatus("listening"));
      this.bumpIdle();
    }
  }

  /**
   * 画面で起きたこと（K.A.R.E.N. の制作が終わったなど）を AI に伝えて、声で知らせてもらう。
   * ユーザーの発言ではないことが分かるように、印を付けて渡す。
   */
  notify(text: string): void {
    if (this.ended || !this.ready) return;
    this.bumpIdle();
    this.send({ realtimeInput: { text: `［画面からのお知らせ（ユーザーの発言ではない）］${text}` } });
  }

  /** 話しかけが無くても、しばらく会話を閉じない（制作を待っている間など） */
  keepAlive(): void {
    if (!this.ended && this.stream) this.bumpIdle();
  }

  /** AI に頼まれた画面の操作をして、結果を返す */
  private async runTools(calls: { id?: string; name?: string; args?: Record<string, unknown> }[]) {
    this.flushUser();
    this.bumpIdle();
    const functionResponses = await Promise.all(
      calls.map(async (c) => {
        let response: Record<string, unknown>;
        try {
          response = this.h.onTool ? await this.h.onTool(c.name ?? "", c.args ?? {}) : { ok: false, error: "この操作はできません。" };
        } catch (err) {
          response = { ok: false, error: err instanceof Error ? err.message : "操作に失敗しました。" };
        }
        return { id: c.id, name: c.name, response };
      }),
    );
    if (!this.ended) this.send({ toolResponse: { functionResponses } });
  }

  /** ユーザーの発言を確定する（返事が始まった時点） */
  private flushUser() {
    if (!this.userText.trim()) return;
    this.h.onUserText?.(this.userText.trim(), true);
    this.userText = "";
  }

  private finishModel(stopped: boolean) {
    if (!this.modelText.trim()) {
      this.modelText = "";
      return;
    }
    this.h.onModelText?.(this.modelText.trim(), true, stopped);
    this.modelText = "";
  }

  private play(samples: Float32Array, rate: number) {
    const ctx = this.ctx;
    if (!ctx || !this.out || !samples.length) return;
    const buf = ctx.createBuffer(1, samples.length, rate);
    buf.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.out);
    const at = Math.max(ctx.currentTime + 0.02, this.nextAt);
    src.start(at);
    this.nextAt = at + buf.duration;
    this.playing.push(src);
    src.onended = () => {
      this.playing = this.playing.filter((s) => s !== src);
    };
    if (!this.releaseLevel) this.releaseLevel = trackSpeechNode(this.out);
    this.setStatus("speaking");
    this.bumpIdle();
  }

  /** 鳴らし終わったら fn（まだ鳴っていれば鳴り終わる時刻に） */
  private afterPlayback(fn: () => void) {
    clearTimeout(this.doneTimer);
    const left = this.ctx ? Math.max(0, this.nextAt - this.ctx.currentTime) : 0;
    this.doneTimer = window.setTimeout(() => {
      this.releaseLevel?.();
      this.releaseLevel = null;
      if (!this.ended) fn();
    }, left * 1000 + 50);
  }

  private stopPlayback() {
    for (const s of this.playing) {
      try {
        s.stop();
      } catch {
        /* noop */
      }
    }
    this.playing = [];
    if (this.ctx) this.nextAt = this.ctx.currentTime;
    clearTimeout(this.doneTimer);
    this.releaseLevel?.();
    this.releaseLevel = null;
  }

  private isPlaying(): boolean {
    return Boolean(this.ctx && this.nextAt > this.ctx.currentTime);
  }

  private startMic() {
    const ctx = this.ctx;
    if (!ctx || !this.stream) return;
    const source = ctx.createMediaStreamSource(this.stream);
    const proc = ctx.createScriptProcessor(2048, 1, 1);
    const mute = ctx.createGain();
    mute.gain.value = 0;
    source.connect(proc);
    proc.connect(mute);
    mute.connect(ctx.destination); // つながっていないと音の処理が動かない端末があるため（音は出さない）
    this.nodes = [source, proc, mute];
    proc.onaudioprocess = (e) => {
      if (this.ended) return;
      const input = e.inputBuffer.getChannelData(0);
      let sum = 0;
      for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
      const rms = Math.sqrt(sum / input.length);
      let small = downsample(input, ctx.sampleRate);
      // 話している間は、小さい音（スピーカーから回り込んだ自分の声）を無音にして送る
      // （会話を閉じるまでの時間は、物音ではなく、Gemini が言葉として聞き取ったときだけ延ばす）
      if (this.isPlaying() && rms < ECHO_GATE_RMS) small = new Float32Array(small.length);
      this.pending.push(small);
      this.pendingLen += small.length;
      if (!this.ready) {
        // つながるまでは直近 3 秒だけ取っておく
        while (this.pendingLen > IN_RATE * 3 && this.pending.length > 1) this.pendingLen -= this.pending.shift()!.length;
        return;
      }
      if (this.pendingLen < SEND_SAMPLES) return;
      const all = new Float32Array(this.pendingLen);
      let o = 0;
      for (const c of this.pending) {
        all.set(c, o);
        o += c.length;
      }
      this.pending = [];
      this.pendingLen = 0;
      this.send({ realtimeInput: { audio: { data: int16ToBase64(all), mimeType: `audio/pcm;rate=${IN_RATE}` } } });
    };
  }

  private bumpIdle(ms = LIVE_IDLE_MS) {
    clearTimeout(this.idleTimer);
    this.idleTimer = window.setTimeout(() => {
      if (this.ended) return;
      // 話している途中なら、言い終わるまで待つ
      if (this.isPlaying()) return this.bumpIdle(2000);
      this.stop("idle");
    }, ms);
  }

  private cleanup() {
    clearTimeout(this.idleTimer);
    clearTimeout(this.doneTimer);
    this.stopPlayback();
    for (const n of this.nodes) {
      try {
        n.disconnect();
      } catch {
        /* noop */
      }
    }
    this.nodes = [];
    try {
      this.out?.disconnect();
    } catch {
      /* noop */
    }
    this.out = null;
    if (this.ownStream) this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
      try {
        ws.close(1000);
      } catch {
        /* noop */
      }
    }
  }
}

async function parse(data: unknown): Promise<LiveServerMessage | null> {
  try {
    const text = typeof data === "string" ? data : data instanceof Blob ? await data.text() : data instanceof ArrayBuffer ? new TextDecoder().decode(data) : "";
    return text ? (JSON.parse(text) as LiveServerMessage) : null;
  } catch {
    return null;
  }
}
