/**
 * E.D.I.T.H. の情報収集の設定。脳の「EDITH/情報収集設定.md」に置く（Obsidian で書き換えられる）。
 *
 * - ノートが無いときだけ、既定の内容で作る（あるノートは上書きしない）
 * - 環境変数 EDITH_INTEL=on のときだけ動く（既定は止まっている。止めたいときは off に戻すか、ノートの「全体」を OFF）
 * - 鍵が必要な情報源は、鍵が登録されるまで ON にしても動かさない
 */
import { type IntelBrainIO, INTEL_SETTINGS_PATH } from "./brain-io";
import { hasRequiredKey, INTEL_SOURCES, isSourceId, sourceDef } from "./sources";
import type { IntelSourceId } from "./types";

export interface IntelSettings {
  /** ノートの「全体」 */
  enabled: boolean;
  /** 情報源ごとの ON/OFF（ノートの指定。鍵・実装の有無は含まない） */
  sources: Record<IntelSourceId, boolean>;
  /** 通知を送るか */
  notify: boolean;
  /** 静かな時間帯（"23:00"〜"07:00"）。null なら無し */
  quiet: { from: string; to: string } | null;
  /** 1 日に送る重要な通知の上限（緊急は別枠） */
  dailyLimit: number;
  /** 注目キーワード（プロジェクト名・関心のある技術など） */
  keywords: string[];
  /** 脳のノートから読んだか（false なら既定値） */
  fromBrain: boolean;
}

const DEFAULT_QUIET = { from: "23:00", to: "07:00" };
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;
const MAX_KEYWORDS = 20;

export function defaultSettings(): IntelSettings {
  return {
    enabled: true,
    sources: Object.fromEntries(INTEL_SOURCES.map((s) => [s.id, s.defaultOn])) as Record<IntelSourceId, boolean>,
    notify: true,
    quiet: { ...DEFAULT_QUIET },
    dailyLimit: DEFAULT_LIMIT,
    keywords: [],
    fromBrain: false,
  };
}

const toHalf = (s: string) => s.replace(/[０-９：]/g, (c) => (c === "：" ? ":" : String.fromCharCode(c.charCodeAt(0) - 0xfee0)));

function onOff(v: string): boolean | null {
  const t = toHalf(v).trim().toLowerCase();
  if (/^(on|オン|有効|使う|はい|yes|true)$/.test(t)) return true;
  if (/^(off|オフ|無効|使わない|いいえ|no|false|停止)$/.test(t)) return false;
  return null;
}

function hhmm(v: string): string | null {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(toHalf(v).trim());
  return m ? `${m[1].padStart(2, "0")}:${m[2]}` : null;
}

/** ノートの本文から設定を読む（読めない行は既定値のまま） */
export function parseSettingsNote(text: string): IntelSettings {
  const s = { ...defaultSettings(), fromBrain: true };
  let section = "";
  for (const raw of text.split("\n")) {
    const h = /^##\s+(.*)$/.exec(raw);
    if (h) {
      section = h[1].trim();
      continue;
    }
    const line = raw.replace(/^\s*[-・*]\s*/, "").trim();
    if (!line) continue;
    if (/^全体/.test(section)) {
      const v = onOff(line);
      if (v !== null) s.enabled = v;
    } else if (/^情報源/.test(section)) {
      // 「USGS 地震（usgs）: ON」— 括弧の中の ID で見分ける
      const m = /[（(]\s*([a-z]+)\s*[)）]\s*[:：]\s*(\S+)/i.exec(line);
      if (m && isSourceId(m[1].toLowerCase())) {
        const v = onOff(m[2]);
        if (v !== null) s.sources[m[1].toLowerCase() as IntelSourceId] = v;
      }
    } else if (/^通知/.test(section)) {
      const v = onOff(line);
      if (v !== null) s.notify = v;
    } else if (/^静かな時間/.test(section)) {
      if (onOff(line) === false || /^なし$/.test(line)) s.quiet = null;
      else {
        const m = /^(\S+)\s*[-〜~－]\s*(\S+)$/.exec(toHalf(line));
        const from = m && hhmm(m[1]);
        const to = m && hhmm(m[2]);
        if (from && to) s.quiet = { from, to };
      }
    } else if (/上限/.test(section)) {
      const n = Number.parseInt(toHalf(line), 10);
      if (Number.isFinite(n)) s.dailyLimit = Math.max(0, Math.min(MAX_LIMIT, n));
    } else if (/キーワード/.test(section)) {
      const k = line.slice(0, 40);
      if (k && !s.keywords.includes(k) && s.keywords.length < MAX_KEYWORDS) s.keywords.push(k);
    }
  }
  return s;
}

/** 初めて作るときの設定ノート */
export function renderSettingsNote(s: IntelSettings = defaultSettings()): string {
  const src = INTEL_SOURCES.map((d) => `- ${d.label}（${d.id}）: ${s.sources[d.id] ? "ON" : "OFF"}${d.needsEnv ? `　※鍵 ${d.needsEnv} が必要` : ""}`).join("\n");
  return `# E.D.I.T.H. 情報収集の設定

E.D.I.T.H. が世界の公開情報を自動で集め、重要なものだけ通知します。この設定は自由に書き換えられます。
「全体」を OFF にすると、すぐに止まります。

## 全体
${s.enabled ? "ON" : "OFF"}

## 情報源
${src}

## 通知
${s.notify ? "ON" : "OFF"}

## 静かな時間帯
${s.quiet ? `${s.quiet.from}-${s.quiet.to}` : "なし"}

## 1日の通知の上限
${s.dailyLimit}

## 注目キーワード
${s.keywords.length ? s.keywords.map((k) => `- ${k}`).join("\n") : "- "}
`;
}

/** 設定を読む（ノートが無ければ既定値。ノートは作らない） */
export async function readIntelSettings(io: IntelBrainIO): Promise<IntelSettings> {
  if (!io.configured()) return defaultSettings();
  const text = await io.read(INTEL_SETTINGS_PATH);
  return text === null ? defaultSettings() : parseSettingsNote(text);
}

/** 設定ノートが無ければ既定の内容で作る（あれば何もしない＝上書きしない） */
export async function ensureSettingsNote(io: IntelBrainIO): Promise<{ created: boolean }> {
  let created = false;
  await io.update(
    INTEL_SETTINGS_PATH,
    (current) => {
      if (current !== null) {
        created = false;
        return current;
      }
      created = true;
      return renderSettingsNote();
    },
    "E.D.I.T.H.: 情報収集の設定を作成",
  );
  return { created };
}

/** 環境変数で動かしてよいか（EDITH_INTEL=on のときだけ） */
export function intelAllowedByEnv(env: Record<string, string | undefined> = process.env): boolean {
  return /^(on|true|1)$/i.test(env.EDITH_INTEL?.trim() ?? "");
}

/** 実際に動かす情報源（ノートで ON・実装済み・鍵がそろっている） */
export function activeSources(s: IntelSettings, env: Record<string, string | undefined> = process.env): IntelSourceId[] {
  if (!s.enabled || !intelAllowedByEnv(env)) return [];
  return INTEL_SOURCES.filter((d) => s.sources[d.id] && d.ready && hasRequiredKey(d, env)).map((d) => d.id);
}

/** 情報源が動かない理由（画面・記録用。動くなら null） */
export function inactiveReason(id: IntelSourceId, s: IntelSettings, env: Record<string, string | undefined> = process.env): string | null {
  const d = sourceDef(id);
  if (!d) return "不明な情報源";
  if (!intelAllowedByEnv(env)) return "情報収集が止まっています（EDITH_INTEL）";
  if (!s.enabled) return "設定ノートで全体が OFF";
  if (!s.sources[id]) return "設定ノートで OFF";
  if (!d.ready) return "準備中";
  if (!hasRequiredKey(d, env)) return `鍵（${d.needsEnv}）が未登録`;
  return null;
}

/** いまが静かな時間帯か（日付をまたぐ指定にも対応） */
export function inQuietHours(s: Pick<IntelSettings, "quiet">, localTime: string): boolean {
  if (!s.quiet) return false;
  const { from, to } = s.quiet;
  if (from === to) return false;
  return from < to ? localTime >= from && localTime < to : localTime >= from || localTime < to;
}
