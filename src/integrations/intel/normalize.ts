/**
 * 情報源から来た 1 件を、安全な形に直す（文字の消毒・リンクの確認・座標の範囲・決まった値だけ通す）。
 * ここは保存・通知・脳（GitHub）への読み書きを一切読み込まない（確認用スクリプトからも安全に使えるように）。
 */
import { isSourceId } from "./sources";
import type { IntelCategory, IntelConfidence, IntelItem, IntelKind, IntelLevel, IntelPlace, IntelSourceRef } from "./types";

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
