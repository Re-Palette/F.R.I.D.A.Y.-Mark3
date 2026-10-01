/**
 * いまの声の大きさ（0〜1）。HOME のコアと VOICE ACTIVITY の波形を、実際の声に合わせて揺らすために使う。
 *   - 音声モードがオンの間だけマイクを開き、音量だけを測る（音そのものは録音も送信もしない）
 *   - エコー除去つきで開くので、F.R.I.D.A.Y. 自身の読み上げはほとんど拾わない
 *   - F.R.I.D.A.Y. が話している間は、話し声らしい揺れを作る（読み上げの音は別の経路で鳴っていて測れないため）
 * 毎フレーム読むので React の state ではなく、ただのオブジェクトで持つ。
 */
import { getAudioContext } from "./speech";

export const voiceLevel = {
  /** 0〜1（なめらかにしてある） */
  value: 0,
  /** マイクの音量を測れているか */
  live: false,
  /** F.R.I.D.A.Y. が話しているか */
  speaking: false,
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

function loop(now: number) {
  raf = requestAnimationFrame(loop);
  let target = 0;
  if (analyser && !document.hidden) {
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length);
    // -55dB で 0、-15dB で 1 くらいになるように
    target = Math.min(1, Math.max(0, (20 * Math.log10(rms + 1e-8) + 55) / 40));
  }
  if (voiceLevel.speaking) {
    // 話し声らしい揺れ（音節くらいの速さの山と、細かい揺らぎ）
    const t = now / 1000;
    const syllable = Math.max(0, Math.sin(t * 11) * 0.6 + Math.sin(t * 4.3) * 0.4);
    target = Math.max(target, 0.25 + syllable * 0.55);
  }
  // 上がるときは速く、下がるときはゆっくり（声の立ち上がりにすぐ反応して、ちらつかない）
  const k = target > voiceLevel.value ? 0.5 : 0.08;
  voiceLevel.value += (target - voiceLevel.value) * k;
}

/** マイクの音量を測り始める（何度呼んでもよい） */
export function startVoiceLevel(): Promise<void> {
  wanted = true;
  if (!raf) raf = requestAnimationFrame(loop);
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
      buf = new Float32Array(analyser.fftSize);
      // 測るだけ（スピーカーにはつながない）
      source.connect(analyser);
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
  voiceLevel.value = 0;
  cancelAnimationFrame(raf);
  raf = 0;
}
