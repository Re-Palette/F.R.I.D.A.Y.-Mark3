/**
 * GET /api/activity — HOME の「RECENT ACTIVITY」。脳の会話ログ（今日と昨日）から、最近のやり取りを新しい順に返す。
 */
import { getTimezone } from "@/lib/config";
import { isBrainConfigured, LOG_DIR, readFresh } from "@/memory/github-brain";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export interface ActivityItem {
  day: "today" | "yesterday";
  time: string;
  text: string;
  voice: boolean;
}

const ENTRY = /^###\s+(\d{1,2}:\d{2})(（音声）)?\s*\n\*\*あなた\*\*：(.+)$/gm;

export async function GET(): Promise<Response> {
  const headers = { "Cache-Control": "no-store" };
  if (!isBrainConfigured()) return Response.json({ configured: false, items: [] }, { headers });
  const tz = getTimezone();
  const day = (offset: number) => new Intl.DateTimeFormat("sv-SE", { timeZone: tz }).format(new Date(Date.now() - offset * 86_400_000));
  const items: ActivityItem[] = [];
  try {
    for (const [offset, label] of [[0, "today"], [1, "yesterday"]] as const) {
      const text = await readFresh(`${LOG_DIR}/${day(offset)}.md`);
      if (!text) continue;
      const found = [...text.matchAll(ENTRY)].map((m) => ({
        day: label,
        time: m[1].padStart(5, "0"),
        text: m[3].trim().replace(/\s+/g, " ").slice(0, 60),
        voice: Boolean(m[2]),
      }));
      items.push(...found.reverse());
      if (items.length >= 6) break;
    }
    return Response.json({ configured: true, items: items.slice(0, 6) }, { headers });
  } catch {
    return Response.json({ configured: true, error: true, items: [] }, { headers });
  }
}
