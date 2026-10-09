/**
 * K.A.R.E.N. の指示を実行する（読み取った操作 → 状態 → シーン → 制作エンジン）。画面側で動く。
 *
 * 制作エンジン：
 *   3D ホログラム（3D モデル） … /api/hologram（既存の 3D モデルを Poly Pizza で探す → 無ければ見た目を調べて Gemini が部品で組み立てる）
 *   基本の形・色・大きさ・向き・位置・削除 … この画面のシーン（three.js）でその場で行う
 *   書き出し（GLB）・画像（PNG） … 3D ビューが three.js の書き出し機能で作る
 * 進み具合は、実際に進んでいる段階（探す・調べる・設計・組み立て）だけを出す。割合は取れないので出さない。
 */
import { useSyncExternalStore } from "react";
import { setAiMode } from "./ai-mode";
import { downloadAsset } from "./hologram-model";
import type { HoloAsset, HoloModel } from "./hologram-schema";
import { describeOp, parseKarenCommand, SHAPE_LABEL, startsCreation, type KarenOp } from "./karen-intent";
import { addObject, clearScene, getScene, removeObject, resetView, setProject, setTurntable, target, updateObject, type SceneObject } from "./karen-scene";
import { busy, dispatchKaren, getKarenState, nextJobId, type JobStep } from "./karen-state";
import { saveProject } from "./karen-projects";

/** 3D ビューが登録する、書き出しなどの操作（ビューが無いときは null） */
export interface WorkspaceApi {
  renderPng(): Promise<Blob | null>;
  exportGlb(): Promise<Blob | null>;
  thumbnail(): string | undefined;
}
let workspace: WorkspaceApi | null = null;
export function registerWorkspace(api: WorkspaceApi | null): void {
  workspace = api;
}

/** いまのシーンの小さな画像（右のプレビュー用。3D ビューが無ければ undefined） */
export function workspaceThumbnail(): string | undefined {
  return workspace?.thumbnail();
}

export interface KarenIo {
  /** 声で返す（音声会話のとき） */
  speak?: (text: string) => void;
  /** 制作・編集ではない発言を AI（K.A.R.E.N. の人格）に渡す */
  chat?: (text: string) => void;
}

/** 制作中に届いた編集の指示（制作が終わってから順に当てる） */
let queued: KarenOp[] = [];

function notice(text: string, tone: "info" | "warn" | "error" = "info", io?: KarenIo, say = true) {
  dispatchKaren({ type: "NOTICE", text, tone });
  if (say) io?.speak?.(text);
}

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** 書き出すファイルの名前（日本語の名前はブラウザによって無視されるので、英数字だけのときに使う。ほかは日時） */
const fileBase = () => {
  const name = (getScene().projectName ?? "").replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 40);
  if (name && /^[\w.-]+$/.test(name)) return name;
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `karen-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
};

/* ---------- 制作エンジン（3D ホログラム） ---------- */

async function post(body: object, signal: AbortSignal): Promise<Response> {
  return fetch("/api/hologram", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
}

let running: { id: number; abort: AbortController } | null = null;

/** 〇〇の 3D モデルを作る（実際に /api/hologram に頼む） */
async function createModel(subject: string, request: string, io?: KarenIo): Promise<void> {
  running?.abort.abort();
  const id = nextJobId();
  const abort = new AbortController();
  running = { id, abort };
  dispatchKaren({ type: "START_CREATE", request, jobId: id, step: "find" });
  const step = (s: JobStep) => dispatchKaren({ type: "JOB_STEP", jobId: id, step: s });
  const alive = () => running?.id === id && !abort.signal.aborted;
  try {
    // 1. 既存の 3D モデルを探す
    const hit = (await (await post({ subject, step: "find" }, abort.signal)).json().catch(() => ({}))) as { asset?: HoloAsset | null };
    if (!alive()) return;
    let made: Omit<SceneObject, "id" | "position" | "rotation" | "scale"> | null = null;
    if (hit.asset) {
      // 見つかったモデルを読み込む（読めなければ、部品で組み立てる方へ）
      const buffer = await downloadAsset(hit.asset.url);
      if (!alive()) return;
      if (buffer) {
        step("build");
        made = { name: subject, kind: "asset", asset: hit.asset, buffer };
      }
    }
    if (!made) {
      // 2. 見た目を調べる → 3. 部品で設計する
      step("research");
      const found = (await (await post({ subject, step: "research" }, abort.signal)).json().catch(() => ({}))) as { brief?: { notes: string } | null };
      if (!alive()) return;
      step("design");
      const res = await post({ subject, notes: found.brief?.notes }, abort.signal);
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; model?: HoloModel; error?: string };
      if (!alive()) return;
      if (!res.ok || !json.ok || !json.model) throw new Error(json.error ?? "3D モデルを作れませんでした。");
      step("build");
      made = { name: json.model.title || subject, kind: "model", model: json.model };
    }
    addObject(made);
    running = null;
    dispatchKaren({ type: "JOB_DONE", jobId: id });
    notice(`${subject}の 3D ホログラムができました。ドラッグで視点を回し、オブジェクトを選ぶと動かせます。`, "info", io);
    flushQueue(io);
  } catch (err) {
    if (!alive()) return; // キャンセル・別の制作に替わった
    running = null;
    queued = [];
    const message = err instanceof Error && err.name !== "AbortError" ? err.message : "3D モデルを作れませんでした。";
    dispatchKaren({ type: "JOB_ERROR", jobId: id, error: message });
    notice(message, "error", io);
  }
}

/** 制作をキャンセルする（進行中の問い合わせも止める） */
export function cancelCreation(io?: KarenIo): boolean {
  if (!busy(getKarenState())) return false;
  running?.abort.abort();
  running = null;
  queued = [];
  dispatchKaren({ type: "CANCEL" });
  notice("制作をキャンセルしました。", "warn", io);
  return true;
}

function flushQueue(io?: KarenIo) {
  const ops = queued;
  queued = [];
  for (const op of ops) void runOp(op, io);
}

/* ---------- 操作の実行 ---------- */

function edit(io: KarenIo | undefined, apply: (o: SceneObject) => void): boolean {
  const o = target();
  if (!o) {
    notice("まだ編集するオブジェクトがありません。先に何かを作ってください（例：球体を作って）。", "warn", io);
    return false;
  }
  dispatchKaren({ type: "EDIT_START" });
  apply(o);
  dispatchKaren({ type: "EDIT_DONE" });
  return true;
}

async function runOp(op: KarenOp, io?: KarenIo): Promise<void> {
  // 制作中に届いた編集は、制作が終わってから当てる
  if (busy(getKarenState()) && !["cancel", "create-model", "idle", "ask", "unsupported"].includes(op.kind)) {
    queued.push(op);
    notice(`制作中です。終わったら「${describeOp(op)}」を反映します。`, "info", io, false);
    return;
  }
  switch (op.kind) {
    case "create-model": {
      if (busy(getKarenState())) notice("前の制作を止めて、新しい制作を始めます。", "warn", io, false);
      await createModel(op.subject, describeOp(op), io);
      return;
    }
    case "add-primitive": {
      dispatchKaren({ type: "START_CREATE", request: describeOp(op) });
      addObject({ name: SHAPE_LABEL[op.shape], kind: "primitive", shape: op.shape, color: "#2ee6ff" });
      return;
    }
    case "color":
      if (edit(io, (o) => updateObject(o.id, { color: op.color }))) notice(`${target()?.name ?? ""}を${op.label}にしました。`, "info", io, false);
      return;
    case "scale":
      edit(io, (o) => updateObject(o.id, { scale: o.scale.map((v) => Math.min(20, Math.max(0.05, v * op.factor))) as SceneObject["scale"] }));
      return;
    case "rotate":
      edit(io, (o) => {
        const r = [...o.rotation] as SceneObject["rotation"];
        r[{ x: 0, y: 1, z: 2 }[op.axis]] += (op.deg * Math.PI) / 180;
        updateObject(o.id, { rotation: r });
      });
      return;
    case "move":
      edit(io, (o) => {
        const p = [...o.position] as SceneObject["position"];
        p[{ x: 0, y: 1, z: 2 }[op.axis]] += op.amount;
        updateObject(o.id, { position: p });
      });
      return;
    case "delete":
      edit(io, (o) => removeObject(o.id));
      return;
    case "clear":
      if (!getScene().objects.length) return notice("シーンは空です。", "info", io, false);
      dispatchKaren({ type: "EDIT_START" });
      clearScene();
      dispatchKaren({ type: "EDIT_DONE" });
      return;
    case "reset-view":
      resetView();
      return;
    case "turntable":
      setTurntable(op.on);
      return;
    case "save":
      await saveCurrent(io);
      return;
    case "export":
      await exportGlb(io);
      return;
    case "render":
      await renderPng(io);
      return;
    case "unsupported":
      notice(`${op.what}は、まだ実装されていません（使える制作エンジンがありません）。今は 3D ホログラム・3D モデルの制作と編集ができます。`, "warn", io);
      return;
    case "cancel":
      if (!cancelCreation(io)) notice("いま進んでいる制作はありません。", "info", io, false);
      return;
    case "idle":
      if (busy(getKarenState())) cancelCreation(io);
      queued = [];
      dispatchKaren({ type: "RESET" });
      return;
    case "next":
      notice("次は何を作りますか？（例：未来都市の 3D ホログラムを作って）", "info", io);
      return;
    case "ask":
      notice(op.question, "info", io);
      return;
  }
}

/** K.A.R.E.N. への発言（声・文字）を受け取る。制作・編集なら実行し、それ以外は AI に渡す */
export async function handleKarenText(text: string, io: KarenIo = {}): Promise<void> {
  // 「戻りますか？」と確かめている最中の返事
  if (maybeExitAnswer(text, io)) return;
  dispatchKaren({ type: "HEARD", text });
  const { ops, chat } = parseKarenCommand(text);
  if (chat) {
    dispatchKaren({ type: "NOT_CREATIVE" });
    io.chat?.(text);
    return;
  }
  // 作る指示が無いときは、読み取りが終わったら元の状態へ（編集は EDITING を通る）
  if (!ops.some(startsCreation)) dispatchKaren({ type: "NOT_CREATIVE" });
  for (const op of ops) await runOp(op, io);
}

/** 画面のボタン・AI の返答から、制作を頼む */
export function requestCreation(subject: string, io?: KarenIo): void {
  void runOp({ kind: "create-model", subject }, io);
}

export function runKarenOp(op: KarenOp, io?: KarenIo): void {
  void runOp(op, io);
}

/* ---------- 保存・書き出し ---------- */

export async function saveCurrent(io?: KarenIo, name?: string): Promise<boolean> {
  const scene = getScene();
  if (!scene.objects.length) {
    notice("保存するオブジェクトがありません。", "warn", io, false);
    return false;
  }
  const id = scene.projectId ?? `prj-${Date.now().toString(36)}`;
  const projectName = name ?? scene.projectName ?? scene.objects[0].name;
  const ok = await saveProject({ id, name: projectName, savedAt: Date.now(), thumb: workspace?.thumbnail(), objects: scene.objects });
  if (ok) {
    setProject(id, projectName);
    notice(`「${projectName}」を保存しました（この端末の中）。`, "info", io, false);
  } else notice("保存できませんでした（この端末に保存できない設定かもしれません）。", "error", io, false);
  return ok;
}

export async function exportGlb(io?: KarenIo): Promise<void> {
  if (!getScene().objects.length) return notice("書き出すオブジェクトがありません。", "warn", io, false);
  const blob = await workspace?.exportGlb().catch(() => null);
  if (!blob) return notice("GLB に書き出せませんでした。", "error", io, false);
  download(blob, `${fileBase()}.glb`);
  notice("GLB ファイルに書き出しました。", "info", io, false);
}

export async function renderPng(io?: KarenIo): Promise<void> {
  const blob = await workspace?.renderPng().catch(() => null);
  if (!blob) return notice("画像を書き出せませんでした。", "error", io, false);
  download(blob, `${fileBase()}.png`);
  notice("いまの画面を PNG 画像に書き出しました。", "info", io, false);
}

/** 保存したプロジェクトを開く（既存の 3D モデルは読み直す） */
export async function openProject(p: { id: string; name: string; objects: Omit<SceneObject, "buffer">[] }, io?: KarenIo): Promise<void> {
  if (busy(getKarenState())) cancelCreation(io);
  const objects: SceneObject[] = [];
  let missing = 0;
  for (const o of p.objects) {
    if (o.kind === "asset" && o.asset) {
      const buffer = await downloadAsset(o.asset.url);
      if (!buffer) {
        missing++;
        continue;
      }
      objects.push({ ...o, buffer });
    } else objects.push({ ...o });
  }
  const { loadScene } = await import("./karen-scene");
  dispatchKaren({ type: "START_CREATE", request: `「${p.name}」を開く` });
  loadScene(objects, p.id, p.name);
  if (missing) notice(`${missing} 個の 3D モデルを読み込めませんでした（ネットワークを確認してください）。`, "warn", io, false);
}

/* ---------- F.R.I.D.A.Y. に戻る（制作中なら、続けるか止めるかを確かめる） ---------- */


let exitAsk = false;
const exitListeners = new Set<() => void>();
const setExitAsk = (v: boolean) => {
  exitAsk = v;
  exitListeners.forEach((l) => l());
};

export function useExitAsk(): boolean {
  return useSyncExternalStore(
    (fn) => {
      exitListeners.add(fn);
      return () => exitListeners.delete(fn);
    },
    () => exitAsk,
    () => false,
  );
}

/** F.R.I.D.A.Y. に戻りたい。制作中なら確かめる（戻ったら true） */
export function requestExit(io?: KarenIo): boolean {
  if (busy(getKarenState())) {
    setExitAsk(true);
    notice("制作の途中です。制作を続けたまま F.R.I.D.A.Y. に戻りますか？それとも止めて戻りますか？", "warn", io);
    return false;
  }
  setExitAsk(false);
  setAiMode("friday");
  return true;
}

/** 確かめた答え：continue（続けたまま戻る）／stop（止めて戻る）／stay（戻らない） */
export function answerExit(answer: "continue" | "stop" | "stay", io?: KarenIo): void {
  setExitAsk(false);
  if (answer === "stay") return notice("K.A.R.E.N. のまま制作を続けます。", "info", io);
  if (answer === "stop") cancelCreation(io);
  setAiMode("friday");
}

/** 確かめている最中の返事（声・文字）なら処理して true */
export function maybeExitAnswer(text: string, io?: KarenIo): boolean {
  if (!exitAsk) return false;
  if (/(止め|とめ|停止|やめ|中止|キャンセルして戻)/.test(text)) answerExit("stop", io);
  else if (/(続け|つづけ|そのまま|はい|戻って|もどって)/.test(text)) answerExit("continue", io);
  else if (/(戻らない|いいえ|待って|やっぱり)/.test(text)) answerExit("stay", io);
  else return false;
  return true;
}
