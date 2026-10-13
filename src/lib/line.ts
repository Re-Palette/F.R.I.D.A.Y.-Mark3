/**
 * LINE（Messaging API）から F.R.I.D.A.Y. に話しかける：受け取った通知を確かめ・読み解く部分（通信はしない）。
 *   - 通知が本物の LINE から来たかは、チャネルシークレットの署名（x-line-signature）で確かめる
 *   - 話してよい人は、環境変数 LINE_ALLOWED_USER_IDS に入れた LINE のユーザー ID だけ（ほかの人には ID の案内だけ返す）
 *   - 「メモ：〜」「記録して〜」は AI を通さず、そのまま脳（Obsidian）に書く
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** 通知の署名を確かめる（本文はそのままの文字列で） */
export function verifyLineSignature(secret: string, body: string, signature: string | null): boolean {
  if (!secret || !signature) return false;
  const expected = createHmac("sha256", secret).update(body, "utf8").digest();
  let got: Buffer;
  try {
    got = Buffer.from(signature, "base64");
  } catch {
    return false;
  }
  return got.length === expected.length && timingSafeEqual(got, expected);
}

export type LineIncoming =
  | { kind: "text"; userId: string; replyToken: string; text: string }
  | { kind: "audio"; userId: string; replyToken: string; messageId: string }
  | { kind: "image"; userId: string; replyToken: string; messageId: string }
  | { kind: "other"; userId: string; replyToken: string };

/** LINE のユーザー ID の形（U + 32 桁の 16 進数） */
export const LINE_USER_ID = /^U[0-9a-f]{32}$/;

/** 通知の本文から、1 対 1 のトークで届いたメッセージだけ取り出す（グループ・友だち追加などは捨てる） */
export function parseLineWebhook(raw: unknown): LineIncoming[] {
  const events = (raw as { events?: unknown } | null)?.events;
  if (!Array.isArray(events)) return [];
  const out: LineIncoming[] = [];
  for (const e of events as Record<string, unknown>[]) {
    if (!e || e.type !== "message" || (e.mode !== undefined && e.mode !== "active")) continue;
    const src = (e.source ?? {}) as Record<string, unknown>;
    if (src.type !== "user" || typeof src.userId !== "string" || !LINE_USER_ID.test(src.userId)) continue;
    if (typeof e.replyToken !== "string" || !e.replyToken) continue;
    const m = (e.message ?? {}) as Record<string, unknown>;
    const base = { userId: src.userId, replyToken: e.replyToken };
    const id = typeof m.id === "string" && /^\d{1,30}$/.test(m.id) ? m.id : null;
    if (m.type === "text" && typeof m.text === "string") out.push({ kind: "text", ...base, text: m.text.slice(0, 4000) });
    else if (m.type === "audio" && id) out.push({ kind: "audio", ...base, messageId: id });
    else if (m.type === "image" && id) out.push({ kind: "image", ...base, messageId: id });
    else out.push({ kind: "other", ...base });
  }
  return out;
}

/** 話してよい LINE のユーザー ID（環境変数 LINE_ALLOWED_USER_IDS。カンマ・空白区切り） */
export function allowedLineUsers(env: Record<string, string | undefined> = process.env): Set<string> {
  return new Set((env.LINE_ALLOWED_USER_IDS ?? "").split(/[\s,]+/).filter((x) => LINE_USER_ID.test(x)));
}

/** 「メモ：〜」「記録して 〜」「メモして〜」→ 書くこと（AI を通さず脳に書く）。違えば null */
export function parseMemoCommand(text: string): string | null {
  const t = text.trim();
  const m = /^(?:メモ|めも|記録|きろく|memo|note)(?:して|しといて|しておいて|お願い)?\s*[:：、,]?\s*([\s\S]+)$/i.exec(t);
  if (!m) return null;
  const body = m[1].trim();
  // 「メモして」だけ・「記録して何を話したか教えて」のような質問は AI に渡す
  if (!body || /^(を|は|の)/.test(body) || /^(して|しといて|しておいて|お願い)[。!！]?$/.test(body) || /[?？]$/.test(body)) return null;
  return body.slice(0, 2000);
}

/** LINE の 1 通の文字の上限（5000）に合わせて分ける。1 回に返せるのは 5 通まで */
export function splitForLine(text: string, max = 4900, maxMessages = 5): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest && out.length < maxMessages) {
    if (rest.length <= max) {
      out.push(rest);
      break;
    }
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.5) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest && out.length === maxMessages && out.join("").length < text.trim().length) {
    out[maxMessages - 1] = out[maxMessages - 1].slice(0, max - 20) + "\n…（続きは画面で）";
  }
  return out.length ? out : ["（返答が空でした）"];
}

/** 画面向けの書き方（Markdown）を LINE で読みやすくする（見出し・太字・リンクの記号を外す） */
export function plainForLine(md: string): string {
  return md
    .replace(/```[a-z]*\n?/gi, "")
    .replace(/^#{1,6}\s+/gm, "■ ")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, "$1（$2）")
    .replace(/^\s*[-*]\s+/gm, "・")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
