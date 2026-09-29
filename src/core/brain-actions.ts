/**
 * 返答に付いた隠しタグで頼まれた、脳（Obsidian）への書き込みを実行する。
 *   <todo-add>{"text","project","due"}</todo-add>         ToDo を追加
 *   <todo-done>{"text"}</todo-done>                        ToDo を完了
 *   <project-progress>{"project","progress"}</project-progress>  進捗（%）を記録
 *   <reminder>{"at":"YYYY-MM-DDTHH:MM","text"}</reminder>  リマインダーを追加
 */
import type { StreamEvent } from "@/core/types";
import { addReminder } from "@/integrations/reminders";
import { addTodo, completeTodo, setProgress } from "@/integrations/tasks";

export const BRAIN_TAGS = ["todo-add", "todo-done", "project-progress", "reminder"] as const;
export type BrainTag = (typeof BRAIN_TAGS)[number];

type ActionEvent = Extract<StreamEvent, { type: "action" }>;

const VERB: Record<BrainTag, string> = {
  "todo-add": "ToDo に追加",
  "todo-done": "ToDo を完了に",
  "project-progress": "進捗を記録",
  reminder: "リマインダーを設定",
};

function parseJson(raw: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(raw.replace(/^```(?:json)?|```$/g, "").trim()) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function perform(tag: BrainTag, v: Record<string, unknown>): Promise<string> {
  switch (tag) {
    case "todo-add": {
      const t = await addTodo(v);
      return `${t.project ? `${t.project}: ` : ""}${t.text}${t.due ? `（期限 ${t.due}）` : ""}`;
    }
    case "todo-done":
      return (await completeTodo(v)).text;
    case "project-progress": {
      const p = await setProgress(v);
      return `${p.name} ${p.progress}%`;
    }
    case "reminder": {
      const r = await addReminder(v);
      return `${r.label} ${r.text}`;
    }
  }
}

/** 1 つずつ実行し、結果（と失敗時に本文へ足す一言）を返す */
export async function* runBrainActions(
  captures: Record<BrainTag, string[]>,
  canWrite: boolean,
  signal?: AbortSignal,
): AsyncGenerator<{ event: ActionEvent; note?: string }> {
  for (const tag of BRAIN_TAGS) {
    for (const raw of captures[tag]) {
      if (signal?.aborted) return;
      const v = parseJson(raw);
      let error: string;
      if (!canWrite) error = "脳（Obsidian）が接続されていないため保存できません。";
      else if (!v) error = "内容を読み取れませんでした。";
      else {
        try {
          yield { event: { type: "action", kind: tag, ok: true, label: await perform(tag, v) } };
          continue;
        } catch (err) {
          error = err instanceof Error ? err.message : "脳に保存できませんでした。";
        }
      }
      const label = typeof v?.text === "string" ? v.text : typeof v?.project === "string" ? v.project : "";
      yield {
        event: { type: "action", kind: tag, ok: false, label, error },
        note: `（${VERB[tag]}できませんでした。${error}）`,
      };
    }
  }
}
