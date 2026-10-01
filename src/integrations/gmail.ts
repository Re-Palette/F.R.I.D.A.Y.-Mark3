/**
 * Gmail。Google カレンダーと同じ接続（更新用トークン）を使う。
 *   読む：未読の受信メールの差出人・件名・冒頭（会話で要約する）。返信を頼まれたときだけ直近のメールの本文も読む。
 *   書く：返信・新しいメールの「下書き」を作るだけ。送信・削除・既読にはしない（送るのはユーザーが Gmail で確認してから）。
 * メールの中身は保存しない。
 */
import { createHash } from "node:crypto";
import { accessToken, CalendarError, hasComposeScope, hasGmailScope } from "@/integrations/google-calendar";
import { swr } from "@/lib/swr";

export interface MailSummary {
  id: string;
  from: string;
  subject: string;
  snippet: string;
  /** 受信日時（ミリ秒） */
  at: number;
  /** 本文（返信を頼まれたときだけ。長いものは途中まで） */
  body?: string;
}

const apiBase = () => (process.env.GMAIL_API_BASE?.trim() || "https://gmail.googleapis.com/gmail/v1").replace(/\/+$/, "");

export const GMAIL_RECONNECT =
  "Gmail を読む許可がまだありません。Google Cloud で Gmail API を有効にしてから、画面右の SCHEDULE の「再接続」で Google にもう一度接続してください。";

async function gmail(refresh: string, path: string, init?: { method: "POST"; body: unknown }): Promise<Response> {
  const token = await accessToken(refresh);
  try {
    return await fetch(`${apiBase()}/users/me${path}`, {
      method: init?.method ?? "GET",
      headers: { Authorization: `Bearer ${token}`, ...(init ? { "Content-Type": "application/json" } : {}) },
      body: init ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(8000),
      cache: "no-store",
    });
  } catch {
    throw new CalendarError("GMAIL_NETWORK", "Gmail に接続できませんでした。");
  }
}

function gmailError(status: number): CalendarError {
  if (status === 401) return new CalendarError("CALENDAR_EXPIRED", "Google の接続が切れました。もう一度接続してください。", true);
  if (status === 403) return new CalendarError("GMAIL_FORBIDDEN", GMAIL_RECONNECT);
  return new CalendarError("GMAIL_UPSTREAM", `Gmail でエラーが発生しました（${status}）。`);
}

/** "山田 太郎 <taro@example.com>" → "山田 太郎" */
const displayName = (from: string) => from.replace(/\s*<[^>]+>\s*$/, "").replace(/^"|"$/g, "").trim() || from;

async function fetchUnread(refresh: string, max: number): Promise<MailSummary[]> {
  if (!(await hasGmailScope(refresh))) throw new CalendarError("GMAIL_FORBIDDEN", GMAIL_RECONNECT);
  const q = encodeURIComponent("is:unread in:inbox newer_than:3d -category:promotions -category:social");
  const res = await gmail(refresh, `/messages?q=${q}&maxResults=${max}`);
  if (!res.ok) throw gmailError(res.status);
  const ids = ((await res.json()) as { messages?: { id: string }[] }).messages ?? [];
  const items = await Promise.all(
    ids.map(async ({ id }) => {
      const r = await gmail(refresh, `/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`);
      if (!r.ok) return null;
      const m = (await r.json()) as { id: string; snippet?: string; internalDate?: string; payload?: { headers?: { name: string; value: string }[] } };
      const header = (name: string) => m.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
      return {
        id: m.id,
        from: displayName(header("From")),
        subject: header("Subject") || "（件名なし）",
        snippet: (m.snippet ?? "").replace(/\s+/g, " ").slice(0, 160),
        at: Number(m.internalDate ?? 0),
      } satisfies MailSummary;
    }),
  );
  return items.filter((x): x is MailSummary => x !== null).sort((a, b) => b.at - a.at);
}

/** 未読メール（2 分以内は前回の結果、30 分以内なら前回の結果を返しつつ裏で取り直す） */
export function unreadMail(refresh: string, max = 8): Promise<MailSummary[]> {
  const key = `gmail:${createHash("sha256").update(refresh).digest("hex").slice(0, 16)}:${max}`;
  return swr(key, 2 * 60_000, 30 * 60_000, () => fetchUnread(refresh, max));
}

/** メールについての発言か（「メール来てる？」「Gmail 確認して」など） */
export function asksForMail(text: string): boolean {
  return /メール|Gmail|gmail|ジーメール|受信(箱|トレイ)|届いて(る|い)/.test(text);
}

/* ---------- 返信の下書き ---------- */

export const GMAIL_COMPOSE_RECONNECT =
  "Gmail に下書きを作る許可がまだありません。画面右の SCHEDULE の「再接続」で Google にもう一度接続してください（送信はしません）。";

/** 返信・メールの下書きを頼んでいるか（「〇〇さんのメールに返信して」「〇〇にメールを書いて」など） */
export function asksForMailDraft(text: string): boolean {
  return /返信|返事を(書|作)|下書き/.test(text) || (asksForMail(text) && /(書いて|作って|送りたい|送る|出したい)/.test(text));
}

type Part = { mimeType?: string; body?: { data?: string }; parts?: Part[] };

const fromB64Url = (data: string) => Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");

/** メールの本文を文字で取り出す（text/plain を優先、無ければ HTML からタグを除く） */
function plainBody(part: Part | undefined): string {
  if (!part) return "";
  const walk = (p: Part, type: string): string | null => {
    if (p.mimeType === type && p.body?.data) return fromB64Url(p.body.data);
    for (const c of p.parts ?? []) {
      const hit = walk(c, type);
      if (hit) return hit;
    }
    return null;
  };
  const text = walk(part, "text/plain");
  if (text) return text;
  const html = walk(part, "text/html");
  return html ? html.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ") : "";
}

/** 直近 7 日の受信メール（既読も含む）を本文つきで。返信の下書きを頼まれたときだけ読む */
async function fetchRecent(refresh: string, max: number): Promise<MailSummary[]> {
  if (!(await hasGmailScope(refresh))) throw new CalendarError("GMAIL_FORBIDDEN", GMAIL_RECONNECT);
  const q = encodeURIComponent("in:inbox newer_than:7d -category:promotions -category:social");
  const res = await gmail(refresh, `/messages?q=${q}&maxResults=${max}`);
  if (!res.ok) throw gmailError(res.status);
  const ids = ((await res.json()) as { messages?: { id: string }[] }).messages ?? [];
  const items = await Promise.all(
    ids.map(async ({ id }): Promise<MailSummary | null> => {
      const r = await gmail(refresh, `/messages/${id}?format=full`);
      if (!r.ok) return null;
      const m = (await r.json()) as { id: string; snippet?: string; internalDate?: string; payload?: Part & { headers?: { name: string; value: string }[] } };
      const header = (name: string) => m.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
      const body = plainBody(m.payload)
        .replace(/\r/g, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim()
        .slice(0, 1500);
      return {
        id: m.id,
        from: header("From").replace(/\s+/g, " ").trim() || "（差出人不明）",
        subject: header("Subject") || "（件名なし）",
        snippet: (m.snippet ?? "").replace(/\s+/g, " ").slice(0, 160),
        at: Number(m.internalDate ?? 0),
        body,
      } satisfies MailSummary;
    }),
  );
  return items.filter((x): x is MailSummary => x !== null).sort((a, b) => b.at - a.at);
}

export function recentMail(refresh: string, max = 6): Promise<MailSummary[]> {
  const key = `gmail-recent:${createHash("sha256").update(refresh).digest("hex").slice(0, 16)}:${max}`;
  return swr(key, 60_000, 10 * 60_000, () => fetchRecent(refresh, max));
}

export interface DraftInput {
  /** 返信するメールの id（返信のとき） */
  replyTo?: string;
  /** 宛先のメールアドレス（新しいメールのとき） */
  to?: string;
  subject?: string;
  body: string;
}

/** ヘッダーに改行を入れさせない（別のヘッダーを差し込まれないように） */
const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ").trim();
/** 日本語の件名などは MIME の形にする */
const mimeWord = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`);
const ADDRESS = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;
/** "山田 <taro@example.com>" → "taro@example.com" */
const addressOf = (v: string) => (/<([^>]+)>/.exec(v)?.[1] ?? v).trim();

/** 下書きを作る（送信はしない）。作った下書きの宛先と件名を返す */
export async function createDraft(refresh: string, input: DraftInput): Promise<{ to: string; subject: string }> {
  if (!(await hasComposeScope(refresh))) throw new CalendarError("GMAIL_COMPOSE_FORBIDDEN", GMAIL_COMPOSE_RECONNECT);
  const body = input.body.replace(/\r\n?/g, "\n").trim();
  if (!body) throw new CalendarError("GMAIL_DRAFT_EMPTY", "下書きの本文が空でした。");

  let to = addressOf(oneLine(input.to ?? ""));
  let subject = oneLine(input.subject ?? "");
  const extra: string[] = [];
  let threadId: string | undefined;
  if (input.replyTo) {
    const id = input.replyTo.replace(/[^\w-]/g, "");
    const names = ["From", "Reply-To", "Subject", "Message-ID", "References"].map((h) => `metadataHeaders=${h}`).join("&");
    const res = await gmail(refresh, `/messages/${id}?format=metadata&${names}`);
    if (res.status === 404) throw new CalendarError("GMAIL_DRAFT_NOT_FOUND", "返信するメールが見つかりませんでした。");
    if (!res.ok) throw gmailError(res.status);
    const m = (await res.json()) as { threadId?: string; payload?: { headers?: { name: string; value: string }[] } };
    const header = (name: string) => oneLine(m.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "");
    to = addressOf(header("Reply-To") || header("From"));
    const original = header("Subject");
    subject = /^re:/i.test(original) ? original : `Re: ${original}`;
    const messageId = header("Message-ID");
    if (messageId) extra.push(`In-Reply-To: ${messageId}`, `References: ${[header("References"), messageId].filter(Boolean).join(" ")}`);
    threadId = m.threadId;
  }
  if (!ADDRESS.test(to)) throw new CalendarError("GMAIL_DRAFT_TO", "宛先のメールアドレスが分かりませんでした。アドレスを教えてください。");
  if (!subject) subject = "（件名なし）";

  const encodedBody = Buffer.from(body.replace(/\n/g, "\r\n"), "utf8").toString("base64").replace(/.{76}/g, "$&\r\n");
  const raw = [
    `To: ${to}`,
    `Subject: ${mimeWord(subject)}`,
    ...extra,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    encodedBody,
  ].join("\r\n");
  const res = await gmail(refresh, "/drafts", {
    method: "POST",
    body: { message: { raw: Buffer.from(raw, "utf8").toString("base64url"), ...(threadId ? { threadId } : {}) } },
  });
  if (!res.ok) throw res.status === 403 ? new CalendarError("GMAIL_COMPOSE_FORBIDDEN", GMAIL_COMPOSE_RECONNECT) : gmailError(res.status);
  return { to, subject };
}
