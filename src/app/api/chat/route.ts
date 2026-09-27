/**
 * POST /api/chat — F.R.I.D.A.Y. との会話（NDJSON ストリーミング）。
 * Gemini API キーはサーバー側でのみ使用し、ブラウザには一切渡さない。
 */
import { handleConversation, preflight, sanitizeHistory } from "@/core/friday";
import type { StreamEvent } from "@/core/types";
import { toFridayError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorResponse(err: unknown): Response {
  const e = toFridayError(err);
  const event: StreamEvent = { type: "error", code: e.code, message: e.message, retryable: e.retryable };
  return Response.json(event, { status: e.status });
}

export async function POST(req: Request): Promise<Response> {
  let history;
  try {
    const body = (await req.json()) as { messages?: unknown };
    history = sanitizeHistory(body?.messages);
    preflight();
  } catch (err) {
    if (err instanceof SyntaxError) {
      return Response.json(
        { type: "error", code: "BAD_REQUEST", message: "リクエストの形式が不正です。", retryable: false },
        { status: 400 },
      );
    }
    return errorResponse(err);
  }

  const encoder = new TextEncoder();
  const events = handleConversation(history, req.signal);

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await events.next();
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(JSON.stringify(value) + "\n"));
      } catch {
        controller.close();
      }
    },
    async cancel() {
      await events.return(undefined);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
