/**
 * GET /api/edith/news?cat=news|research|market|travel|culture|tech|education|more
 *   → { ok, category, items: [{ title, summary, region, place, sources }], fetchedAt }
 * E.D.I.T.H. の REAL-TIME NEWS。Google 検索で調べ、実際に参照したページを出典に付ける（出典の無い話題は出さない）。
 */
import { EDITH_CATEGORIES, getEdithNews, type EdithCategory } from "@/integrations/edith-news";
import { getGeminiConfig } from "@/lib/config";
import { toFridayError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request): Promise<Response> {
  const headers = { "Cache-Control": "no-store" };
  const cat = new URL(req.url).searchParams.get("cat") ?? "news";
  if (!EDITH_CATEGORIES.includes(cat as EdithCategory)) {
    return Response.json({ ok: false, error: "分野の指定が正しくありません。" }, { status: 400, headers });
  }
  if (!getGeminiConfig().apiKey) {
    return Response.json({ ok: false, error: "Gemini API キーが設定されていないため、ニュースを取得できません。" }, { status: 503, headers });
  }
  try {
    return Response.json({ ok: true, ...(await getEdithNews(cat as EdithCategory, req.signal)) }, { headers });
  } catch (err) {
    return Response.json({ ok: false, error: toFridayError(err).message }, { status: 502, headers });
  }
}
