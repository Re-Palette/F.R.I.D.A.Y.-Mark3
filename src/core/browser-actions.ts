/**
 * 返答に付いた隠しタグで頼まれた、ブラウザの操作（Web ページを開く・閉じる）。
 *   <open-url label="YouTube">https://www.youtube.com/</open-url>  新しいタブで開く
 *   <close-tab>last</close-tab> / <close-tab>all</close-tab>       F.R.I.D.A.Y. が開いたタブを閉じる
 * 実際に開く・閉じるのは画面（ブラウザ）側。ここでは URL を確かめてイベントにするだけ。
 */
import type { StreamEvent } from "@/core/types";

import { BROWSER_TAGS } from "./tag-names";
export { BROWSER_TAGS };

type BrowserEvent = Extract<StreamEvent, { type: "browser" }>;

/** http(s) の URL だけ通す（javascript: などは開かない）。日本語の検索語は自動でエンコードされる */
export function safeUrl(raw: string): string | null {
  const text = raw.trim().replace(/^<|>$/g, "");
  if (!text || text.length > 2000) return null;
  try {
    const url = new URL(/^[a-z][\w+.-]*:/i.test(text) ? text : `https://${text}`);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (!url.hostname.includes(".") || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function toBrowserEvent(tag: (typeof BROWSER_TAGS)[number], content: string, attrs: Record<string, string> = {}): BrowserEvent {
  if (tag === "close-tab") return { type: "browser", action: "close", target: /all|全部|すべて/i.test(content) ? "all" : "last" };
  const url = safeUrl(content);
  if (!url) return { type: "browser", action: "open", ok: false, label: attrs.label || content.slice(0, 60), error: "開けない URL でした。" };
  const label = (attrs.label || new URL(url).hostname.replace(/^www\./, "")).slice(0, 60);
  return { type: "browser", action: "open", ok: true, url, label };
}
