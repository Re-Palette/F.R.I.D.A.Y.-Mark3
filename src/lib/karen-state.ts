/**
 * K.A.R.E.N. の状態（1 か所でまとめて管理する。画面のアニメーションと制作の処理が食い違わないように）。
 *
 *   IDLE          待機。中央に球を出す
 *   LISTENING     声を聞いている
 *   UNDERSTANDING 指示を読み取っている
 *   TRANSITIONING 球が消えて、中央が制作の画面に切り替わっている（演出）
 *   CREATING      制作の処理中（本当に制作エンジンに渡している間だけ）
 *   PREVIEW       結果を表示中（操作できる）
 *   EDITING       できたものを編集中
 *   COMPLETED     制作が終わった（結果は出したまま。球には自動で戻らない）
 *   ERROR         制作に失敗した
 *   CANCELLED     キャンセルした
 *
 * 状態の移り方は reduce だけが決める（純粋な関数。テストでそのまま確かめる）。
 * 制作の処理は jobId で見分け、キャンセル・別の制作のあとに届いた古い結果は捨てる。
 */
import { useSyncExternalStore } from "react";

export type KarenPhase = "IDLE" | "LISTENING" | "UNDERSTANDING" | "TRANSITIONING" | "CREATING" | "PREVIEW" | "EDITING" | "COMPLETED" | "ERROR" | "CANCELLED";

/** 制作の段階（実際に制作エンジンで進んでいる処理）。進み具合の割合は取れないので出さない */
export type JobStep = "find" | "research" | "design" | "build";

export interface KarenJob {
  id: number;
  /** 何を作っているか（「未来都市の 3D ホログラムを作成」） */
  title: string;
  step: JobStep;
  /** 終わった段階 */
  done: JobStep[];
  startedAt: number;
}

export interface KarenState {
  phase: KarenPhase;
  /** 中央が制作の画面になっているか（false のときは球を出す） */
  workspace: boolean;
  /** 聞き取り・読み取りの前の状態（指示が無かったらここに戻る） */
  resume: KarenPhase;
  /** 認識した指示の文（画面の下に一時的に出す） */
  heard?: string;
  /** 制作開始の演出に出す、指示の要約 */
  request?: string;
  job?: KarenJob;
  /** 演出の途中で制作が終わった（演出が終わったら COMPLETED へ） */
  finishedDuringTransition?: "done" | "error";
  error?: string;
  /** 案内（未実装・聞き返し・保存しました など） */
  notice?: { text: string; tone: "info" | "warn" | "error"; at: number };
}

export type KarenEvent =
  | { type: "LISTEN_START" }
  | { type: "LISTEN_END" }
  | { type: "HEARD"; text: string }
  /** 制作・編集の指示ではなかった（会話として AI に渡した） */
  | { type: "NOT_CREATIVE" }
  /** 制作を始める（演出つき）。jobId は本当に制作エンジンに渡す処理のとき */
  | { type: "START_CREATE"; request: string; jobId?: number; step?: JobStep }
  | { type: "TRANSITION_DONE" }
  | { type: "JOB_STEP"; jobId: number; step: JobStep }
  | { type: "JOB_DONE"; jobId: number }
  | { type: "JOB_ERROR"; jobId: number; error: string }
  /** その場で終わる編集（色・大きさ・移動・形を足すなど） */
  | { type: "EDIT_START" }
  | { type: "EDIT_DONE" }
  | { type: "CANCEL" }
  /** 待機（球）に戻る */
  | { type: "RESET" }
  | { type: "NOTICE"; text: string; tone?: "info" | "warn" | "error" }
  | { type: "CLEAR_NOTICE" };

export const INITIAL: KarenState = { phase: "IDLE", workspace: false, resume: "IDLE" };

/** 制作の処理が走っているか */
export const busy = (s: KarenState) => s.phase === "CREATING" || (s.phase === "TRANSITIONING" && Boolean(s.job) && !s.finishedDuringTransition);

/** 聞き取り・読み取りを始めてよい状態（制作の処理中・演出中は、表示はそのままにする） */
const canListen = (p: KarenPhase) => p !== "CREATING" && p !== "TRANSITIONING" && p !== "UNDERSTANDING";

export function reduce(s: KarenState, e: KarenEvent, now = Date.now()): KarenState {
  switch (e.type) {
    case "LISTEN_START":
      return canListen(s.phase) && s.phase !== "LISTENING" ? { ...s, phase: "LISTENING", resume: s.phase } : s;
    case "LISTEN_END":
      return s.phase === "LISTENING" ? { ...s, phase: s.resume } : s;
    case "HEARD":
      if (s.phase === "CREATING" || s.phase === "TRANSITIONING") return { ...s, heard: e.text };
      return { ...s, phase: "UNDERSTANDING", resume: s.phase === "LISTENING" || s.phase === "UNDERSTANDING" ? s.resume : s.phase, heard: e.text };
    case "NOT_CREATIVE":
      return s.phase === "UNDERSTANDING" ? { ...s, phase: s.resume } : s;
    case "START_CREATE": {
      const job = e.jobId !== undefined ? { id: e.jobId, title: e.request, step: e.step ?? "find", done: [], startedAt: now } : undefined;
      const base = { ...s, request: e.request, job, error: undefined, finishedDuringTransition: undefined };
      // 球がまだ出ているときだけ、球が消える演出をはさむ
      if (!s.workspace) return { ...base, phase: "TRANSITIONING", workspace: true };
      return { ...base, phase: job ? "CREATING" : "PREVIEW" };
    }
    case "TRANSITION_DONE": {
      if (s.phase !== "TRANSITIONING") return s;
      if (s.finishedDuringTransition === "done") return { ...s, phase: "COMPLETED", finishedDuringTransition: undefined };
      if (s.finishedDuringTransition === "error") return { ...s, phase: "ERROR", finishedDuringTransition: undefined };
      return { ...s, phase: s.job ? "CREATING" : "PREVIEW" };
    }
    case "JOB_STEP": {
      if (!s.job || s.job.id !== e.jobId || s.job.step === e.step) return s;
      return { ...s, job: { ...s.job, done: [...s.job.done, s.job.step], step: e.step } };
    }
    case "JOB_DONE": {
      if (!s.job || s.job.id !== e.jobId) return s; // キャンセル・別の制作のあとに届いた結果
      const job = { ...s.job, done: [...s.job.done, s.job.step] };
      if (s.phase === "TRANSITIONING") return { ...s, job, finishedDuringTransition: "done" };
      if (s.phase !== "CREATING") return { ...s, job };
      return { ...s, job, phase: "COMPLETED" };
    }
    case "JOB_ERROR": {
      if (!s.job || s.job.id !== e.jobId) return s;
      if (s.phase === "TRANSITIONING") return { ...s, error: e.error, finishedDuringTransition: "error" };
      return { ...s, phase: "ERROR", error: e.error };
    }
    case "EDIT_START":
      return s.phase === "CREATING" || s.phase === "TRANSITIONING" ? s : { ...s, phase: "EDITING" };
    case "EDIT_DONE":
      return s.phase === "EDITING" ? { ...s, phase: "PREVIEW" } : s;
    case "CANCEL":
      if (!busy(s)) return s;
      return { ...s, phase: "CANCELLED", job: undefined, finishedDuringTransition: undefined };
    case "RESET":
      return { ...INITIAL, notice: s.notice };
    case "NOTICE":
      return { ...s, notice: { text: e.text, tone: e.tone ?? "info", at: now } };
    case "CLEAR_NOTICE":
      return { ...s, notice: undefined };
  }
}

/* ---------- 画面全体で 1 つの状態 ---------- */

let state: KarenState = INITIAL;
const listeners = new Set<() => void>();

export function getKarenState(): KarenState {
  return state;
}

export function dispatchKaren(e: KarenEvent): KarenState {
  const next = reduce(state, e);
  if (next !== state) {
    state = next;
    listeners.forEach((l) => l());
  }
  return state;
}

export function useKarenState(): KarenState {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    getKarenState,
    () => INITIAL,
  );
}

let jobSeq = 0;
/** 新しい制作の番号 */
export const nextJobId = () => ++jobSeq;
