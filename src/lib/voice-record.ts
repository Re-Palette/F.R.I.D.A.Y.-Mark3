/**
 * 声紋の登録・確認のために、マイクの声を決まった秒数だけ録る（16kHz）。
 * 録った声は画面の中で声紋の数字にするだけで、保存も送信もしない。
 */
import { downsample } from "./recorded-recognition";
import { getAudioContext } from "./speech";

export async function recordVoice(seconds: number, onLevel?: (level: number, progress: number) => void): Promise<Float32Array> {
  const ctx = getAudioContext() ?? new AudioContext();
  if (ctx.state !== "running") await ctx.resume().catch(() => {});
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
  });
  const source = ctx.createMediaStreamSource(stream);
  const proc = ctx.createScriptProcessor(2048, 1, 1);
  const mute = ctx.createGain();
  mute.gain.value = 0;
  source.connect(proc);
  proc.connect(mute);
  mute.connect(ctx.destination);
  const want = Math.round(seconds * 16_000);
  const out = new Float32Array(want);
  let filled = 0;
  try {
    await new Promise<void>((resolve) => {
      proc.onaudioprocess = (e) => {
        const input = e.inputBuffer.getChannelData(0);
        let sum = 0;
        for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
        const small = downsample(input, ctx.sampleRate);
        const n = Math.min(small.length, want - filled);
        out.set(small.subarray(0, n), filled);
        filled += n;
        onLevel?.(Math.min(1, Math.sqrt(sum / input.length) * 8), filled / want);
        if (filled >= want) resolve();
      };
    });
  } finally {
    proc.onaudioprocess = null;
    source.disconnect();
    proc.disconnect();
    mute.disconnect();
    stream.getTracks().forEach((t) => t.stop());
  }
  return out;
}
