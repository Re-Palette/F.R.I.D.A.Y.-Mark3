/**
 * K.A.R.E.N. のプロジェクトの保存（この端末の中だけ。IndexedDB）。RECENT PROJECTS はここから読む。
 * 既存の 3D モデル（Poly Pizza）は中身を保存せず、場所（URL）と作者の情報だけを保存して、開くときに読み直す。
 */
import { useSyncExternalStore } from "react";
import { getLocal, setLocal } from "./local-store";
import type { SceneObject } from "./karen-scene";

const KEY = "karen.projects.v1";
const MAX = 24;

export interface KarenProject {
  id: string;
  name: string;
  savedAt: number;
  /** 小さな画像（JPEG の data URL） */
  thumb?: string;
  objects: Omit<SceneObject, "buffer">[];
}

let projects: KarenProject[] | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export async function loadProjects(): Promise<KarenProject[]> {
  if (projects) return projects;
  projects = ((await getLocal<KarenProject[]>(KEY)) ?? []).filter((p) => p && Array.isArray(p.objects));
  emit();
  return projects;
}

/** 保存する（同じ id なら上書き）。保存できたら true */
export async function saveProject(p: KarenProject): Promise<boolean> {
  const list = await loadProjects();
  const objects = p.objects.map((o) => {
    const { buffer: _drop, ...rest } = o as SceneObject;
    void _drop;
    return rest;
  });
  const next = [{ ...p, objects }, ...list.filter((x) => x.id !== p.id)].slice(0, MAX);
  const ok = await setLocal(KEY, next);
  if (ok) {
    projects = next;
    emit();
  }
  return ok;
}

export async function deleteProject(id: string): Promise<boolean> {
  const list = await loadProjects();
  const next = list.filter((x) => x.id !== id);
  const ok = await setLocal(KEY, next);
  if (ok) {
    projects = next;
    emit();
  }
  return ok;
}

export function useProjects(): KarenProject[] | null {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      if (!projects) void loadProjects();
      return () => listeners.delete(fn);
    },
    () => projects,
    () => null,
  );
}
