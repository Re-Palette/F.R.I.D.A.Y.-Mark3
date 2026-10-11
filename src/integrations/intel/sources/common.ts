/**
 * 情報源の取り込みで共通に使うもの。
 * 取り込んだ 1 件は必ず normalizeItem を通す（文字の消毒・リンクの確認・座標の範囲）。
 */
import { normalizeItem } from "../normalize";
import type { FetchLike } from "../http";
import type { FeedObservation, IntelItem } from "../types";

export interface SourceContext {
  now: number;
  fetchImpl?: FetchLike;
  /** すでに保存してある情報の ID（同じ電文を取り直さないため） */
  known: Set<string>;
  /** すでに読んだ電文の名前（facts.report。同じ電文を読み直さないため） */
  knownReports: Set<string>;
  /** その情報源で最後に取れた時刻（取りこぼしの判定。無ければ null） */
  lastSuccessAt: number | null;
  /**
   * フィードの観測の記録を受け取る（省略可能。Phase 3）。いまは気象庁の台風だけが呼ぶ。
   * 渡さなければ、これまでどおり（呼ばれない）。この中の失敗は、情報の取り込みに影響しない（reportObservation）。
   */
  observe?: (o: FeedObservation) => void;
}

/**
 * 観測の記録を渡す。受け取る側の失敗（例外・失敗した Promise）は握りつぶし、情報の取り込みは続ける。
 * 受け取る側が中身を書き換えても取り込みに響かないよう、写しを渡す。
 */
export function reportObservation(ctx: SourceContext, o: FeedObservation): void {
  if (!ctx.observe) return;
  try {
    const r = ctx.observe(structuredClone(o)) as unknown;
    if (r && typeof (r as Promise<unknown>).catch === "function") (r as Promise<unknown>).catch(() => {});
  } catch {
    /* 観測の記録の失敗で、収集を止めない */
  }
}

export type SourceFetcher = (ctx: SourceContext) => Promise<IntelItem[]>;

type Draft = Pick<IntelItem, "id" | "source" | "kind" | "category" | "title"> & Partial<IntelItem>;

/** 取り込んだ 1 件を、保存できる形にする（重要度・照合は後の段階で付ける） */
export function makeItem(d: Draft, now: number): IntelItem | null {
  const fetchedAt = new Date(now).toISOString();
  return normalizeItem(
    {
      summary: "",
      url: null,
      publishedAt: null,
      updatedAt: null,
      place: null,
      level: "normal",
      confidence: "high",
      reasons: [],
      corroboration: [],
      clusterId: null,
      conflicts: [],
      facts: {},
      ...d,
      fetchedAt,
      firstSeenAt: fetchedAt,
    },
    fetchedAt,
  );
}

/** 同じ ID は 1 件に（後から来たものを使う） */
export function uniqueById(items: IntelItem[]): IntelItem[] {
  const map = new Map<string, IntelItem>();
  for (const i of items) map.set(i.id, i);
  return [...map.values()];
}
