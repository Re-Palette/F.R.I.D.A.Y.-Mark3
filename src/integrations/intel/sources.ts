/**
 * E.D.I.T.H. の情報源の一覧（取りに行く間隔・古いとみなす時間・必要な鍵）。
 * ここに載っていても、設定ノートで OFF、または必要な鍵が無ければ動かさない。
 */
import type { IntelKind, IntelSourceId } from "./types";

export interface IntelSourceDef {
  id: IntelSourceId;
  /** 設定ノート・画面での名前 */
  label: string;
  kind: IntelKind;
  /** これより短い間隔では取りに行かない（各サービスの利用条件に合わせる） */
  minIntervalMs: number;
  /** 最後に取れてからこれ以上たったら「古い」とみなす */
  maxAgeMs: number;
  /** 既定で ON か（設定ノートに書かれていないとき） */
  defaultOn: boolean;
  /** 必要な鍵（環境変数の名前）。無ければ動かさない */
  needsEnv?: string;
  /** 実装済みか（まだのものは設定で ON でも動かさない） */
  ready: boolean;
}

const MIN = 60_000;
const HOUR = 60 * MIN;

export const INTEL_SOURCES: readonly IntelSourceDef[] = [
  // USGS のまとめフィードは約 1 分ごとに更新。M4.5 以上・過去 1 日のフィードを 10 分ごとに読む
  { id: "usgs", label: "USGS 地震", kind: "official", minIntervalMs: 10 * MIN, maxAgeMs: 2 * HOUR, defaultOn: true, ready: true },
  // NHC は発表ごと（ふつう数時間おき）に更新。30 分ごとで十分
  { id: "nhc", label: "NOAA ハリケーン", kind: "official", minIntervalMs: 30 * MIN, maxAgeMs: 6 * HOUR, defaultOn: true, ready: true },
  // 気象庁の高頻度フィードは毎分更新・直近 10 分以上を掲載。取りこぼしたら長期フィード（毎時更新・数日分）で補う
  { id: "jma", label: "気象庁 地震・津波", kind: "official", minIntervalMs: 10 * MIN, maxAgeMs: 2 * HOUR, defaultOn: true, ready: true },
  // 台風の情報は数時間おき。長期フィード（毎時更新）を 1 時間ごとに読む
  { id: "jmatyphoon", label: "気象庁 台風", kind: "official", minIntervalMs: 60 * MIN, maxAgeMs: 6 * HOUR, defaultOn: true, ready: true },
  { id: "gdelt", label: "GDELT 世界のニュース", kind: "report", minIntervalMs: 60 * MIN, maxAgeMs: 6 * HOUR, defaultOn: true, ready: false },
  { id: "gemini", label: "Gemini 検索", kind: "ai-search", minIntervalMs: 3 * HOUR, maxAgeMs: 12 * HOUR, defaultOn: true, ready: false },
  { id: "rss", label: "公的機関・報道の RSS", kind: "report", minIntervalMs: 60 * MIN, maxAgeMs: 12 * HOUR, defaultOn: false, ready: false },
  { id: "launches", label: "ロケット打ち上げ（Launch Library 2）", kind: "official", minIntervalMs: 6 * HOUR, maxAgeMs: 24 * HOUR, defaultOn: false, ready: false },
  { id: "arxiv", label: "arXiv 論文", kind: "research", minIntervalMs: 24 * HOUR, maxAgeMs: 48 * HOUR, defaultOn: false, ready: false },
  { id: "crossref", label: "Crossref 論文", kind: "research", minIntervalMs: 24 * HOUR, maxAgeMs: 48 * HOUR, defaultOn: false, ready: false },
  { id: "openalex", label: "OpenAlex 研究", kind: "research", minIntervalMs: 24 * HOUR, maxAgeMs: 48 * HOUR, defaultOn: false, needsEnv: "OPENALEX_API_KEY", ready: false },
  { id: "firms", label: "NASA FIRMS 火災", kind: "official", minIntervalMs: 3 * HOUR, maxAgeMs: 12 * HOUR, defaultOn: false, needsEnv: "FIRMS_MAP_KEY", ready: false },
];

export function sourceDef(id: IntelSourceId): IntelSourceDef | undefined {
  return INTEL_SOURCES.find((s) => s.id === id);
}

export function isSourceId(v: string): v is IntelSourceId {
  return INTEL_SOURCES.some((s) => s.id === v);
}

/** 必要な鍵がそろっているか（鍵の値そのものは読まない・出さない） */
export function hasRequiredKey(def: IntelSourceDef, env: Record<string, string | undefined> = process.env): boolean {
  return !def.needsEnv || Boolean(env[def.needsEnv]?.trim());
}
