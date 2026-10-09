/**
 * リアルタイム音声会話（Gemini Live）から頼まれた F.R.I.D.A.Y. の操作の結果を、AI が短く伝えられる形にまとめる。
 * 操作そのもの（予定・メールの下書き・アプリを開くなど）は、これまでの会話の仕組みが行う。
 */
import type { UiMessage } from "@/hooks/useChat";

/** リアルタイム会話から頼まれた操作を待てる時間 */
export const ACTION_TIMEOUT_MS = 25_000;

/** 操作の結果を、リアルタイム会話の AI が短く伝えられる形にまとめる */
export function summarizeAction(m: UiMessage): Record<string, unknown> {
  const ok = (v: boolean, err?: string) => (v ? "成功" : `失敗${err ? `（${err}）` : ""}`);
  const verb = { add: "追加", update: "変更", delete: "削除" } as const;
  const done = [
    ...(m.calendar ?? []).map((c) => `予定の${verb[c.action]}：${c.title} ${c.when} ${ok(c.ok, c.error)}`),
    ...(m.actions ?? []).map((a) => `${a.label}：${ok(a.ok, a.error)}`),
    ...(m.drafts ?? []).map((d) => `Gmail の下書き「${d.subject}」：${d.ok ? "保存した（送信はしていない）" : ok(false, d.error)}`),
    ...(m.tabs ?? []).map(
      (t) => `${t.action === "open" ? "開く" : "閉じる"}：${t.label} ${t.ok ? (t.blocked ? "（画面に出た「開く」ボタンを押してもらう必要がある）" : "成功") : ok(false, t.error)}`,
    ),
    ...(m.music ?? []).map((x) => `音楽：${x.label} ${ok(x.ok, x.error)}`),
    ...(m.memories ?? []).map((x) => `覚えた：${x}`),
    ...(m.documents ?? []).map((d) => `文書「${d.title}」：${ok(d.ok, d.error)}`),
  ];
  return {
    ok: m.status === "done" && !m.error,
    result: m.content.replace(/\s+/g, " ").trim().slice(0, 400),
    ...(done.length ? { done } : {}),
    ...(m.error ? { error: m.error.message } : {}),
    ...(m.sources?.length ? { sources: m.sources.slice(0, 5).map((s) => s.title) } : {}),
  };
}
