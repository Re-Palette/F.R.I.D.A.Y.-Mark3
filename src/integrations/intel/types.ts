/**
 * E.D.I.T.H. の世界情報インテリジェンス（情報収集・分析・通知）で使う型。サーバー専用。
 *
 *   集める → 形をそろえる → 重複を除く → 分類 → 重要度 → 出典の照合 → 記憶へ保存 → 通知
 *
 * 公式発表（official）・報道（report）・AI の検索まとめ（ai-search）・研究（research）を区別して持つ。
 * AI のまとめだけを根拠に緊急通知はしない（通知の段階で kind を見る）。
 */

/** 情報源の ID（設定ノート・状態ファイルで使う。変えると記録が引き継がれない） */
export type IntelSourceId = "usgs" | "nhc" | "jma" | "gdelt" | "gemini" | "rss" | "launches" | "arxiv" | "crossref" | "openalex" | "firms";

/** 情報の種類（公式発表と報道記事を区別する） */
export type IntelKind = "official" | "report" | "ai-search" | "research";

export type IntelCategory = "disaster" | "weather" | "world" | "tech" | "business" | "science" | "space" | "government";

/** 重要度（urgent = 静かな時間帯でも知らせる候補。決めるのはルール。AI のまとめだけでは urgent にしない） */
export type IntelLevel = "urgent" | "high" | "normal" | "low";

/** 確度（公式・複数の独立した情報源で確かめられたほど高い） */
export type IntelConfidence = "high" | "medium" | "low";

export interface IntelPlace {
  name: string;
  lat: number;
  lon: number;
}

export interface IntelSourceRef {
  /** 出典のページ（http(s) だけ） */
  url: string;
  /** 出典の名前（例：USGS、気象庁、報道機関のドメイン） */
  name: string;
}

export interface IntelItem {
  /** `情報源:その情報源での ID`（同じ情報を 2 回取り込んでも 1 件にする） */
  id: string;
  source: IntelSourceId;
  kind: IntelKind;
  category: IntelCategory;
  title: string;
  summary: string;
  /** 主な出典（元のページ） */
  url: string | null;
  /** 発生・公開された時刻（ISO。分からなければ null） */
  publishedAt: string | null;
  /** 情報源から更新された時刻（続報の判定用。無ければ null） */
  updatedAt: string | null;
  /** 取得した時刻（ISO） */
  fetchedAt: string;
  /** 初めて取り込んだ時刻（ISO） */
  firstSeenAt: string;
  place: IntelPlace | null;
  level: IntelLevel;
  confidence: IntelConfidence;
  /** 重要度の理由（ルールが付ける。通知に使う） */
  reasons: string[];
  /** 同じ出来事を伝えた別の情報源（照合の結果） */
  corroboration: IntelSourceRef[];
  /** 同じ出来事のまとまり（重複排除・照合の結果） */
  clusterId: string | null;
  /** 情報源どうしの食い違い（例：規模の数字が違う） */
  conflicts: string[];
  /** 情報源ごとの元の値（地震の規模など。ルールの判定に使う） */
  facts: Record<string, string | number | boolean | null>;
}

/** 情報源ごとの状態（エラー・制限・古さの監視） */
export interface IntelSourceStatus {
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  /** 続けて失敗した回数（再試行の間隔を広げる） */
  failures: number;
  /** この時刻までは取りに行かない（間隔・制限・失敗後の待ち） */
  nextAllowedAt: string | null;
  /** 前回取れた件数 */
  lastCount: number;
}

export interface IntelLock {
  owner: string;
  /** この時刻を過ぎたら、終わらずに止まったとみなして取り直してよい */
  until: string;
}

/** 状態ファイル（.friday/intel/state.json）。書くのは排他の印を持っている実行だけ */
export interface IntelState {
  version: 1;
  lock: IntelLock | null;
  sources: Partial<Record<IntelSourceId, IntelSourceStatus>>;
  /** 送った通知（重複通知の防止。キー → 送った時刻） */
  notified: Record<string, string>;
  /** 今日送った通知の数（上限の管理） */
  daily: { date: string; normal: number; urgent: number };
  /** 最後に全体を動かした時刻 */
  lastRunAt: string | null;
}
