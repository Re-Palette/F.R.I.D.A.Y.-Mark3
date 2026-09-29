/**
 * 画面の SETTINGS で変えられる設定（脳の「FRIDAY/設定.md」に保存。パソコンでもスマホでも同じ設定になる）。
 * ここに無い項目は環境変数（Vercel）の値を使う。
 */
import type { SearchMode } from "@/lib/config";
import { peek, prime, swr } from "@/lib/swr";
import { BRAIN_DIR, isBrainConfigured, listNotes, readNote, updateNote } from "@/memory/github-brain";

export const SETTINGS_PATH = `${BRAIN_DIR}/設定.md`;
const CACHE_KEY = "app-settings";

export type ReplyLength = "short" | "normal" | "long";

export interface AppSettings {
  /** 読み上げの速さ（0.7〜1.2。ElevenLabs はそのまま、ブラウザの声は換算して使う） */
  voiceSpeed?: number;
  /** 天気の場所 */
  weather?: { city: string; latitude: number; longitude: number };
  /** Web 検索 */
  search?: SearchMode;
  /** 返答の長さの好み */
  replyLength?: ReplyLength;
}

function parse(text: string): AppSettings {
  const json = /```json\s*([\s\S]*?)```/.exec(text)?.[1];
  if (!json) return {};
  try {
    return sanitize(JSON.parse(json) as Record<string, unknown>);
  } catch {
    return {};
  }
}

/** 読み込んだ・受け取った値を安全な形に整える（おかしな値は捨てる） */
export function sanitize(v: Record<string, unknown>): AppSettings {
  const out: AppSettings = {};
  const speed = Number(v.voiceSpeed);
  if (v.voiceSpeed !== undefined && Number.isFinite(speed)) out.voiceSpeed = Math.min(1.2, Math.max(0.7, Math.round(speed * 100) / 100));
  const w = v.weather as { city?: unknown; latitude?: unknown; longitude?: unknown } | undefined;
  if (w && typeof w.city === "string" && Number.isFinite(Number(w.latitude)) && Number.isFinite(Number(w.longitude))) {
    out.weather = { city: w.city.slice(0, 40), latitude: Number(w.latitude), longitude: Number(w.longitude) };
  }
  if (v.search === "auto" || v.search === "always" || v.search === "off") out.search = v.search;
  if (v.replyLength === "short" || v.replyLength === "normal" || v.replyLength === "long") out.replyLength = v.replyLength;
  return out;
}

function render(s: AppSettings): string {
  return `# 設定

F.R.I.D.A.Y. の画面の SETTINGS で変えた設定です（直接書き換えてもかまいません）。

\`\`\`json
${JSON.stringify(s, null, 2)}
\`\`\`
`;
}

async function load(): Promise<AppSettings> {
  const file = (await listNotes()).find((f) => f.path === SETTINGS_PATH);
  return file ? parse(await readNote(file)) : {};
}

/** 設定（30 秒以内は前回の結果、1 日以内なら前回の結果を返しつつ裏で取り直す） */
export function readAppSettings(): Promise<AppSettings> {
  if (!isBrainConfigured()) return Promise.resolve({});
  return swr(CACHE_KEY, 30_000, 24 * 60 * 60_000, load);
}

/** 待たずに使える設定（前回読んだもの）。裏で最新を読みにいく */
export function peekAppSettings(): AppSettings {
  if (!isBrainConfigured()) return {};
  readAppSettings().catch(() => {});
  return peek<AppSettings>(CACHE_KEY) ?? {};
}

/** 設定を変える（null を渡した項目は消して環境変数の値に戻す） */
export async function saveAppSettings(change: { [K in keyof AppSettings]?: AppSettings[K] | null }): Promise<AppSettings> {
  if (!isBrainConfigured()) throw new Error("設定の保存には脳（Obsidian）の接続が必要です。");
  let next: AppSettings = {};
  // 書き込む直前の最新の内容に重ねる（キャッシュの古い内容に重ねると、直前に変えた設定が消えるため）
  await updateNote(
    SETTINGS_PATH,
    (current) => {
      const merged: Record<string, unknown> = { ...(current ? parse(current) : {}) };
      for (const [k, v] of Object.entries(change)) {
        if (v === null) delete merged[k];
        else if (v !== undefined) merged[k] = v;
      }
      next = sanitize(merged);
      return render(next);
    },
    "F.R.I.D.A.Y.: 設定を変更",
  );
  prime(CACHE_KEY, next);
  return next;
}

/** 地名から緯度・経度を調べる（Open-Meteo の無料ジオコーディング） */
export async function geocode(name: string): Promise<{ city: string; latitude: number; longitude: number } | null> {
  const base = (process.env.GEOCODING_API_BASE?.trim() || "https://geocoding-api.open-meteo.com/v1").replace(/\/+$/, "");
  const res = await fetch(`${base}/search?name=${encodeURIComponent(name.trim())}&count=1&language=ja&format=json`, {
    signal: AbortSignal.timeout(6000),
    cache: "no-store",
  });
  if (!res.ok) return null;
  const hit = ((await res.json()) as { results?: { name: string; latitude: number; longitude: number }[] }).results?.[0];
  return hit ? { city: hit.name, latitude: hit.latitude, longitude: hit.longitude } : null;
}
