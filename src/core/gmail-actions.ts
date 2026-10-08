/**
 * 返答に付いた隠しタグで頼まれた Gmail の下書きを作る（送信はしない）。
 *   <gmail-draft reply-to="メールの id">本文</gmail-draft>          そのメールへの返信の下書き
 *   <gmail-draft to="相手のアドレス" subject="件名">本文</gmail-draft>  新しいメールの下書き
 */
import type { StreamEvent } from "@/core/types";
import { CalendarError } from "@/integrations/google-calendar";
import type { DraftInput } from "@/integrations/gmail";

import { GMAIL_TAGS } from "./tag-names";
export { GMAIL_TAGS };
export type GmailTag = (typeof GMAIL_TAGS)[number];

type DraftEvent = Extract<StreamEvent, { type: "mail-draft" }>;

/** 1 つずつ下書きを作り、結果（と失敗時に本文へ足す一言）を返す */
export async function* runGmailActions(
  captures: Record<GmailTag, string[]>,
  attrs: Record<GmailTag, Record<string, string>[]>,
  draft: ((input: DraftInput) => Promise<{ to: string; subject: string }>) | undefined,
  signal?: AbortSignal,
): AsyncGenerator<{ event: DraftEvent; note?: string }> {
  for (const [i, body] of captures["gmail-draft"].entries()) {
    if (signal?.aborted) return;
    const a = attrs["gmail-draft"][i] ?? {};
    const input: DraftInput = { replyTo: a["reply-to"] || undefined, to: a.to || undefined, subject: a.subject || undefined, body };
    const label = { to: input.to ?? "", subject: input.subject ?? (input.replyTo ? "返信" : "") };
    let error: string;
    if (!draft) error = "Google に接続されていません。";
    else {
      try {
        const made = await draft(input);
        yield { event: { type: "mail-draft", ok: true, ...made } };
        continue;
      } catch (err) {
        error = err instanceof CalendarError ? err.message : "Gmail に下書きを保存できませんでした。";
      }
    }
    yield {
      event: { type: "mail-draft", ok: false, ...label, error },
      note: `（メールの下書きを保存できませんでした。${error}）`,
    };
  }
}
