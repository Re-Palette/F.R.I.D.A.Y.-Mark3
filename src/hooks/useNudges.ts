"use client";

/**
 * 先回りの声かけの見張り役。数分ごとに /api/nudges を読み、時間になったものを 1 回だけ onFire に渡す。
 * 会話中（聞き取り・考え中・話し中）は割り込まず、終わってから話す。一度に話すのは 1 つ（1 分あける）。
 * 画面を開いている間だけ動く。オン / オフはこの端末だけの設定（SETTINGS）。
 */
import { useEffect, useRef } from "react";

export interface Nudge {
  id: string;
  at: number;
  until: number;
  text: string;
  kind: "calendar" | "todo" | "weather" | "project" | "depart";
  eventAt?: number;
}

export const NUDGES_KEY = "friday.nudges.v1";
const FIRED_KEY = "friday.nudges.fired.v1";

/** 先回りの声かけがオンか（既定はオン） */
export function nudgesEnabled(): boolean {
  try {
    return localStorage.getItem(NUDGES_KEY) !== "off";
  } catch {
    return true;
  }
}

function loadFired(): Record<string, number> {
  try {
    const v = JSON.parse(localStorage.getItem(FIRED_KEY) || "{}") as Record<string, number>;
    const cutoff = Date.now() - 3 * 24 * 60 * 60_000;
    return Object.fromEntries(Object.entries(v).filter(([, t]) => t > cutoff));
  } catch {
    return {};
  }
}

function saveFired(v: Record<string, number>) {
  try {
    localStorage.setItem(FIRED_KEY, JSON.stringify(v));
  } catch {
    /* noop */
  }
}

/** 話す文を仕上げる（{left} を「あと何分」に） */
export function nudgeText(n: Nudge, now = Date.now()): string {
  const left = n.eventAt ? Math.max(1, Math.round((n.eventAt - now) / 60_000)) : 0;
  return n.text.replace("{left}", String(left));
}

export function useNudges(onFire: (text: string, n: Nudge) => void, busy: () => boolean, enabled: boolean) {
  const list = useRef<Nudge[]>([]);
  const lastFired = useRef(0);
  const onFireRef = useRef(onFire);
  onFireRef.current = onFire;
  const busyRef = useRef(busy);
  busyRef.current = busy;

  useEffect(() => {
    if (!enabled) return;
    const load = async () => {
      try {
        const res = await fetch("/api/nudges", { cache: "no-store" });
        if (res.ok) list.current = ((await res.json()) as { nudges?: Nudge[] }).nudges ?? [];
      } catch {
        /* 次の回に */
      }
    };
    const tick = () => {
      if (!nudgesEnabled() || busyRef.current() || document.hidden) return;
      const now = Date.now();
      if (now - lastFired.current < 60_000) return;
      const fired = loadFired();
      const next = list.current.find((n) => n.at <= now && now < n.until && !fired[n.id]);
      if (!next) return;
      fired[next.id] = now;
      saveFired(fired);
      lastFired.current = now;
      onFireRef.current(nudgeText(next, now), next);
    };
    void load().then(tick);
    const poll = window.setInterval(() => void load(), 5 * 60_000);
    const timer = window.setInterval(tick, 20_000);
    const onFocus = () => void load().then(tick);
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(poll);
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [enabled]);
}
