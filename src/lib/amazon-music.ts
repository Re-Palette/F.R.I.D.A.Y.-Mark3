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
  const r = await askExtension({ type: "music", action: cmd.action, query: cmd.query, value: cmd.value ?? cmd.on }, cmd.query ? 25_000 : 5_000);
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
