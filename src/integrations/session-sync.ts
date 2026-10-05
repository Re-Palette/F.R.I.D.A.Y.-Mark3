/**
 * 会話の同期の保存先。脳（GitHub のリポジトリ）の「.friday/session.json」に置く。
 * 「.」で始まるフォルダなので Obsidian には出てこない。スマホとパソコンが同じ会話を読み書きする。
 */
import { readFresh, updateNote } from "@/memory/github-brain";
import { emptySession, mergeSessions, parseSession, type SyncedSession } from "@/lib/session-merge";

export const SESSION_PATH = ".friday/session.json";

export async function readSession(): Promise<SyncedSession> {
  return parseSession(await readFresh(SESSION_PATH));
}

/** 届いた会話を保存中のものとまとめて保存し、まとめた結果を返す */
export async function saveSession(incoming: SyncedSession): Promise<SyncedSession> {
  let merged = emptySession();
  await updateNote(
    SESSION_PATH,
    (current) => {
      const base = parseSession(current);
      merged = mergeSessions(base, incoming);
      // 中身が変わらなければ書き込まない（updatedAt だけ変えて毎回コミットしないように）
      const same = JSON.stringify({ ...base, updatedAt: 0 }) === JSON.stringify({ ...merged, updatedAt: 0 });
      merged.updatedAt = same ? base.updatedAt : Date.now();
      return same && current ? current : JSON.stringify(merged);
    },
    "FRIDAY: 会話を同期",
  );
  return merged;
}
