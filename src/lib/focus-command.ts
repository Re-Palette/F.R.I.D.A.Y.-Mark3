/**
 * 集中モードの指示（返答のタグ <focus>{...}</focus>）。サーバー・画面の両方で使う（依存なし）。
 */

export interface FocusCommand {
  start?: { minutes: number; task?: string; music?: boolean };
  stop?: boolean;
}

/** 返答のタグ <focus>{...}</focus> を読む */
export function parseFocus(raw: string): FocusCommand | null {
  try {
    const v = JSON.parse(raw.replace(/^```(?:json)?|```$/g, "").trim()) as Record<string, unknown>;
    if (v.stop === true) return { stop: true };
    const minutes = Number(v.minutes ?? 25);
    if (!Number.isFinite(minutes) || minutes <= 0) return null;
    return {
      start: {
        minutes: Math.min(180, Math.round(minutes)),
        task: typeof v.task === "string" ? v.task.slice(0, 60) : undefined,
        music: v.music !== false,
      },
    };
  } catch {
    return null;
  }
}
