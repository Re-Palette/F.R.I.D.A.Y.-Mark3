/**
 * AI Router（画面側）— いまどの AI で答えるかを、F.R.I.D.A.Y. 自身が判断する。
 *
 *   ONLINE              Gemini に実際に届く                    → Gemini（サーバーの FRIDAY Core）
 *   GEMINI_UNAVAILABLE  サーバーには届くが Gemini が使えない     → LM Studio（Offline Core）
 *   OFFLINE             サーバーにも届かない（ネットが切れた）   → LM Studio（Offline Core）
 *   LOCAL_AI_UNAVAILABLE どちらも使えない                       → はっきりエラーを出す
 *
 * navigator.onLine だけは信用せず、/api/ai/health（サーバーが Gemini に実際に問い合わせる）と LM Studio の /v1/models で確かめる。
 * 切り替えは発言と発言の間でだけ起こる（返答の途中でモデルが替わって会話が壊れないように）。
 * 会話・記憶・人格はモデルの外（画面の会話と FRIDAY Core）にあるので、替わっても続きを話せる。
 */
import { useSyncExternalStore } from "react";
import { checkLocalAi, flushOutbox, refreshPack, rememberLocalAiConfig } from "./offline-core";

export type AiRoute = "checking" | "online" | "switching" | "offline" | "unavailable";

export interface AiRouteState {
  route: AiRoute;
  /** オフライン時の理由（サーバーに届かない / Gemini が使えない） */
  why?: "network" | "gemini";
  /** ローカル AI のモデル名 */
  localModel?: string;
}

let state: AiRouteState = { route: "checking" };
const listeners = new Set<() => void>();

function set(next: AiRouteState) {
  if (next.route === state.route && next.why === state.why && next.localModel === state.localModel) return;
  state = next;
  listeners.forEach((l) => l());
}

export const currentRoute = (): AiRouteState => state;

const HEALTH_TIMEOUT_MS = 5000;
const LOCAL_TIMEOUT_MS = 2500;
/** オフライン中に Gemini へ戻れるか確かめる間隔 */
const RECHECK_OFFLINE_MS = 20_000;
/** オンライン中にときどき確かめる間隔（サーバー側でキャッシュするので軽い） */
const RECHECK_ONLINE_MS = 5 * 60_000;

let probing: Promise<AiRouteState> | null = null;

async function toLocal(why: "network" | "gemini"): Promise<AiRouteState> {
  const local = await checkLocalAi(AbortSignal.timeout(LOCAL_TIMEOUT_MS)).catch(() => ({ ok: false as const, model: undefined }));
  return local.ok ? { route: "offline", why, localModel: local.model } : { route: "unavailable", why };
}

/** いまの状態を確かめ直す（同時に何度呼んでも 1 回にまとめる） */
export function probeRoute(): Promise<AiRouteState> {
  probing ??= (async () => {
    let next: AiRouteState;
    try {
      const health = (ms: number) => fetch("/api/ai/health", { cache: "no-store", signal: AbortSignal.timeout(ms) });
      // 時間切れは「サーバーが起動中で遅い」こともあるので、1 回だけ長めに待ち直す（届かない＝ネットが無いときはすぐ失敗する）
      const res = await health(HEALTH_TIMEOUT_MS).catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "TimeoutError") return health(HEALTH_TIMEOUT_MS * 3);
        throw err;
      });
      if (res.status === 401) next = { route: "online" }; // ログインが切れているだけ（画面がログインへ案内する）
      else if (!res.ok) next = await toLocal("network");
      else {
        const json = (await res.json()) as { gemini?: { ok?: boolean }; local?: { baseUrl?: string; model?: string } };
        if (json.local) rememberLocalAiConfig(json.local);
        next = json.gemini?.ok ? { route: "online" } : await toLocal("gemini");
      }
    } catch {
      next = await toLocal("network");
    }
    set(next);
    if (next.route === "online") {
      // オンラインのうちに、オフライン用の控え（人格・脳）を新しくし、オフライン中の会話を脳に反映する
      void refreshPack();
      void flushOutbox();
    }
    return next;
  })().finally(() => {
    probing = null;
  });
  return probing;
}

/** 会話の途中で Gemini に届かなかった（画面に「切り替え中」を出し、ローカル AI を確かめる） */
export function markGeminiFailed(why: "network" | "gemini" = "network"): void {
  if (state.route === "offline") return;
  set({ route: "switching", why });
  void toLocal(why).then(set);
}

let started = false;

/** 画面を開いたときに 1 回呼ぶ。以後、ネットの切断・復帰や時間の経過に合わせて確かめ直す */
export function startAiRouter(): void {
  if (started || typeof window === "undefined") return;
  started = true;
  void probeRoute();
  window.addEventListener("online", () => void probeRoute());
  window.addEventListener("offline", () => void probeRoute());
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && void probeRoute());
  let last = Date.now();
  window.setInterval(() => {
    const wait = state.route === "online" ? RECHECK_ONLINE_MS : RECHECK_OFFLINE_MS;
    if (Date.now() - last < wait || document.visibilityState !== "visible") return;
    last = Date.now();
    void probeRoute();
  }, 5000);
}

export function useAiRoute(): AiRouteState {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => state,
    () => state,
  );
}
