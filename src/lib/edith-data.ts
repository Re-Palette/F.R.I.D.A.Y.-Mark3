/**
 * E.D.I.T.H. の画面が使うデータ（画面側）。
 *   - 分野ごとの最新の話題（/api/edith/news）。取得中・取得済み・失敗・0 件を分けて扱い、10 分は覚えておく
 *   - GLOBAL TREND：取得した話題のうち、各分野（AI・Energy など）に関係する件数を数える（実際に取得した話題だけから。推移などの数字は作らない）
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

export type EdithCategory = "news" | "research" | "market" | "travel" | "culture" | "tech" | "education" | "more";

export interface EdithNewsItem {
  title: string;
  summary: string;
  region: string;
  place: { name: string; lat: number; lon: number } | null;
  sources: { uri: string; title: string }[];
}

export type NewsState =
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "ready"; items: EdithNewsItem[]; fetchedAt: string };

const CACHE_MS = 10 * 60_000;
const store = new Map<EdithCategory, { at: number; state: NewsState }>();
const listeners = new Set<() => void>();
let version = 0;
const notify = () => {
  version++;
  listeners.forEach((l) => l());
};

async function load(cat: EdithCategory, force = false): Promise<void> {
  const hit = store.get(cat);
  if (!force && hit && (hit.state.status === "loading" || Date.now() - hit.at < CACHE_MS)) return;
  store.set(cat, { at: Date.now(), state: { status: "loading" } });
  notify();
  try {
    const res = await fetch(`/api/edith/news?cat=${cat}`, { cache: "no-store" });
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; items?: EdithNewsItem[]; fetchedAt?: string; error?: string };
    if (!res.ok || !json.ok) throw new Error(json.error || "ニュースを取得できませんでした。");
    store.set(cat, { at: Date.now(), state: { status: "ready", items: json.items ?? [], fetchedAt: json.fetchedAt ?? new Date().toISOString() } });
  } catch (err) {
    store.set(cat, { at: 0, state: { status: "error", error: err instanceof Error ? err.message : "ニュースを取得できませんでした。" } });
  }
  notify();
}

/** その分野の最新の話題（画面に出ている間に取りに行く） */
export function useEdithNews(cat: EdithCategory): { state: NewsState; retry: () => void } {
  useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => version,
    () => 0,
  );
  useEffect(() => {
    void load(cat);
  }, [cat]);
  const retry = useCallback(() => void load(cat, true), [cat]);
  return { state: store.get(cat)?.state ?? { status: "loading" }, retry };
}

/** これまでに取得したすべての話題（分野をまたいで） */
export function useAllLoadedNews(): EdithNewsItem[] {
  useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => version,
    () => 0,
  );
  const all: EdithNewsItem[] = [];
  for (const { state } of store.values()) if (state.status === "ready") all.push(...state.items);
  return all;
}

export const TREND_FIELDS: { key: string; label: string; re: RegExp }[] = [
  { key: "ai", label: "AI", re: /\bAI\b|人工知能|生成|LLM|ChatGPT|Gemini|機械学習|半導体/i },
  { key: "energy", label: "Energy", re: /エネルギー|再生可能|太陽光|風力|原子力|原発|電力|石油|原油|天然ガス|\bEV\b|電池|脱炭素/i },
  { key: "health", label: "Health", re: /健康|医療|病気|疾患|ワクチン|医薬|感染|がん|治療|WHO/i },
  { key: "finance", label: "Finance", re: /金融|株|市場|経済|金利|為替|投資|銀行|ドル|円安|円高|インフレ|GDP/i },
  { key: "education", label: "Education", re: /教育|学校|大学|学生|学習|入試|研究者/i },
];

/** 分野ごとの関連件数（取得した話題の見出し・要約から数える） */
export function trendCounts(items: EdithNewsItem[]): { key: string; label: string; count: number }[] {
  return TREND_FIELDS.map((f) => ({ key: f.key, label: f.label, count: items.filter((i) => f.re.test(`${i.title} ${i.summary}`)).length }));
}

/** 地域ごとの件数（多い順） */
export function regionCounts(items: EdithNewsItem[]): { name: string; count: number }[] {
  const m = new Map<string, number>();
  for (const i of items) if (i.place) m.set(i.place.name, (m.get(i.place.name) ?? 0) + 1);
  return [...m.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
}

/** 時刻の見せ方（何分前／時:分） */
export function ago(iso: string, now = Date.now()): string {
  const d = new Date(iso).getTime();
  const min = Math.round((now - d) / 60_000);
  if (min < 1) return "たった今取得";
  if (min < 60) return `${min}分前に取得`;
  return `${new Date(iso).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })}に取得`;
}

/** ブラウザで安全に開けるリンクか（http(s) だけ） */
export function safeHref(uri: string): string | undefined {
  try {
    const u = new URL(uri);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function useNow(intervalMs = 1000): Date | null {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
