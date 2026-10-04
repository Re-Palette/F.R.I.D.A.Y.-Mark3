"use client";

/**
 * スマホの HOME の上に出す、必要最低限の 3 つ（スクロールなしで見られるように 1 行に並べる）。
 *   天気（いまの気温・降水確率）／次の予定／今日やること（期限が今日まで・過ぎたもの）
 * タップすると、それぞれの画面を開く。スマホのときだけ読み込む（パソコンでは使わない）。
 */
import { useEffect, useState } from "react";
import type { CalendarEventView } from "@/core/types";
import { useCalendar } from "@/hooks/useCalendar";
import { TASKS_CHANGED } from "@/hooks/useChat";
import type { Task } from "@/integrations/tasks";
import type { WeatherReport } from "@/integrations/weather";
import { Icon } from "../icons";
import { WEATHER_ICON } from "../RightPanel";
import type { View } from "../Sidebar";

const today = () => new Intl.DateTimeFormat("sv-SE").format(new Date());

function useWeather() {
  const [weather, setWeather] = useState<WeatherReport | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch("/api/weather", { cache: "no-store" })
        .then((r) => r.json() as Promise<{ ok: boolean; weather?: WeatherReport }>)
        .then((j) => alive && j.ok && j.weather && setWeather(j.weather))
        .catch(() => {});
    void load();
    const t = setInterval(load, 15 * 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  return weather;
}

function useTodos() {
  const [todos, setTodos] = useState<Task[] | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch("/api/projects", { cache: "no-store" })
        .then((r) => r.json() as Promise<{ configured: boolean; todos?: Task[] }>)
        .then((j) => alive && setTodos(j.configured ? (j.todos ?? []) : null))
        .catch(() => {});
    void load();
    const t = setInterval(load, 5 * 60_000);
    window.addEventListener(TASKS_CHANGED, load);
    return () => {
      alive = false;
      clearInterval(t);
      window.removeEventListener(TASKS_CHANGED, load);
    };
  }, []);
  return todos;
}

function useMinute() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

const endOf = (e: CalendarEventView) => Date.parse(e.end || e.start);

export function MobileBrief({ onNavigate }: { onNavigate: (v: View) => void }) {
  const weather = useWeather();
  const cal = useCalendar();
  const todos = useTodos();
  const now = useMinute();

  const day = weather?.days.find((d) => d.date === today()) ?? weather?.days[0];
  const next = cal.state === "connected" ? cal.events.find((e) => !e.allDay && endOf(e) > now) : undefined;
  const d = today();
  const due = todos?.filter((t) => t.due && t.due <= d) ?? [];
  const firstTodo = due[0] ?? todos?.[0];

  return (
    <div className="mbrief" role="group" aria-label="今日の要点">
      <div className="mbrief__tile">
        <span className="mbrief__label">WEATHER</span>
        {weather ? (
          <>
            <b className="mbrief__main">
              <Icon name={WEATHER_ICON[weather.kind]} size={15} /> {Math.round(weather.now)}°
            </b>
            <span className="mbrief__sub">{day ? `${day.label} · 雨${day.rain}%` : weather.label}</span>
          </>
        ) : (
          <span className="mbrief__sub">—</span>
        )}
      </div>

      <button type="button" className="mbrief__tile" onClick={() => onNavigate("calendar")}>
        <span className="mbrief__label">NEXT</span>
        {cal.state !== "connected" ? (
          <span className="mbrief__sub">{cal.state === "loading" ? "—" : "カレンダー未接続"}</span>
        ) : next ? (
          <>
            <b className="mbrief__main">{Date.parse(next.start) <= now ? "NOW" : next.timeLabel}</b>
            <span className="mbrief__sub">{next.title}</span>
          </>
        ) : (
          <>
            <b className="mbrief__main">—</b>
            <span className="mbrief__sub">今日の予定は終わり</span>
          </>
        )}
      </button>

      <button type="button" className="mbrief__tile" onClick={() => onNavigate("tasks")} data-alert={due.length > 0 || undefined}>
        <span className="mbrief__label">TODO</span>
        {todos === null ? (
          <span className="mbrief__sub">—</span>
        ) : (
          <>
            <b className="mbrief__main">
              {due.length > 0 ? due.length : todos.length}
              <small>{due.length > 0 ? " 今日まで" : " 件"}</small>
            </b>
            <span className="mbrief__sub">{firstTodo ? firstTodo.text : "やることはありません"}</span>
          </>
        )}
      </button>
    </div>
  );
}
