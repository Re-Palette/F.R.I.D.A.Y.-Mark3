/**
 * Gmail（読むだけ）。Google カレンダーと同じ接続（更新用トークン）を使う。
 * 未読の受信メールの差出人・件名・冒頭を取り、会話で要約できるようにする。本文全体やメールの保存はしない。
 */
import { createHash } from "node:crypto";
import { accessToken, CalendarError, hasGmailScope } from "@/integrations/google-calendar";
import { swr } from "@/lib/swr";

export interface MailSummary {
  id: string;
  from: string;
  subject: string;
  snippet: string;
  /** 受信日時（ミリ秒） */
  at: number;
}

const apiBase = () => (process.env.GMAIL_API_BASE?.trim() || "https://gmail.googleapis.com/gmail/v1").replace(/\/+$/, "");

export const GMAIL_RECONNECT =
  "Gmail を読む許可がまだありません。Google Cloud で Gmail API を有効にしてから、画面右の SCHEDULE の「再接続」で Google にもう一度接続してください。";

async function gmail(refresh: string, path: string): Promise<Response> {
  const token = await accessToken(refresh);
  try {
    return await fetch(`${apiBase()}/users/me${path}`, {
      headers: { Authorization: `Bearer ${token}` },
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
