/**
 * E.D.I.T.H. が集めた情報の保存（.friday/intel/items.json）。
 *
 * - 同じ ID の情報は 1 件にまとめる（続報なら中身を新しくし、初めて見た時刻は残す。古い発表では上書きしない）
 * - 直近 14 日分・最大 1,200 件だけ残す（GitHub の API で読める大きさに収める）
 * - 外から来た文字は、長さを切り、制御文字を除き、リンクは http(s) だけにする
 * 書くのは、実行中の印を持っている実行だけ（state.ts の acquireRun / stillOwner）。
 */
import { type IntelBrainIO, INTEL_ITEMS_PATH } from "./brain-io";
import { normalizeItem } from "./normalize";
import type { IntelItem } from "./types";

// 以前からの読み込み先（store）でも使えるように
export { cleanText, normalizeItem, safeUrl } from "./normalize";

export const RETENTION_MS = 14 * 24 * 60 * 60_000;
export const MAX_ITEMS = 1200;
/** GitHub の Contents API は 1MB を超えると中身を返さないので、それより小さく保つ */
export const MAX_BYTES = 700_000;

export function parseItems(raw: string | null): IntelItem[] {
  if (!raw) return [];
  try {
    const j = JSON.parse(raw) as { items?: unknown[] } | unknown[];
    const list = Array.isArray(j) ? j : (j.items ?? []);
    return list.map((x) => normalizeItem(x)).filter((x): x is IntelItem => x !== null);
  } catch {
    return [];
  }
}

const itemTime = (i: IntelItem) => Date.parse(i.publishedAt ?? i.firstSeenAt);

/**
 * 新しく取れた情報を、保存済みの情報に足す。
 * 同じ ID は 1 件に（初めて見た時刻は残し、中身は新しいほう）。古いもの・多すぎる分は捨てる。
 */
export function mergeItems(existing: IntelItem[], incoming: IntelItem[], now = Date.now()): IntelItem[] {
  const map = new Map<string, IntelItem>();
  for (const i of existing) map.set(i.id, i);
  for (const i of incoming) {
    const prev = map.get(i.id);
    if (!prev) {
      map.set(i.id, i);
      continue;
    }
    // 古い発表が、すでにある新しい発表を上書きしないようにする（取りこぼしを補って古い電文を読んだときなど）
    if (prev.updatedAt && i.updatedAt && i.updatedAt < prev.updatedAt) continue;
    map.set(i.id, { ...i, firstSeenAt: prev.firstSeenAt < i.firstSeenAt ? prev.firstSeenAt : i.firstSeenAt });
  }
  return [...map.values()]
    .filter((i) => now - (Number.isFinite(itemTime(i)) ? itemTime(i) : now) <= RETENTION_MS)
    .sort((a, b) => itemTime(b) - itemTime(a))
    .slice(0, MAX_ITEMS);
}

/** 保存する文字列（大きすぎれば古いものから減らす） */
export function serializeItems(items: IntelItem[]): string {
  let list = items;
  let text = JSON.stringify({ version: 1, items: list });
  while (Buffer.byteLength(text, "utf8") > MAX_BYTES && list.length > 0) {
    list = list.slice(0, Math.floor(list.length * 0.9));
    text = JSON.stringify({ version: 1, items: list });
  }
  return text;
}

export async function readItems(io: IntelBrainIO): Promise<IntelItem[]> {
  if (!io.configured()) return [];
  return parseItems(await io.read(INTEL_ITEMS_PATH));
}

/** 新しい情報を足して保存する（呼ぶ前に stillOwner で印を確かめること） */
export async function saveItems(io: IntelBrainIO, incoming: IntelItem[], now = Date.now()): Promise<IntelItem[]> {
  let merged: IntelItem[] = [];
  await io.update(
    INTEL_ITEMS_PATH,
    (current) => {
      merged = mergeItems(parseItems(current), incoming, now);
      return serializeItems(merged);
    },
    "E.D.I.T.H.: 集めた情報を保存",
  );
  return merged;
}
