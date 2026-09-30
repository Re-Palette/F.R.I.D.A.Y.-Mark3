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
  /** 作成中の段階（見た目を調べている／設計している） */
  step?: "research" | "design";
  /** 検索で調べた見た目の要点と参考ページ */
  brief?: { notes: string; sources: { title: string; uri: string }[] } | null;
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
  set({ status: "loading", subject, error: undefined, expanded: true, step: "research", brief: undefined });
  const post = (body: object) =>
    fetch("/api/hologram", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  try {
    // 1. 見た目を Google 検索で調べる（調べられなくても設計は続ける）
    const found = (await (await post({ subject, step: "research" })).json().catch(() => ({}))) as { brief?: HoloState["brief"] };
    if (id !== seq) return;
    const brief = found.brief ?? null;
    set({ step: "design", brief });
    // 2. 調べた結果をもとに設計する
    const res = await post({ subject, notes: brief?.notes });
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; model?: HoloModel; error?: string };
    if (id !== seq) return; // 後から別のものを頼まれた
    if (!res.ok || !json.ok || !json.model) throw new Error(json.error ?? "ホログラムを作れませんでした。");
    set({ status: "ready", model: json.model, step: undefined });
  } catch (err) {
    if (id !== seq) return;
    set({ status: "error", step: undefined, error: err instanceof Error ? err.message : "ホログラムを作れませんでした。" });
  }
}

/** 作ったホログラムを消して、いつもの地球儀に戻す */
export function clearHologram(): void {
  seq++;
  resetView();
  set({ status: "idle", subject: undefined, model: undefined, error: undefined, expanded: false, step: undefined, brief: undefined });
}

export function setHoloExpanded(expanded: boolean): void {
  set({ expanded });
}
