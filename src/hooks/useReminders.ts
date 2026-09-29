"use client";

/**
 * リマインダーの見張り役。時間になったら onFire を呼び、脳のリマインダーを完了にする。
 * 1 分ごと（と、リマインダーが追加されたとき）に一覧を読み直し、次のものに合わせてタイマーを掛ける。
 * 画面を開いている間だけ動く（閉じている間に過ぎたものは、次に開いたとき知らせる）。
 */
import { useCallback, useEffect, useRef } from "react";

export const REMINDERS_CHANGED = "friday:reminders-changed";

export interface DueReminder {
  id: string;
  at: number;
  label: string;
  text: string;
}

/** これより前に過ぎたものは「遅れて」知らせる（開いていなかった間の分） */
const LATE_LIMIT_MS = 12 * 60 * 60_000;

export function useReminders(onFire: (r: DueReminder, late: boolean) => void, enabled: boolean) {
  const fired = useRef(new Set<string>());
  const timer = useRef<number>(0);
  const onFireRef = useRef(onFire);
  onFireRef.current = onFire;

  const check = useCallback(async () => {
    let list: DueReminder[] = [];
    try {
      const res = await fetch("/api/reminders", { cache: "no-store" });
      if (!res.ok) return;
      list = ((await res.json()) as { reminders?: DueReminder[] }).reminders ?? [];
    } catch {
      return;
    }
    const now = Date.now();
    for (const r of list) {
      if (r.at > now || fired.current.has(r.id)) continue;
      fired.current.add(r.id);
      if (now - r.at < LATE_LIMIT_MS) onFireRef.current(r, now - r.at > 2 * 60_000);
      void fetch("/api/reminders/done", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: r.id }),
      }).catch(() => {});
    }
    // 次のリマインダーの時刻ちょうどにもう一度確認する
    window.clearTimeout(timer.current);
    const next = list.filter((r) => r.at > now && !fired.current.has(r.id)).sort((a, b) => a.at - b.at)[0];
    if (next && next.at - now < 70_000) timer.current = window.setTimeout(() => void check(), next.at - now + 300);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void check();
    const interval = window.setInterval(() => void check(), 60_000);
    const onChange = () => void check();
    window.addEventListener(REMINDERS_CHANGED, onChange);
    window.addEventListener("focus", onChange);
    return () => {
      window.clearInterval(interval);
      window.clearTimeout(timer.current);
      window.removeEventListener(REMINDERS_CHANGED, onChange);
      window.removeEventListener("focus", onChange);
    };
  }, [check, enabled]);
}
