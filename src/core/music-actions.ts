/**
 * 返答に付いた隠しタグで頼まれた音楽の操作（Spotify）を実行する。
 *   <music>{"action":"play","query":"作業用 BGM","kind":"playlist"}</music>   探して再生
 *   <music>{"action":"pause"}</music> / next / previous / resume
 *   <music>{"action":"volume","value":30}</music>（"up" / "down" も可）
 *   <music>{"action":"shuffle","on":true}</music>
 */
import type { StreamEvent } from "@/core/types";
import { SpotifyError, type SpotifyAccess } from "@/integrations/spotify";
import type { MusicCommand } from "@/lib/music";

import { MUSIC_TAGS } from "./tag-names";
export { MUSIC_TAGS };
export type MusicTag = (typeof MUSIC_TAGS)[number];

type MusicEvent = Extract<StreamEvent, { type: "music" }>;
const ACTIONS = new Set(["play", "pause", "resume", "next", "previous", "volume", "shuffle"]);

function parse(raw: string): MusicCommand | null {
  try {
    const v = JSON.parse(raw.replace(/^```(?:json)?|```$/g, "").trim()) as Record<string, unknown>;
    if (!v || typeof v !== "object" || !ACTIONS.has(String(v.action))) return null;
    return {
      action: v.action as MusicCommand["action"],
      query: typeof v.query === "string" ? v.query.slice(0, 100) : undefined,
      kind: typeof v.kind === "string" ? (v.kind as MusicCommand["kind"]) : undefined,
      value: v.value === "up" || v.value === "down" ? v.value : typeof v.value === "number" ? v.value : undefined,
      on: typeof v.on === "boolean" ? v.on : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * 1 つずつ実行し、結果（と失敗時に本文へ足す一言）を返す。
 * Spotify に接続していればここで実行し、していなければ Amazon Music の操作として画面に渡す（拡張機能が実行する）。
 */
export async function* runMusicActions(
  captures: Record<MusicTag, string[]>,
  spotify: SpotifyAccess | undefined,
  amazonExt: boolean,
  signal?: AbortSignal,
): AsyncGenerator<{ event: MusicEvent; note?: string }> {
  for (const raw of captures.music.slice(0, 2)) {
    if (signal?.aborted) return;
    const cmd = parse(raw);
    if (cmd && !spotify && amazonExt) {
      yield { event: { type: "music", ok: true, label: cmd.query ?? cmd.action, command: cmd } };
      continue;
    }
    let error: string;
    if (!spotify) error = "Amazon Music を操作するには、F.R.I.D.A.Y. の拡張機能（SETTINGS の BROWSER）が必要です。";
    else if (!cmd) error = "音楽の操作を読み取れませんでした。";
    else {
      try {
        yield { event: { type: "music", ok: true, label: await spotify.run(cmd) } };
        continue;
      } catch (err) {
        error = err instanceof SpotifyError ? err.message : "Spotify を操作できませんでした。";
      }
    }
    yield { event: { type: "music", ok: false, label: cmd?.query ?? cmd?.action ?? "音楽", error }, note: `（${error}）` };
  }
}
