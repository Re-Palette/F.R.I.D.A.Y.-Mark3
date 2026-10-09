/**
 * いまの声の大きさ（0〜1）。HOME のコアと VOICE ACTIVITY の波形を、実際の声に合わせて揺らすために使う。
 *   - 音声モードがオンの間だけマイクを開き、音量だけを測る（音そのものは録音も送信もしない）
 *   - エコー除去つきで開くので、F.R.I.D.A.Y. 自身の読み上げはほとんど拾わない
 *   - F.R.I.D.A.Y. が話している間は、読み上げの音（ElevenLabs）の大きさを測って揺らす。
 *     測れないとき（ブラウザの声・iPhone など）は、話し声らしい揺れを作る
 * 毎フレーム読むので React の state ではなく、ただのオブジェクトで持つ。
 */
import { getAudioContext } from "./speech";
import { downsample } from "./recorded-recognition";
import { DoubleClapDetector } from "./clap";

export const voiceLevel = {
  /** 0〜1（なめらかにしてある） */
  value: 0,
  /** マイクの音量を測れているか */
  live: false,
  /** F.R.I.D.A.Y. が話しているか（音声会話の状態） */
  speaking: false,
  /** いま声を出しているか（音声会話の返事・お知らせの読み上げ。コアの動きを「話している」にする） */
  talking: false,
  /** 声の低い成分（〜300Hz・太さ）0〜1 */
  low: 0,
  /** 声の中くらいの成分（300〜2000Hz・母音）0〜1 */
  mid: 0,
  /** 声の高い成分（2000Hz〜・子音のシャ・サ）0〜1 */
  high: 0,
  /** 抑揚（声がいつもより高いと＋、低いと−）−1〜1 */
  inflection: 0,
  /** 音節の立ち上がりの強さ（立ち上がった瞬間に 1、すぐ減る）0〜1 */
  onset: 0,
  /** 音節が立ち上がった回数（増えたら、コアが光の波を 1 つ出す） */
  onsets: 0,
};

let stream: MediaStream | null = null;
let ctx: AudioContext | null = null;
let ownCtx = false;
let source: MediaStreamAudioSourceNode | null = null;
let analyser: AnalyserNode | null = null;
let buf = new Float32Array(512);
let raf = 0;
let starting: Promise<void> | null = null;
let wanted = false;
/** 読み上げの音の大きさを測る（読み上げの音声をここに通す） */
let speechAnalyser: AnalyserNode | null = null;
let speechBuf = new Float32Array(512);
const routed = new WeakSet<HTMLMediaElement>();
/** いま鳴っている読み上げ（音声モード以外のお知らせも含む） */
let speechCount = 0;
let speechEl: HTMLMediaElement | null = null;

/* ---------- 声の中身（大きさだけでなく、高さ・抑揚・音節の立ち上がり）。音そのものは保存も送信もしない ---------- */
let freq = new Uint8Array(256);
/** ゆっくり追いかける声の大きさ（これより急に大きくなったら音節の立ち上がり） */
let slowEnv = 0;
let lastOnset = 0;
/** 声の高さのふだんの位置（抑揚はここからのずれ） */
let pitchAvg = 0;
let pitchSpread = 0.08;
/** いま測っている声（マイクの声か、F.R.I.D.A.Y. の声か）。替わったら、ふだんの高さを覚え直す */
let pitchSource: "mic" | "speech" = "mic";
let lastNow = 0;

interface Shape {
  low: number;
  mid: number;
  high: number;
  /** 声の明るさ（スペクトルの重心）0〜1 */
  pitch: number;
}

/** 周波数ごとの強さから、低・中・高の成分と声の高さを出す */
function shapeOf(a: AnalyserNode): Shape {
  if (freq.length !== a.frequencyBinCount) freq = new Uint8Array(a.frequencyBinCount);
  a.getByteFrequencyData(freq);
  const hz = a.context.sampleRate / a.fftSize;
  let low = 0;
  let mid = 0;
  let high = 0;
  let nl = 0;
  let nm = 0;
  let nh = 0;
  let wsum = 0;
  let sum = 0;
  for (let i = 1; i < freq.length; i++) {
    const f = i * hz;
    if (f < 80) continue;
    if (f > 7000) break;
    const v = freq[i] / 255;
    if (f < 300) {
      low += v;
      nl++;
    } else if (f < 2000) {
      mid += v;
      nm++;
    } else {
      high += v;
      nh++;
    }
    if (f < 5000) {
      wsum += v * v * f;
      sum += v * v;
    }
  }
  const centroid = sum > 1e-4 ? wsum / sum : 0;
  return {
    low: nl ? Math.min(1, (low / nl) * 1.3) : 0,
    mid: nm ? Math.min(1, (mid / nm) * 1.4) : 0,
    high: nh ? Math.min(1, (high / nh) * 2.4) : 0,
    // 300Hz〜3000Hz を 0〜1 に
    pitch: centroid ? Math.min(1, Math.max(0, (centroid - 300) / 2700)) : 0,
  };
}

/* ---------- 声紋認証のための、直近の声（16kHz・約 8 秒）。画面の中だけに置き、保存も送信もしない ---------- */
const RING_RATE = 16_000;
const ring = new Float32Array(RING_RATE * 8);
let ringPos = 0;
let ringFilled = 0;
let captureWanted = false;
let capture: { proc: ScriptProcessorNode; mute: GainNode } | null = null;

function attachCapture() {
  if (capture || !captureWanted || !source || !ctx) return;
  try {
    const c = ctx;
    const proc = c.createScriptProcessor(2048, 1, 1);
    const mute = c.createGain();
    mute.gain.value = 0;
    proc.onaudioprocess = (e) => {
      const small = downsample(e.inputBuffer.getChannelData(0), c.sampleRate);
      for (let i = 0; i < small.length; i++) {
        ring[ringPos] = small[i];
        ringPos = (ringPos + 1) % ring.length;
      }
      ringFilled = Math.min(ring.length, ringFilled + small.length);
    };
    source.connect(proc);
    proc.connect(mute);
    mute.connect(c.destination); // つながっていないと動かないブラウザがあるため（音は出さない）
    capture = { proc, mute };
  } catch {
    capture = null;
  }
}

function detachCapture() {
  if (!capture) return;
  capture.proc.onaudioprocess = null;
  try {
    source?.disconnect(capture.proc);
  } catch {
    /* noop */
  }
  capture.proc.disconnect();
  capture.mute.disconnect();
  capture = null;
  ringFilled = 0;
}

/** 直近の声を取っておくか（声紋認証がオンの間だけ） */
export function setVoiceCapture(on: boolean): void {
  captureWanted = on;
  if (on) attachCapture();
  else detachCapture();
}

/** 直近 ms ミリ秒の声（16kHz）。取っていなければ null */
export function recentAudio(ms: number): Float32Array | null {
  if (!capture || !ringFilled) return null;
  const n = Math.min(ringFilled, Math.round((ms / 1000) * RING_RATE));
  const out = new Float32Array(n);
  const start = (ringPos - n + ring.length) % ring.length;
  for (let i = 0; i < n; i++) out[i] = ring[(start + i) % ring.length];
  return out;
}

/* ---------- 拍手 2 回で起動。マイクを開いている間だけ、音の大きさとザラつきを見て判定する（録音・送信しない） ---------- */
let clapHandler: (() => void) | null = null;
/** 1 回目の拍手で呼ぶ（起動の準備を先に始める） */
let clapPrime: (() => void) | null = null;
let clap: { proc: ScriptProcessorNode; mute: GainNode; from: MediaStreamAudioSourceNode } | null = null;
function attachClap() {
  // 拍手も声と同じマイクで聞く（同じマイクを加工なしでもう 1 本開くと、Chrome の声の聞き取りが音を受け取れなくなることがあったため）
  const from = source;
  if (clap || !clapHandler || !from || !ctx) return;
  try {
    const c = ctx;
    const detector = new DoubleClapDetector(
      c.sampleRate,
      () => clapHandler?.(),
      () => clapPrime?.(),
    );
    const proc = c.createScriptProcessor(1024, 1, 1);
    const mute = c.createGain();
    mute.gain.value = 0;
    // 裏のタブでも動くよう、画面の描画（requestAnimationFrame）ではなく音の処理の中で判定する
    proc.onaudioprocess = (e) => {
      // F.R.I.D.A.Y. が声を出している間は判定しない（自分の声・音楽の打音で起動しないように）
      if (speechCount > 0 || voiceLevel.speaking) {
        detector.reset();
        return;
      }
      detector.push(e.inputBuffer.getChannelData(0));
    };
    from.connect(proc);
    proc.connect(mute);
    mute.connect(c.destination); // つながっていないと動かないブラウザがあるため（音は出さない）
    clap = { proc, mute, from };
  } catch {
    clap = null;
  }
}

function detachClap() {
  if (!clap) return;
  clap.proc.onaudioprocess = null;
  try {
    clap.from.disconnect(clap.proc);
  } catch {
    /* noop */
  }
  clap.proc.disconnect();
  clap.mute.disconnect();
  clap = null;
}

/** 拍手 2 回で呼ぶ処理（null で止める）。マイクを開いている間（音声モードがオンの間）だけ聞く */
export function setClapHandler(handler: (() => void) | null, prime: (() => void) | null = null): void {
  clapHandler = handler;
  clapPrime = prime;
  if (handler) attachClap();
  else detachClap();
}

/** iPhone・iPad（読み上げの音を Web Audio に通すと鳴らなくなることがあるので、測らない） */
const isIOS = () =>
  typeof navigator !== "undefined" && (/iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));

function ensureLoop() {
  if (!raf) raf = requestAnimationFrame(loop);
}

/**
 * F.R.I.D.A.Y. が声を出し始めたときに呼ぶ（el は ElevenLabs の音声。ブラウザの声なら null）。終わったら返り値を呼ぶ。
 * 音声を Web Audio に通して大きさを測る（音はそのままスピーカーに出す）。通せないときは話し声らしい揺れで代わりにする。
 */
export function trackSpeech(el: HTMLMediaElement | null): () => void {
  speechCount++;
  ensureLoop();
  const ctx = getAudioContext();
  if (el && ctx && ctx.state === "running" && !isIOS()) {
    try {
      if (!speechAnalyser || speechAnalyser.context !== ctx) {
        speechAnalyser = ctx.createAnalyser();
        speechAnalyser.fftSize = 512;
        speechAnalyser.maxDecibels = -15; // 大きな声でも低・中・高の差が残るように
        speechBuf = new Float32Array(speechAnalyser.fftSize);
      }
      if (!routed.has(el)) {
        const src = ctx.createMediaElementSource(el);
        src.connect(ctx.destination);
        src.connect(speechAnalyser);
        routed.add(el);
      }
      speechEl = el;
    } catch {
      speechEl = null;
    }
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    speechCount = Math.max(0, speechCount - 1);
    if (speechEl === el) speechEl = null;
  };
}

function loop(now: number) {
  // マイクも読み上げも使っていなくて、揺れが収まったら止める（軽くするため）
  if (!wanted && !speechCount && !voiceLevel.speaking && voiceLevel.value < 0.005) {
    voiceLevel.value = 0;
    voiceLevel.talking = false;
    voiceLevel.low = voiceLevel.mid = voiceLevel.high = voiceLevel.inflection = voiceLevel.onset = 0;
    lastNow = 0;
    raf = 0;
    return;
  }
  raf = requestAnimationFrame(loop);
  voiceLevel.talking = speechCount > 0 || voiceLevel.speaking;
  const dt = lastNow ? Math.min(0.1, (now - lastNow) / 1000) : 1 / 60;
  lastNow = now;
  let target = 0;
  let shape: Shape | null = null;
  if (analyser && !document.hidden) {
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length);
    // -55dB で 0、-15dB で 1 くらいになるように
    target = Math.min(1, Math.max(0, (20 * Math.log10(rms + 1e-8) + 55) / 40));
    if (target > 0.08) shape = shapeOf(analyser);
  }
  if (speechCount > 0 && speechEl && speechAnalyser && !speechEl.paused && !document.hidden) {
    // 読み上げの実際の声の大きさ
    speechAnalyser.getFloatTimeDomainData(speechBuf);
    let sum = 0;
    for (let i = 0; i < speechBuf.length; i++) sum += speechBuf[i] * speechBuf[i];
    const rms = Math.sqrt(sum / speechBuf.length);
    const sp = Math.min(1, Math.max(0, (20 * Math.log10(rms + 1e-8) + 50) / 34));
    if (sp >= target) {
      target = sp;
      shape = sp > 0.08 ? shapeOf(speechAnalyser) : null;
    }
  } else if (voiceLevel.speaking || speechCount > 0) {
    // 話し声らしい揺れ（音節くらいの速さの山と、細かい揺らぎ）。高さ・抑揚もそれらしく作る
    const t = now / 1000;
    const syllable = Math.max(0, Math.sin(t * 11) * 0.6 + Math.sin(t * 4.3) * 0.4);
    const fake = 0.25 + syllable * 0.55;
    if (fake >= target) {
      target = fake;
      const lilt = Math.sin(t * 1.3) * 0.6 + Math.sin(t * 3.1) * 0.25;
      shape = { low: fake * 0.7, mid: fake, high: Math.max(0, Math.sin(t * 17)) * syllable * 0.6, pitch: 0.35 + lilt * 0.12 };
    }
  }
  // 上がるときは速く、下がるときはゆっくり（声の立ち上がりにすぐ反応して、ちらつかない）
  const k = target > voiceLevel.value ? 0.5 : 0.08;
  voiceLevel.value += (target - voiceLevel.value) * k;

  // 低・中・高の成分（無音のときは静かに 0 へ）
  const ease = (cur: number, to: number) => cur + (to - cur) * (to > cur ? 0.45 : 0.12);
  voiceLevel.low = ease(voiceLevel.low, shape?.low ?? 0);
  voiceLevel.mid = ease(voiceLevel.mid, shape?.mid ?? 0);
  voiceLevel.high = ease(voiceLevel.high, shape?.high ?? 0);

  // 抑揚：ふだんの声の高さを覚えておき、そこから上がったか下がったか
  // （あなたの声と F.R.I.D.A.Y. の声・拍手では高さがまったく違うので、替わったら覚え直す。そうしないと替わった瞬間に大きく揺れる）
  const source = voiceLevel.talking ? "speech" : "mic";
  if (source !== pitchSource) {
    pitchSource = source;
    pitchAvg = 0;
    pitchSpread = 0.08;
  }
  let inflect = 0;
  if (shape && shape.pitch > 0) {
    if (!pitchAvg) pitchAvg = shape.pitch;
    const d = shape.pitch - pitchAvg;
    pitchAvg += d * Math.min(1, dt * 0.6);
    pitchSpread += (Math.abs(d) - pitchSpread) * Math.min(1, dt * 0.4);
    inflect = Math.max(-1, Math.min(1, d / Math.max(0.04, pitchSpread * 2)));
  }
  voiceLevel.inflection += (inflect - voiceLevel.inflection) * Math.min(1, dt * 6);

  // 音節の立ち上がり：ゆっくり追う大きさより急に大きくなったら
  if (target - slowEnv > 0.14 && target > 0.2 && now - lastOnset > 110) {
    lastOnset = now;
    voiceLevel.onsets++;
    voiceLevel.onset = Math.min(1, Math.max(voiceLevel.onset, (target - slowEnv) * 2.2));
  }
  slowEnv += (target - slowEnv) * Math.min(1, dt * 7);
  voiceLevel.onset *= Math.exp(-dt * 7);
}

/** マイクの音量を測り始める（何度呼んでもよい） */
export function startVoiceLevel(): Promise<void> {
  wanted = true;
  ensureLoop();
  if (analyser || starting) return starting ?? Promise.resolve();
  starting = (async () => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
      if (!wanted) {
        s.getTracks().forEach((t) => t.stop());
        return;
      }
      stream = s;
      ctx = getAudioContext();
      ownCtx = !ctx;
      ctx ??= new AudioContext();
      await ctx.resume().catch(() => {});
      source = ctx.createMediaStreamSource(s);
      analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.maxDecibels = -15; // 大きな声でも低・中・高の差が残るように
      buf = new Float32Array(analyser.fftSize);
      // 測るだけ（スピーカーにはつながない）
      source.connect(analyser);
      attachCapture();
      attachClap();
      voiceLevel.live = true;
    } catch {
      // マイクを使えない環境では、話している間の揺れだけ
      voiceLevel.live = false;
    } finally {
      starting = null;
    }
  })();
  return starting;
}

/** マイクの音量を測るのをやめる */
export function stopVoiceLevel(): void {
  wanted = false;
  detachCapture();
  detachClap();
  source?.disconnect();
  source = null;
  analyser = null;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  if (ownCtx) void ctx?.close().catch(() => {});
  ctx = null;
  ownCtx = false;
  voiceLevel.live = false;
  voiceLevel.speaking = false;
  // お知らせを読み上げている間は揺れを続ける（止めるのはループが収まったとき）
  if (!speechCount) {
    voiceLevel.value = 0;
    voiceLevel.low = voiceLevel.mid = voiceLevel.high = voiceLevel.inflection = voiceLevel.onset = 0;
    lastNow = 0;
    cancelAnimationFrame(raf);
    raf = 0;
  }
}
