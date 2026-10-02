/**
 * 集中モード（画面側）。「集中モード 50 分」→ タイマーを動かし、作業用の音楽をかけ、終わったら声で知らせて、脳に記録する。
 * タイマーはこのブラウザの中で動く（再読み込みしても続く）。音楽は Amazon Music（拡張機能があるとき）。
 */
import { useSyncExternalStore } from "react";

export { parseFocus, type FocusCommand } from "./focus-command";

export interface FocusState {
  task: string;
  minutes: number;
  startedAt: number;
  endsAt: number;
  /** 作業用の音楽をかけたか（終わったら止める） */
  music: boolean;
}


const KEY = "friday.focus.v1";
/** 終わったとき（または止めたとき）に知らせるイベント（detail: FocusEnd） */
export const FOCUS_END = "friday:focus-end";
export interface FocusEnd {
  state: FocusState;
  completed: boolean;
  /** 実際に集中した分数 */
  minutes: number;
}

let current: FocusState | null = null;
let loaded = false;
let timer = 0;
const watchers = new Set<() => void>();

function load() {
  if (loaded || typeof window === "undefined") return;
  loaded = true;
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || "null") as FocusState | null;
    if (v && typeof v.endsAt === "number") current = v;
  } catch {
    /* noop */
  }
  schedule();
}

function save() {
  try {
    if (current) localStorage.setItem(KEY, JSON.stringify(current));
    else localStorage.removeItem(KEY);
  } catch {
    /* noop */
  }
}

function publish() {
  save();
  schedule();
  watchers.forEach((w) => w());
}

function finish(completed: boolean) {
  const state = current;
  if (!state) return;
  current = null;
  publish();
  const minutes = Math.max(1, Math.round(((completed ? state.endsAt : Date.now()) - state.startedAt) / 60_000));
  window.dispatchEvent(new CustomEvent<FocusEnd>(FOCUS_END, { detail: { state, completed, minutes } }));
}

function schedule() {
  window.clearTimeout(timer);
  if (!current) return;
  // 終わる時刻にもう一度見る（閉じていた間に過ぎていたら、開いたときに知らせる）
  timer = window.setTimeout(() => {
    if (current && Date.now() >= current.endsAt - 500) finish(true);
    else schedule();
  }, Math.max(0, Math.min(current.endsAt - Date.now(), 60_000)));
}

export function getFocus(): FocusState | null {
  load();
  return current;
}

export function startFocus(minutes: number, task: string, music: boolean): FocusState {
  load();
  const m = Math.min(180, Math.max(1, Math.round(minutes)));
  const now = Date.now();
  current = { task: task.trim().slice(0, 60), minutes: m, startedAt: now, endsAt: now + m * 60_000, music };
  publish();
  return current;
}

/** 途中で止める（止めた分も記録する） */
export function stopFocus(): void {
  load();
  finish(false);
}

export function useFocus(): FocusState | null {
  return useSyncExternalStore(
    (fn) => {
      load();
      watchers.add(fn);
      return () => watchers.delete(fn);
    },
    () => current,
    () => null,
  );
}

/** 残り時間 "mm:ss" */
export function focusLeft(state: FocusState, now = Date.now()): string {
  const s = Math.max(0, Math.ceil((state.endsAt - now) / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
