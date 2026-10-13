/**
 * POST /api/line/webhook — LINE（Messaging API）からの通知の受け口。
 *   合言葉のロックの外（LINE は Cookie を持たない）。代わりに、チャネルシークレットの署名（x-line-signature）で
 *   本物の LINE から来たかを確かめる。話してよい人は LINE_ALLOWED_USER_IDS の人だけ（src/integrations/line.ts）。
 *   LINE にはすぐ 200 を返し、答えは返し終えてから作って送る（返事の権利 replyToken で。切れていたら push）。
 */
import { after } from "next/server.js";
import { answerLine, lineConfig, sendLine, showLoading } from "@/integrations/line";
import { allowedLineUsers, parseLineWebhook, verifyLineSignature } from "@/lib/line";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request): Promise<Response> {
  const cfg = lineConfig();
  if (!cfg) return Response.json({ ok: false, error: "LINE の設定がありません（LINE_CHANNEL_SECRET・LINE_CHANNEL_ACCESS_TOKEN）" }, { status: 503 });
  const body = await req.text();
  if (!verifyLineSignature(cfg.secret, body, req.headers.get("x-line-signature"))) {
    return Response.json({ ok: false, error: "署名が正しくありません" }, { status: 401 });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return Response.json({ ok: false, error: "形式が正しくありません" }, { status: 400 });
  }
  // LINE の「接続確認」は events が空で届く。200 を返すだけ
  const incoming = parseLineWebhook(raw);
  if (incoming.length) {
    const allowed = allowedLineUsers();
    after(async () => {
      for (const ev of incoming) {
        if (allowed.has(ev.userId)) await showLoading(cfg.token, ev.userId);
        try {
          const texts = await answerLine(ev);
          await sendLine(cfg.token, ev, texts);
        } catch (err) {
          console.warn("[line] answer failed:", err instanceof Error ? err.message : err);
          await sendLine(cfg.token, ev, ["エラーが起きて答えられませんでした。少し待ってから、もう一度送ってください。"]);
        }
      }
    });
  }
  return Response.json({ ok: true });
}
