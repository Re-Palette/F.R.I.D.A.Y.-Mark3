/**
 * いま画面に浮かべている「〇〇の 3D ホログラム」の状態（作成中・表示中・拡大表示など）。
 * まず既存の 3D モデル（Poly Pizza）を探し、無ければ Gemini に部品で組み立てさせる。
 * 会話（useChat）から頼まれ、Hologram と拡大表示の画面が読む。
 */
import { useSyncExternalStore } from "react";
import type { HoloAsset, HoloModel } from "./hologram-schema";
import { resetView } from "./hologram-control";

export interface HoloState {
  status: "idle" | "loading" | "ready" | "error";
  subject?: string;
  model?: HoloModel;
  /** 既存の 3D モデルを使うとき（buffer は読み込んだ .glb の中身） */
  asset?: HoloAsset & { buffer: ArrayBuffer };
  error?: string;
  /** 作成中の段階（3D モデルを探している／見た目を調べている／設計している） */
  step?: "find" | "research" | "design";
  /** 検索で調べた見た目の要点と参考ページ */
  brief?: { notes: string; sources: { title: string; uri: string }[] } | null;
  /** 画面いっぱいに大きく表示しているか */
  expanded: boolean;
  /** ホログラムを見せながらの説明（その返答の文を、拡大表示の画面に字幕のように出す） */
  explain?: { forId: string; text: string };
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
export async function requestHologram(subject: string, opts: { skipFind?: boolean; explainFor?: string } = {}): Promise<void> {
  const id = ++seq;
  resetView();
  set({
    status: "loading",
    subject,
    error: undefined,
    expanded: true,
    step: "find",
    brief: undefined,
    model: undefined,
    asset: undefined,
    ...(opts.skipFind ? {} : { explain: opts.explainFor ? { forId: opts.explainFor, text: "" } : undefined }),
  });
  const post = (body: object) =>
    fetch("/api/hologram", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  try {
    // 0. 既存の 3D モデルを探す（見つかれば、それをホログラムにする。だめなら部品で組み立てる）
    const hit = opts.skipFind
      ? {}
      : ((await (await post({ subject, step: "find" })).json().catch(() => ({}))) as { asset?: HoloAsset | null });
    if (id !== seq) return;
    if (hit.asset) {
      const buffer = await downloadAsset(hit.asset.url);
      if (id !== seq) return;
      if (buffer) {
        set({ status: "ready", asset: { ...hit.asset, buffer }, step: undefined });
        return;
      }
    }
    set({ step: "research" });
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
    set({ status: "ready", model: json.model, asset: undefined, step: undefined });
  } catch (err) {
    if (id !== seq) return;
    set({ status: "error", step: undefined, error: err instanceof Error ? err.message : "ホログラムを作れませんでした。" });
  }
}

/** .glb を読み込む（まず直接、だめならサーバーの中継から）。読めなければ null */
export async function downloadAsset(url: string): Promise<ArrayBuffer | null> {
  for (const src of [url, `/api/hologram/asset?u=${encodeURIComponent(url)}`]) {
    try {
      const res = await fetch(src, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) continue;
      const buf = await res.arrayBuffer();
      // glb の先頭は "glTF"
      if (buf.byteLength > 20 && new TextDecoder().decode(buf.slice(0, 4)) === "glTF") return buf;
    } catch {
      /* 次の方法で */
    }
  }
  return null;
}

/** 読み込んだ 3D モデルを画面で描けなかったとき（壊れたファイルなど）は、部品で組み立て直す */
export function assetFailed(): void {
  const { subject, asset } = state;
  if (!subject || !asset) return;
  void requestHologram(subject, { skipFind: true });
}

/** 作ったホログラムを消して、いつもの地球儀に戻す */
export function clearHologram(): void {
  seq++;
  resetView();
  set({ status: "idle", subject: undefined, model: undefined, asset: undefined, error: undefined, expanded: false, step: undefined, brief: undefined, explain: undefined });
}

/** ホログラムを頼んだ返答の文を、説明の字幕として渡す（届くたびに呼ぶ） */
export function setHoloExplain(forId: string, text: string): void {
  if (state.explain?.forId !== forId || state.explain.text === text) return;
  set({ explain: { forId, text } });
}

export function setHoloExpanded(expanded: boolean): void {
  set({ expanded });
}
