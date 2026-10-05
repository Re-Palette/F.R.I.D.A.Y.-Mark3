"use client";

/**
 * 会話の同期（スマホとパソコンで同じ会話を続ける）。脳（GitHub）の .friday/session.json を通して共有する。
 *   - 返答が終わるたびに保存する（少し待ってまとめて）
 *   - 画面に戻ったとき・開いている間は 20 秒ごとに、ほかの端末の発言を取り込む
 *   - 返答の途中は取り込まない（表示が入れ替わらないように）
 * 脳がつながっていなければ何もしない（これまでどおり、この端末の中だけ）。
 */
import { useCallback, useEffect, useRef, type MutableRefObject } from "react";
import { mergeSessions, toSyncMessage, type SyncedSession, type SyncMessage } from "@/lib/session-merge";
import type { ChatPhase, UiMessage } from "./useChat";

const PULL_EVERY_MS = 20_000;
const PUSH_DELAY_MS = 1_200;

const syncable = (list: UiMessage[]) => list.map(toSyncMessage).filter((m): m is SyncMessage => m !== null);

export function useSessionSync({
  hydrated,
  phase,
  messages,
  store,
  replace,
}: {
  hydrated: boolean;
  phase: ChatPhase;
  messages: UiMessage[];
  store: MutableRefObject<UiMessage[]>;
  replace: (list: UiMessage[]) => void;
}) {
  /** 脳がつながっていないと分かったら止める */
  const enabled = useRef(true);
  const clearedAt = useRef(0);
  /** サーバーにあると分かっている発言（ここから消えたら「取り消した」とみなす） */
  const known = useRef(new Set<string>());
  const removed = useRef(new Set<string>());
  const serverUpdatedAt = useRef(-1);
  const lastSent = useRef("");
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const busy = useRef(false);

  /** サーバーの会話を、この端末の会話に取り込む */
  const apply = useCallback(
    (session: SyncedSession) => {
      serverUpdatedAt.current = session.updatedAt;
      known.current = new Set(session.messages.map((m) => m.id));
      clearedAt.current = Math.max(clearedAt.current, session.clearedAt);
      session.removed.forEach((id) => removed.current.add(id));
      if (phaseRef.current !== "idle") return;
      const local = store.current;
      const merged = mergeSessions(
        { messages: syncable(local), clearedAt: clearedAt.current, removed: [...removed.current], updatedAt: 0 },
        session,
      );
      // この端末の発言はそのまま使う（写真の小さな版・エラー表示などを残す）
      const localById = new Map(local.map((m) => [m.id, m]));
      const ids = new Set(merged.messages.map((m) => m.id));
      const next: UiMessage[] = merged.messages.map((m) => localById.get(m.id) ?? (m as unknown as UiMessage));
      // 同期しない発言（エラーなど）も、消した範囲より後なら残す
      for (const m of local) {
        if (!ids.has(m.id) && m.createdAt > clearedAt.current && !removed.current.has(m.id) && !toSyncMessage(m)) next.push(m);
      }
      next.sort((a, b) => a.createdAt - b.createdAt);
      const same = next.length === local.length && next.every((m, i) => m === local[i]);
      if (!same) replace(next);
    },
    [replace, store],
  );

  const pull = useCallback(async () => {
    if (!enabled.current || busy.current || phaseRef.current !== "idle") return;
    try {
      const res = await fetch("/api/session", { cache: "no-store" });
      const json = (await res.json()) as { configured?: boolean; session?: SyncedSession };
      if (json.configured === false) {
        enabled.current = false;
        return;
      }
      if (json.session && json.session.updatedAt !== serverUpdatedAt.current) apply(json.session);
    } catch {
      /* 次の機会に */
    }
  }, [apply]);

  const push = useCallback(async () => {
    if (!enabled.current || busy.current) return;
    const local = store.current;
    const ids = new Set(local.map((m) => m.id));
    for (const id of known.current) if (!ids.has(id)) removed.current.add(id);
    const body = JSON.stringify({ messages: syncable(local), clearedAt: clearedAt.current, removed: [...removed.current] });
    if (body === lastSent.current) return;
    busy.current = true;
    try {
      const res = await fetch("/api/session", { method: "POST", headers: { "Content-Type": "application/json" }, body });
      const json = (await res.json()) as { configured?: boolean; session?: SyncedSession };
      if (json.configured === false) enabled.current = false;
      else if (res.ok && json.session) {
        lastSent.current = body;
        busy.current = false;
        apply(json.session);
      }
    } catch {
      /* 次の返答のときにまた送る */
    } finally {
      busy.current = false;
    }
  }, [apply, store]);

  // 開いたとき：ほかの端末の会話を取り込む
  useEffect(() => {
    if (hydrated) void pull();
  }, [hydrated, pull]);

  // 返答が終わったら（会話が変わったら）保存する
  useEffect(() => {
    if (!hydrated || phase !== "idle") return;
    const t = window.setTimeout(() => void push(), PUSH_DELAY_MS);
    return () => clearTimeout(t);
  }, [hydrated, phase, messages, push]);

  // 画面に戻ったとき・開いている間はときどき、ほかの端末の発言を取り込む
  useEffect(() => {
    if (!hydrated) return;
    const onVisible = () => document.visibilityState === "visible" && void pull();
    const t = window.setInterval(() => document.visibilityState === "visible" && void pull(), PULL_EVERY_MS);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [hydrated, pull]);

  /** 会話を消したとき：ほかの端末からも消す */
  const markCleared = useCallback(() => {
    clearedAt.current = Date.now();
    known.current.clear();
    void push();
  }, [push]);

  return { markCleared };
}
