/**
 * いま画面に浮かべている「〇〇の 3D ホログラム」の状態（作成中・表示中・拡大表示など）。
 * 会話（useChat）から頼まれ、Hologram と拡大表示の画面が読む。
 */
import { useSyncExternalStore } from "react";
import type { HoloModel } from "./hologram-schema";
import { resetView } from "./hologram-control";

export interface HoloState {
  status: "idle" | "loading" | "ready" | "error";
  subject?: string;
  model?: HoloModel;
  error?: string;
  /** 画面いっぱいに大きく表示しているか */
  expanded: boolean;
}

let state: HoloState = { status: "idle", expanded: false };
const listeners = new Set<() => void>();
let seq = 0;

function set(next: Partial<HoloState>) {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}

export function getHoloState(): HoloState {
  return state;
}

export function subscribeHolo(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useHoloState(): HoloState {
  return useSyncExternalStore(subscribeHolo, getHoloState, getHoloState);
}

/** 〇〇のホログラムを作って、大きく表示する */
export async function requestHologram(subject: string): Promise<void> {
  const id = ++seq;
  resetView();
  set({ status: "loading", subject, error: undefined, expanded: true });
  try {
    const res = await fetch("/api/hologram", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subject }),
    });
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; model?: HoloModel; error?: string };
    if (id !== seq) return; // 後から別のものを頼まれた
    if (!res.ok || !json.ok || !json.model) throw new Error(json.error ?? "ホログラムを作れませんでした。");
    set({ status: "ready", model: json.model });
  } catch (err) {
    if (id !== seq) return;
    set({ status: "error", error: err instanceof Error ? err.message : "ホログラムを作れませんでした。" });
  }
}

/** 作ったホログラムを消して、いつもの地球儀に戻す */
export function clearHologram(): void {
  seq++;
  resetView();
  set({ status: "idle", subject: undefined, model: undefined, error: undefined, expanded: false });
}

export function setHoloExpanded(expanded: boolean): void {
  set({ expanded });
}
