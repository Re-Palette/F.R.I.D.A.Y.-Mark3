/**
 * POST /api/login — 合言葉を確認し、正しければログイン Cookie を発行する。
 */
import { AUTH_COOKIE, AUTH_MAX_AGE, getAuthMode, safeEqual, sessionToken } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  const mode = getAuthMode();
  if (mode === "misconfigured") {
    return Response.json(
      { ok: false, message: "合言葉がまだ設定されていません。Vercel の環境変数 FRIDAY_PASSCODE を設定してください。" },
      { status: 503 },
    );
  }

  let passcode = "";
  try {
    const body = (await req.json()) as { passcode?: unknown };
    passcode = typeof body.passcode === "string" ? body.passcode.trim() : "";
  } catch {
    /* noop */
  }

  const expected = process.env.FRIDAY_PASSCODE?.trim() ?? "";
  if (mode === "locked" && !safeEqual(passcode, expected)) {
    await new Promise((r) => setTimeout(r, 600)); // 総当たり対策
    return Response.json({ ok: false, message: "合言葉が違います。" }, { status: 401 });
  }

  const res = Response.json({ ok: true });
  res.headers.append(
    "Set-Cookie",
    `${AUTH_COOKIE}=${await sessionToken()}; Path=/; Max-Age=${AUTH_MAX_AGE}; HttpOnly; SameSite=Lax${
      process.env.NODE_ENV === "production" ? "; Secure" : ""
    }`,
  );
  return res;
}
