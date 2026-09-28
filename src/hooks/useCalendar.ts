"use client";

/**
 * Google カレンダーの今日の予定（右パネル用）。
 * 画面に戻ったとき・予定を追加したとき・5 分ごとに読み直す。
 */
import { useCallback, useEffect, useState } from "react";
import type { CalendarEventView, CalendarResponse } from "@/core/types";
import { CALENDAR_CHANGED } from "./useChat";

export type CalendarState = "loading" | "not-configured" | "disconnected" | "connected" | "error";

export function useCalendar() {
  const [state, setState] = useState<CalendarState>("loading");
  const [events, setEvents] = useState<CalendarEventView[]>([]);
  const [reason, setReason] = useState<string>();

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/calendar/events?days=1", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      const json = (await res.json()) as CalendarResponse;
      setReason(json.reason);
      if (!json.configured) setState("not-configured");
      else if (!json.connected) setState("disconnected");
      else if (json.events) {
        setEvents(json.events);
        setState("connected");
      } else setState("error");
    } catch {
      setState((s) => (s === "connected" ? s : "error"));
    }
  }, []);

  const disconnect = useCallback(async () => {
    await fetch("/api/calendar/disconnect", { method: "POST" }).catch(() => {});
    setEvents([]);
    void refresh();
  }, [refresh]);

  useEffect(() => {
    void refresh();
    const onChange = () => void refresh();
    window.addEventListener("focus", onChange);
    window.addEventListener(CALENDAR_CHANGED, onChange);
    const timer = setInterval(onChange, 5 * 60_000);
    return () => {
      window.removeEventListener("focus", onChange);
      window.removeEventListener(CALENDAR_CHANGED, onChange);
      clearInterval(timer);
    };
  }, [refresh]);

  return { state, events, reason, refresh, disconnect };
}
