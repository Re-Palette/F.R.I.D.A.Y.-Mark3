/**
 * GET /api/push/keys — 最初の設定用に、プッシュ通知の鍵のペアを作って表示する（まだ設定されていないときだけ）。
 * 表示された 2 つを Vercel の環境変数 VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY に入れる。
 * この画面は合言葉でログインした人しか開けない。
 */
import { generateKeys, getPushConfig } from "@/integrations/push";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(): Response {
  if (getPushConfig().configured) {
    return new Response("プッシュ通知の鍵はすでに設定されています。", { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
  const { publicKey, privateKey } = generateKeys();
  const html = `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>プッシュ通知の鍵</title>
<body style="background:#050608;color:#eef0f3;font-family:system-ui,sans-serif;padding:24px;line-height:1.7;max-width:760px;margin:auto">
<h1 style="color:#ffb458;font-size:20px">プッシュ通知の鍵（1 回だけ表示）</h1>
<p>下の 2 つを Vercel の Settings → Environment Variables に追加して、Redeploy してください。<br>
この画面を開き直すと別の鍵になります（どちらか 1 組を使えば大丈夫です）。<b>チャットには貼らないでください。</b></p>
<p><b>VAPID_PUBLIC_KEY</b><br><textarea readonly style="width:100%;height:70px;background:#111;color:#fff">${publicKey}</textarea></p>
<p><b>VAPID_PRIVATE_KEY</b><br><textarea readonly style="width:100%;height:50px;background:#111;color:#fff">${privateKey}</textarea></p>
</body></html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}
