/**
 * E.D.I.T.H. の世界情報インテリジェンス（情報収集・分析・通知）で使う型。サーバー専用。
 *
 *   集める → 形をそろえる → 重複を除く → 分類 → 重要度 → 出典の照合 → 記憶へ保存 → 通知
 *
 * 公式発表（official）・報道（report）・AI の検索まとめ（ai-search）・研究（research）を区別して持つ。
 * AI のまとめだけを根拠に緊急通知はしない（通知の段階で kind を見る）。
 */

/** 情報源の ID（設定ノート・状態ファイルで使う。変えると記録が引き継がれない） */
export type IntelSourceId = "usgs" | "nhc" | "jma" | "jmatyphoon" | "gdelt" | "gemini" | "rss" | "launches" | "arxiv" | "crossref" | "openalex" | "firms";

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
  /** 別の情報源の項目との照合の結果（Phase 3。照合していない項目には無い） */
  match?: IntelMatch;
}

/**
 * 別の情報源の項目との照合の結果。
 *   confirmed … 決めた条件をすべて満たし、相手が 1 件に決まった
 *   pending   … 候補はあるが根拠が足りない（関連付けを保留）。with は候補で、同じ出来事とは決めていない
 */
export interface IntelMatch {
  status: "confirmed" | "pending";
  /** 相手（候補）の項目の id */
  with: string[];
  /** 判定の根拠（例：「発生時刻の差 12 秒」「震央の距離 18km」） */
  basis: string[];
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
  /** 出来事（台風など）ごとの追跡の記録（Phase 3。まだ判定していなければ無い） */
  tracking?: IntelTracking;
  /**
   * このプログラムが知らない版（新しい版）の追跡の記録（古いプログラムが動いても、新しい記録を消さないため）。
   * これがある間は、今の版の tracking を書かない・追跡の判定もしない（state.ts の trackingWritable）。
   */
  unsupportedTracking?: UnsupportedTrackingHold;
}

/**
 * 知らない版の追跡の記録の預かり方。
 *   kept     … 中身は読まず・使わず、state.json を書くときに tracking へそのまま書き戻す
 *   rejected … 大きすぎる・入れ子が深すぎる・正しく書き戻せない値を含む。
 *              書き戻すと中身が変わる・壊れるので、state.json への書き込みそのものを止める（ファイルはそのまま残る）
 */
export type UnsupportedTrackingHold =
  | { status: "kept"; version: number; value: unknown }
  | { status: "rejected"; version: number; reason: "too-large" | "too-deep" | "not-serializable" };

/* ---------- Phase 3：出来事の追跡（型だけ。判定の処理はまだ無い） ----------
 * 時刻はすべて ISO 形式の文字列（ほかの項目と同じ）。電文などに無い値は推測で埋めず、null・"unknown" のままにする。
 * 「発表が止まった」と「追跡の終わり」は別のもの。終わり（ended）は、明示的な終了の根拠があるときだけ。
 */

/** 取得の失敗の種類（http.ts の SourceError.kind と同じ値） */
export type IntelFetchErrorKind = "http" | "timeout" | "network" | "too-large" | "redirect" | "other";

/**
 * フィード全体の取得の結果。
 *   ok           … 取得して読めた（新しい電文が無くても ok）
 *   fetch-failed … 取得できなかった（HTTP エラー・時間切れ・通信・大きすぎる・転送など）
 *   unparseable  … 取得できたが、フィードとして読めなかった
 */
export type FeedObservationStatus = "ok" | "fetch-failed" | "unparseable";

/** 観測の記録の上限（大きくしすぎない） */
export const FEED_OBSERVATION_LIMITS = { streams: 6, recentAt: 8, message: 160 } as const;

/**
 * 1 回の取得で見えた、フィード全体の様子（保存しない。判定もしない。あとの段階の判定の材料）。
 * 新しい電文が無かった回でも、電文の系列ごとの最新時刻が分かる（「発表が来なかった」を記録するため）。
 * 取得・解析に失敗した回は、件数は null・系列は空（「0 件」「系列が無い」ではなく「分からない」）。
 * 時刻は 3 種類を分ける：fetchedAt（こちらが取得した時刻）・フィードの項目の時刻（latestAt など）・電文の発表時刻（reportAt）。
 */
export interface FeedObservation {
  source: IntelSourceId;
  /** こちらがフィードを取得した時刻（取得を始めた時刻。発表の時刻ではない） */
  fetchedAt: string;
  status: FeedObservationStatus;
  /** 失敗したとき（fetch-failed・unparseable）の内容。ok なら null */
  failure: { kind: IntelFetchErrorKind; httpStatus: number | null; message: string } | null;
  /** フィードの HTTP Last-Modified（いまは取得しないので常に null。推測で埋めない） */
  feedLastModified: string | null;
  /** フィードに載っている一番新しい項目の時刻（台風以外の項目も含む。読めなければ・失敗なら null） */
  feedNewestEntryAt: string | null;
  /** フィードの項目の数（失敗なら null。0 は「読めたが項目が無い」） */
  entryCount: number | null;
  /** そのうち台風の電文（台風解析・予報情報、VPTW60〜65）の項目の数（失敗なら null） */
  typhoonEntryCount: number | null;
  /** 電文の系列ごとの様子（例：気象庁の電文コード VPTW62）。失敗なら空（分からない） */
  streams: FeedStreamObservation[];
}

/**
 * 系列の最新の電文を、今回どう扱ったか。
 *   new-read         … 新しい電文を読んで、項目にした
 *   already-known    … 前に読んだ電文（読み直さない。「新しい発表が無い」）
 *   doc-fetch-failed … 電文を取得できなかった（次の実行でもう一度読む）
 *   doc-unparseable  … 電文を取得したが、台風の項目として読めなかった（実況が無い・番号も EventID も無いなど）
 *   doc-not-normal   … 訓練・試験の電文（通常でない。取り込まない決まり）
 */
export type FeedBulletinOutcome = "new-read" | "already-known" | "doc-fetch-failed" | "doc-unparseable" | "doc-not-normal";

export interface FeedStreamObservation {
  /** 電文の系列（気象庁は VPTW60〜65）。同じ系列が同じ出来事のままとは限らない（使い回しを前提にしない） */
  stream: string;
  /** フィードに載っている、その系列の最新の項目の時刻（フィードの updated。電文の発表時刻とは別。読めなければ null） */
  latestAt: string | null;
  /** その系列の最新の電文の名前（facts.report と同じ形。読めなければ null） */
  latestReport: string | null;
  /** フィードに載っている、その系列の直近の項目の時刻（新しい順・上限あり） */
  recentAt: string[];
  /** 最新の電文を今回どう扱ったか */
  bulletin: FeedBulletinOutcome;
  /** 新しく読んで項目にしたときの、項目の id（new-read のときだけ。それ以外は null） */
  itemId: string | null;
  /** 電文の中の発表時刻（ReportDateTime）。電文を読めたとき（new-read）だけ。それ以外は null（推測しない） */
  reportAt: string | null;
  /** 電文の取得に失敗したとき（doc-fetch-failed）の種類。それ以外は null */
  docError: { kind: IntelFetchErrorKind; httpStatus: number | null } | null;
}

/** 電文の実況に書かれた現象の階級（気象庁の TyphoonClass の括弧内）。読めない・知らない値は unknown */
export type IntelPhenomenonCode = "TY" | "STS" | "TS" | "TD" | "LOW" | "unknown";

/** 情報の鮮度（発表の間隔に対して）。fresh=新しい / due=更新待ち（1 回分遅れ）/ overdue=発表が来ていない / unknown=判定できない */
export type IntelFreshnessLevel = "fresh" | "due" | "overdue" | "unknown";

/**
 * データ元の更新状態。
 *   active         … この出来事の発表が続いている
 *   event-stalled  … データ元は動いているのに、この出来事の発表だけが来ていない
 *   source-stalled … データ元全体の更新が止まっている（この出来事の判定は進めない）
 *   unverified     … 取得に失敗した・材料が足りないなどで確かめられない
 */
export type IntelSourceActivity = "active" | "event-stalled" | "source-stalled" | "unverified";

/**
 * 追跡の状態（発表の停止と追跡の終わりを分ける）。
 *   tracking … 発表が続いている
 *   paused   … 発表が止まっている（終わったとは決めていない）
 *   dormant  … 発表の停止が長く続いている（終わったかは未確認）
 *   ended    … 明示的な終了の根拠がある（endEvidence が必ずある）
 */
export type IntelTrackingStatus = "tracking" | "paused" | "dormant" | "ended";

/** 最後に読んだ電文の構造（電文に無かったと確かめたものは false・""。確かめられなければ null） */
export interface IntelBulletinSummary {
  /** 電文の名前（facts.report と同じ形） */
  report: string;
  /** 通し番号（電文の Serial。無ければ null） */
  serial: string | null;
  /** 発表時刻 */
  reportAt: string | null;
  /** 実況の対象時刻 */
  targetAt: string | null;
  /** 予報の部分があったか */
  hasForecast: boolean | null;
  /** 風の項目があったか（無ければ風速は「無い」。値は推測しない） */
  hasWindPart: boolean | null;
  /** 見出し文（電文の見出しが空だと確かめたら ""。確かめられなければ null） */
  headline: string | null;
}

/** 発表の履歴の 1 件 */
export interface IntelBulletinHistoryEntry {
  report: string;
  serial: string | null;
  reportAt: string | null;
  phenomenon: IntelPhenomenonCode;
  pressureHpa: number | null;
}

/** 出来事（台風など）1 つ分の追跡の記録 */
export interface IntelTrackedEvent {
  /** 出来事の ID（items.json の項目の id と同じ。例 "jma:typhoon:2628"）。情報源の EventID でまとめ直さない */
  id: string;
  source: IntelSourceId;
  /** 最後に見た電文の系列（例 "VPTW62"。無ければ null） */
  stream: string | null;
  /** 情報源が付けた出来事の ID（気象庁の EventID など）。見たものを記録するだけで、引き継ぎ・統合には使わない */
  seenEventIds: string[];
  /** A：電文の実況に書かれた現象の状態 */
  phenomenon: {
    code: IntelPhenomenonCode;
    /** 電文の文字そのまま（例 "熱帯低気圧(TD)"。無ければ null） */
    raw: string | null;
    /** 実況の時刻 */
    observedAt: string | null;
    /** 根拠にした電文の名前 */
    report: string;
  };
  lastBulletin: IntelBulletinSummary;
  /** 発表の間隔（直近の発表時刻から。足りなければ設定値。どちらも無ければ null） */
  cadence: {
    recentAt: string[];
    expectedMs: number | null;
    basis: "observed" | "config" | null;
  };
  /** B：鮮度 */
  freshness: {
    level: IntelFreshnessLevel;
    /**
     * 来なかった発表の回数（0 以上の整数。数えられなければ null。0 にはしない）。
     * fresh なら 0、due・overdue なら 1 以上、unknown なら null（段階と食い違う記録は作らない）
     */
    missedSlots: number | null;
    /** 判定の基準にした時刻（フィードの一番新しい項目など。無ければ null） */
    referenceAt: string | null;
    basis: string[];
  };
  /** C：データ元の更新状態 */
  sourceActivity: {
    status: IntelSourceActivity;
    /** 比べた同じデータ元のほかの系列（例 VPTW61）と、その最新時刻 */
    peers: { stream: string; latestAt: string }[];
    basis: string[];
  };
  /** D：追跡の状態 */
  tracking: {
    status: IntelTrackingStatus;
    /** この状態になった時刻 */
    since: string;
    basis: string[];
    /** 終了の根拠（ended のときだけ。それ以外は null） */
    endEvidence: string | null;
  };
  /** 発表の履歴（新しい順・上限あり） */
  history: IntelBulletinHistoryEntry[];
  firstSeenAt: string;
  lastEvaluatedAt: string;
}

/** 追跡の記録全体（state.json の tracking） */
export interface IntelTracking {
  version: 1;
  /** 出来事の ID → 記録 */
  events: Record<string, IntelTrackedEvent>;
  /** 電文の系列 → 最後にその系列の電文から読んだ出来事（系列の使い回しに気づくため。統合には使わない） */
  streams: Record<string, { lastTrackedId: string; latestAt: string }>;
}
