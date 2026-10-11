/**
 * E.D.I.T.H. が集めた情報の保存（.friday/intel/items.json）。
 *
 * - 同じ ID の情報は 1 件にまとめる（続報なら中身を新しくし、初めて見た時刻は残す）
 * - 直近 14 日分・最大 1,200 件だけ残す（GitHub の API で読める大きさに収める）
 * - 外から来た文字は、長さを切り、制御文字を除き、リンクは http(s) だけにする
 * 書くのは、実行中の印を持っている実行だけ（state.ts の acquireRun / stillOwner）。
 */
import { type IntelBrainIO, INTEL_ITEMS_PATH } from "./brain-io";
import { isSourceId } from "./sources";
import type { IntelCategory, IntelConfidence, IntelItem, IntelKind, IntelLevel, IntelPlace, IntelSourceRef } from "./types";

export const RETENTION_MS = 14 * 24 * 60 * 60_000;
export const MAX_ITEMS = 1200;
/** GitHub の Contents API は 1MB を超えると中身を返さないので、それより小さく保つ */
export const MAX_BYTES = 700_000;

const KINDS: IntelKind[] = ["official", "report", "ai-search", "research"];
const CATEGORIES: IntelCategory[] = ["disaster", "weather", "world", "tech", "business", "science", "space", "government"];
const LEVELS: IntelLevel[] = ["urgent", "high", "normal", "low"];
const CONFIDENCES: IntelConfidence[] = ["high", "medium", "low"];

/** 外から来た文字をきれいにする（制御文字・余分な空白を除き、長さを切る） */
export function cleanText(v: unknown, max: number): string {
  return String(v ?? "")
    .replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** http(s) のリンクだけ通す */
export function safeUrl(v: unknown): string | null {
  try {
    const u = new URL(String(v ?? ""));
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString().slice(0, 500) : null;
  } catch {
    return null;
  }
}

function isoOrNull(v: unknown): string | null {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const t = typeof v === "number" ? v : Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function place(v: unknown): IntelPlace | null {
  const p = v as Partial<IntelPlace> | null;
  if (!p || typeof p !== "object") return null;
  const lat = Number(p.lat);
  const lon = Number(p.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { name: cleanText(p.name, 60), lat, lon };
}

function refs(v: unknown): IntelSourceRef[] {
  if (!Array.isArray(v)) return [];
  const out: IntelSourceRef[] = [];
  for (const r of v as Partial<IntelSourceRef>[]) {
    const url = safeUrl(r?.url);
    if (url && !out.some((o) => o.url === url)) out.push({ url, name: cleanText(r?.name, 60) });
  }
  return out.slice(0, 10);
}

function facts(v: unknown): IntelItem["facts"] {
  const out: IntelItem["facts"] = {};
  if (!v || typeof v !== "object") return out;
  for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, 20)) {
    if (typeof x === "number" && Number.isFinite(x)) out[cleanText(k, 30)] = x;
    else if (typeof x === "boolean" || x === null) out[cleanText(k, 30)] = x;
    else if (typeof x === "string") out[cleanText(k, 30)] = cleanText(x, 120);
  }
  return out;
}

const pick = <T extends string>(v: unknown, list: T[], fallback: T): T => (list.includes(v as T) ? (v as T) : fallback);

/** 1 件を安全な形に直す（必須の項目が無ければ null） */
export function normalizeItem(raw: unknown, fetchedAtFallback = new Date().toISOString()): IntelItem | null {
  const r = raw as Partial<IntelItem> | null;
  if (!r || typeof r !== "object") return null;
  const id = cleanText(r.id, 160);
  const source = String(r.source ?? "");
  const title = cleanText(r.title, 200);
  if (!id || !title || !isSourceId(source)) return null;
  const fetchedAt = isoOrNull(r.fetchedAt) ?? fetchedAtFallback;
  return {
    id,
    source,
    kind: pick(r.kind, KINDS, "report"),
    category: pick(r.category, CATEGORIES, "world"),
    title,
    summary: cleanText(r.summary, 400),
    url: safeUrl(r.url),
    publishedAt: isoOrNull(r.publishedAt),
    updatedAt: isoOrNull(r.updatedAt),
    fetchedAt,
    firstSeenAt: isoOrNull(r.firstSeenAt) ?? fetchedAt,
    place: place(r.place),
    level: pick(r.level, LEVELS, "normal"),
    confidence: pick(r.confidence, CONFIDENCES, "low"),
    reasons: Array.isArray(r.reasons) ? r.reasons.map((x) => cleanText(x, 120)).filter(Boolean).slice(0, 6) : [],
    corroboration: refs(r.corroboration),
    clusterId: r.clusterId ? cleanText(r.clusterId, 160) : null,
    conflicts: Array.isArray(r.conflicts) ? r.conflicts.map((x) => cleanText(x, 160)).filter(Boolean).slice(0, 6) : [],
    facts: facts(r.facts),
  };
}

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
    map.set(i.id, prev ? { ...i, firstSeenAt: prev.firstSeenAt < i.firstSeenAt ? prev.firstSeenAt : i.firstSeenAt } : i);
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
