/**
 * POST /api/warm — 入力中に呼ばれ、Gemini への接続を温めておく（応答は空）。
 */
import { warmGemini } from "@/llm/health";
import { isBrainConfigured } from "@/memory/github-brain";
import { warmBrain } from "@/memory/obsidian";
import { warmTts } from "@/voice/elevenlabs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(): Response {
  warmGemini();
  warmTts();
  if (isBrainConfigured()) warmBrain();
  return new Response(null, { status: 204 });
}
