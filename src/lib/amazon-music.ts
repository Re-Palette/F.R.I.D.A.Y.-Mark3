/**
 * Amazon Music の操作（画面側）。Chrome 拡張機能に頼み、開いている Amazon Music の Web プレーヤーのタブを操作する。
 * Amazon Music には個人で使える公開の API が無いため、ブラウザの中で操作する方式にしている。
 */
import type { AmazonMusicState, MusicCommand, NowPlaying } from "./music";
import { askExtension, extensionVersion, hasExtension, MUSIC_EXTENSION_VERSION, versionAtLeast } from "./tabs";

/** 拡張機能が入っているか・Amazon Music のタブで流れている曲（音楽の話のときにサーバーへ渡す） */
export async function amazonMusicState(): Promise<AmazonMusicState> {
  // 古い版（音楽の操作が無い）は「入っていない」扱いにして、入れ直しを案内する
  if (!(await hasExtension()) || !versionAtLeast(extensionVersion(), MUSIC_EXTENSION_VERSION)) return { ext: false };
  const r = await askExtension({ type: "music", action: "now" }, 1200);
  if (!r) return { ext: true };
  return { ext: true, now: (r.now as NowPlaying | null | undefined) ?? null };
}

const LABEL: Record<MusicCommand["action"], string> = {
  play: "再生",
  resume: "再生を再開",
  pause: "一時停止",
  next: "次の曲",
  previous: "前の曲",
  volume: "音量",
  shuffle: "シャッフル",
};

/** 操作して、画面に出す短い説明を返す */
export async function runAmazonMusic(cmd: MusicCommand): Promise<{ ok: boolean; label: string; error?: string }> {
  const r = await askExtension(
    { type: "music", action: cmd.action, query: cmd.query, kind: cmd.kind, value: cmd.value ?? cmd.on },
    cmd.query ? 60_000 : 5_000,
  );
  if (!r) return { ok: false, label: LABEL[cmd.action], error: "拡張機能から返事がありませんでした。拡張機能を最新版に入れ直してください。" };
  if (!r.ok) return { ok: false, label: cmd.query ?? LABEL[cmd.action], error: (r.error as string | undefined) ?? "Amazon Music を操作できませんでした。" };
  const label =
    typeof r.label === "string"
      ? r.label
      : cmd.action === "volume" && typeof r.volume === "number"
        ? `音量：${r.volume}%`
        : LABEL[cmd.action];
  return { ok: true, label };
}

/** 操作のあとに読み上げる短い返事（AI に聞かずに直接操作したとき） */
export function musicReply(cmd: MusicCommand, r: { ok: boolean; label: string }): string {
  if (cmd.action === "pause") return "止めました。";
  if (cmd.action === "resume") return "再開します。";
  if (cmd.action === "next") return "次の曲にします。";
  if (cmd.action === "previous") return "前の曲に戻します。";
  if (cmd.action === "volume") return `${r.label.replace("音量：", "音量を ")}にしました。`;
  return "了解です。";
}

let ducked = false;
/**
 * F.R.I.D.A.Y. が聞いている・話している間だけ、Amazon Music の音を小さくする（声を聞き取りやすく・聞こえやすくする）。
 * 拡張機能が無い・古いときは何もしない。
 */
export async function duckMusic(on: boolean): Promise<void> {
  if (on === ducked) return;
  if (!versionAtLeast(extensionVersion(), MUSIC_EXTENSION_VERSION)) return;
  ducked = on;
  await askExtension({ type: "music", action: "duck", value: on }, 2000);
}
