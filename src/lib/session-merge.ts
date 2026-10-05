/**
 * 会話の同期（スマホとパソコンで同じ会話を続けるため）。画面・サーバー両用の、まとめ方の決まり。
 *   - 両方の端末の発言を ID で合わせる（同じ発言は新しく届いた方を使う）
 *   - 「会話を消す」をした時刻（clearedAt）より前の発言は捨てる
 *   - 取り消した発言（返答のやり直しで消したもの）は removed に入れて、もう戻さない
 *   - 写真・ファイルの中身などの大きいものは同期しない（名前だけ）。直近 MAX_MESSAGES 件まで
 */
export const MAX_MESSAGES = 80;
const MAX_CONTENT = 12_000;
const MAX_REMOVED = 300;

/** 同期する発言（画面の UiMessage から、送ってよい小さな項目だけ） */
export interface SyncMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  status: "done" | "stopped";
  [key: string]: unknown;
}

export interface SyncedSession {
  messages: SyncMessage[];
  /** 最後に「会話を消す」をした時刻 */
  clearedAt: number;
  /** 取り消した発言の ID */
  removed: string[];
  /** サーバーに保存した時刻 */
  updatedAt: number;
}

export const emptySession = (): SyncedSession => ({ messages: [], clearedAt: 0, removed: [], updatedAt: 0 });

/** 一緒に同期する、返答に付いた小さな記録（予定の操作・出典など） */
const EXTRA_KEYS = ["meta", "memories", "calendar", "sources", "actions", "tabs", "newsSettings", "music"] as const;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** 1 件を同期できる形に整える（形がおかしいもの・途中のもの・エラーは同期しない） */
export function toSyncMessage(raw: unknown): SyncMessage | null {
  if (!isObj(raw)) return null;
  const { id, role, content, createdAt, status } = raw;
  if (typeof id !== "string" || !id || id.length > 64) return null;
  if (role !== "user" && role !== "assistant") return null;
  if (typeof content !== "string" || typeof createdAt !== "number" || !Number.isFinite(createdAt)) return null;
  if (status !== "done" && status !== "stopped") return null;
  if (!content.trim() && role === "user" && !Array.isArray(raw.files)) return null;
  const out: SyncMessage = { id, role, content: content.slice(0, MAX_CONTENT), createdAt, status };
  for (const key of EXTRA_KEYS) if (raw[key] !== undefined) out[key] = raw[key];
  // 書いた文書は題名と場所だけ（本文は脳に保存済み）
  if (Array.isArray(raw.documents)) {
    out.documents = raw.documents.filter(isObj).map(({ ok, title, path, updated, error }) => ({ ok, title, path, updated, error }));
  }
  // 添えたファイルは名前と種類だけ（小さな画像も送らない）
  if (Array.isArray(raw.files)) out.files = raw.files.filter(isObj).map(({ name, kind }) => ({ name, kind }));
  return out;
}

export function parseSession(text: string | null | undefined): SyncedSession {
  if (!text) return emptySession();
  try {
    const raw = JSON.parse(text) as unknown;
    if (!isObj(raw)) return emptySession();
    return {
      messages: Array.isArray(raw.messages) ? raw.messages.map(toSyncMessage).filter((m): m is SyncMessage => m !== null) : [],
      clearedAt: typeof raw.clearedAt === "number" ? raw.clearedAt : 0,
      removed: Array.isArray(raw.removed) ? raw.removed.filter((r): r is string => typeof r === "string").slice(-MAX_REMOVED) : [],
      updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : 0,
    };
  } catch {
    return emptySession();
  }
}

/** 2 つの会話を 1 つにまとめる（b が新しく届いた方） */
export function mergeSessions(a: SyncedSession, b: SyncedSession): SyncedSession {
  const clearedAt = Math.max(a.clearedAt, b.clearedAt);
  const removed = [...new Set([...a.removed, ...b.removed])].slice(-MAX_REMOVED);
  const gone = new Set(removed);
  const byId = new Map<string, SyncMessage>();
  for (const m of [...a.messages, ...b.messages]) {
    if (m.createdAt <= clearedAt || gone.has(m.id)) continue;
    const prev = byId.get(m.id);
    // 同じ発言なら、途中で止めたものより最後まで書いたものを使う
    if (!prev || !(prev.status === "done" && m.status === "stopped")) byId.set(m.id, m);
  }
  const messages = [...byId.values()].sort((x, y) => x.createdAt - y.createdAt).slice(-MAX_MESSAGES);
  return { messages, clearedAt, removed, updatedAt: Math.max(a.updatedAt, b.updatedAt) };
}
