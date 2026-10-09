/**
 * GET /api/ai/health — AI Router 用の軽い確認。Gemini に実際に問い合わせて使えるかを返す（結果は数分キャッシュ）。
 * ローカル AI（Ollama）のつなぎ先（この PC の中の URL・既定のモデル名）も返す。どちらも秘密の値ではない（API キーは返さない）。
 */
import { getOllamaBaseUrl, getOllamaModel, serverLocalAi } from "@/lib/config";
import { checkGemini } from "@/llm/health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const error = await checkGemini();
  // レート制限は一時的で、サーバーが別のモデルに切り替えて答えられることがあるので「使える」扱い
  const ok = !error || error.code === "RATE_LIMITED";
  return Response.json(
    {
      gemini: ok ? { ok: true } : { ok: false, code: error.code, reason: error.message },
      local: { ollamaBaseUrl: getOllamaBaseUrl(), ollamaModel: getOllamaModel(), server: Boolean(serverLocalAi()) },
      at: Date.now(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
