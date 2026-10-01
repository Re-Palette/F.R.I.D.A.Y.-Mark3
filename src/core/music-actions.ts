/**
 * 返答に付いた隠しタグで頼まれた音楽の操作（Spotify）を実行する。
 *   <music>{"action":"play","query":"作業用 BGM","kind":"playlist"}</music>   探して再生
 *   <music>{"action":"pause"}</music> / next / previous / resume
 *   <music>{"action":"volume","value":30}</music>（"up" / "down" も可）
 *   <music>{"action":"shuffle","on":true}</music>
 */
import type { StreamEvent } from "@/core/types";
import { SpotifyError, type MusicCommand, type SpotifyAccess } from "@/integrations/spotify";

export const MUSIC_TAGS = ["music"] as const;
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

/** 1 つずつ実行し、結果（と失敗時に本文へ足す一言）を返す */
export async function* runMusicActions(
  captures: Record<MusicTag, string[]>,
  spotify: SpotifyAccess | undefined,
  signal?: AbortSignal,
): AsyncGenerator<{ event: MusicEvent; note?: string }> {
  for (const raw of captures.music.slice(0, 2)) {
    if (signal?.aborted) return;
    const cmd = parse(raw);
    let error: string;
    if (!spotify) error = "Spotify に接続されていません（SETTINGS の SPOTIFY から接続できます）。";
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
