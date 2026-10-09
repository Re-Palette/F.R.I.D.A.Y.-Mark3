/**
 * K.A.R.E.N. の制作ワークスペースの中身（シーンにあるオブジェクトの一覧と、選んでいるもの）。
 * 画面の 3D ビュー（KarenWorkspace）はこの一覧どおりに描き、ドラッグで動かした結果もここに書き戻す。
 * 保存・書き出し・音声の編集指示も、ここを通して行う（どこから操作しても同じ結果になるように）。
 */
import { useSyncExternalStore } from "react";
import type { HoloAsset, HoloModel } from "./hologram-schema";
import type { Shape } from "./karen-intent";

export type Vec3 = [number, number, number];

export interface SceneObject {
  id: string;
  name: string;
  kind: "primitive" | "model" | "asset";
  shape?: Shape;
  /** 部品で組み立てた 3D モデル（Gemini の設計図） */
  model?: HoloModel;
  /** 既存の 3D モデル（Poly Pizza の .glb）。buffer は読み込んだ中身（保存はしない。開くときに読み直す） */
  asset?: HoloAsset;
  buffer?: ArrayBuffer;
  /** 色（指定が無ければ、作ったときの色合いのまま） */
  color?: string;
  position: Vec3;
  /** ラジアン */
  rotation: Vec3;
  scale: Vec3;
}

export interface SceneState {
  objects: SceneObject[];
  selectedId: string | null;
  /** 回転アニメーション（ターンテーブル） */
  turntable: boolean;
  /** 視点を元に戻すたびに増える */
  viewResets: number;
  /** 開いているプロジェクト（保存し直すとき同じものを上書き） */
  projectId: string | null;
  projectName: string | null;
}

const EMPTY: SceneState = { objects: [], selectedId: null, turntable: false, viewResets: 0, projectId: null, projectName: null };
let state: SceneState = EMPTY;
const listeners = new Set<() => void>();
let seq = 0;

function set(next: Partial<SceneState>) {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}

export const getScene = () => state;

export function useScene(): SceneState {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    getScene,
    () => EMPTY,
  );
}

export const newObjectId = () => `obj-${Date.now().toString(36)}-${++seq}`;

/** 置き場所：先にあるものと重ならないよう、横に少しずつずらす */
function freeSpot(): Vec3 {
  const n = state.objects.length;
  if (!n) return [0, 0, 0];
  const step = 1.6;
  const i = n;
  const side = i % 2 ? 1 : -1;
  return [side * Math.ceil(i / 2) * step, 0, 0];
}

export function addObject(o: Omit<SceneObject, "id" | "position" | "rotation" | "scale"> & Partial<Pick<SceneObject, "position" | "rotation" | "scale">>): SceneObject {
  const obj: SceneObject = { id: newObjectId(), position: o.position ?? freeSpot(), rotation: o.rotation ?? [0, 0, 0], scale: o.scale ?? [1, 1, 1], ...o };
  set({ objects: [...state.objects, obj], selectedId: obj.id });
  return obj;
}

export function updateObject(id: string, patch: Partial<SceneObject>): void {
  if (!state.objects.some((o) => o.id === id)) return;
  set({ objects: state.objects.map((o) => (o.id === id ? { ...o, ...patch } : o)) });
}

export function removeObject(id: string): void {
  set({ objects: state.objects.filter((o) => o.id !== id), selectedId: state.selectedId === id ? null : state.selectedId });
}

export function selectObject(id: string | null): void {
  if (state.selectedId !== id) set({ selectedId: id });
}

/** 編集の対象：選んでいるもの、無ければ最後に足したもの */
export function target(): SceneObject | null {
  return state.objects.find((o) => o.id === state.selectedId) ?? state.objects[state.objects.length - 1] ?? null;
}

export function clearScene(): void {
  set({ objects: [], selectedId: null, turntable: false, projectId: null, projectName: null });
}

export function setTurntable(on: boolean): void {
  set({ turntable: on });
}

export function resetView(): void {
  set({ viewResets: state.viewResets + 1 });
}

export function loadScene(objects: SceneObject[], projectId: string, projectName: string): void {
  set({ objects, selectedId: null, projectId, projectName, viewResets: state.viewResets + 1 });
}

export function setProject(projectId: string, projectName: string): void {
  set({ projectId, projectName });
}
