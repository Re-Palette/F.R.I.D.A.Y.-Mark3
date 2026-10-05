/**
 * プッシュ通知（アプリを閉じていても、リマインダーや朝のニュースをスマホ・パソコンに届ける）。
 *
 *   端末で「受け取る」→ ブラウザの購読情報を脳の「.friday/push.json」に保存
 *   GitHub Actions が 5 分ごとに /api/cron/push を呼ぶ → 時間が来たものを全端末に送る
 *
 * 送信の署名には VAPID の鍵（VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY）を使う。
 */
import webpush, { type PushSubscription } from "web-push";
import { readFresh, updateNote } from "@/memory/github-brain";

const SUBS_PATH = ".friday/push.json";
const STATE_PATH = ".friday/push-state.json";

export interface StoredSubscription extends PushSubscription {
  /** どの端末か（表示用） */
  label: string;
  createdAt: string;
}

export interface PushPayload {
  title: string;
  body: string;
  /** 同じ tag の通知は上書きされる */
  tag?: string;
  /** タップしたときに開くページ */
  url?: string;
}

export function getPushConfig() {
  const publicKey = process.env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim();
  const subject = process.env.VAPID_SUBJECT?.trim() || "mailto:friday@example.com";
  return { publicKey, privateKey, subject, configured: Boolean(publicKey && privateKey) };
}

/** 新しい鍵のペアを作る（最初の設定用。作った鍵は Vercel の環境変数に入れる） */
export function generateKeys(): { publicKey: string; privateKey: string } {
  return webpush.generateVAPIDKeys();
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    const raw = await readFresh(path);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export async function listSubscriptions(): Promise<StoredSubscription[]> {
  return readJson<StoredSubscription[]>(SUBS_PATH, []);
}

const isSub = (v: unknown): v is PushSubscription => {
  const s = v as PushSubscription | null;
  return Boolean(s && typeof s.endpoint === "string" && /^https:\/\//.test(s.endpoint) && s.keys?.p256dh && s.keys?.auth);
};

/** この端末を通知の宛先に加える（同じ宛先なら上書き） */
export async function addSubscription(sub: unknown, label: string): Promise<number> {
  if (!isSub(sub)) throw new Error("通知の登録情報が正しくありません。");
  let count = 0;
  await updateNote(
    SUBS_PATH,
    (current) => {
      const list = (current ? (JSON.parse(current) as StoredSubscription[]) : []).filter((s) => s.endpoint !== sub.endpoint);
      list.push({ endpoint: sub.endpoint, keys: sub.keys, label: label.slice(0, 60) || "端末", createdAt: new Date().toISOString() });
      count = list.length;
      return JSON.stringify(list.slice(-10), null, 1);
    },
    "F.R.I.D.A.Y.: 通知の宛先を追加",
  );
  return count;
}

export async function removeSubscription(endpoints: string[]): Promise<void> {
  if (!endpoints.length) return;
  await updateNote(
    SUBS_PATH,
    (current) => JSON.stringify((current ? (JSON.parse(current) as StoredSubscription[]) : []).filter((s) => !endpoints.includes(s.endpoint)), null, 1),
    "F.R.I.D.A.Y.: 通知の宛先を削除",
  );
}

/** 通知を送る（宛先を指定しなければ全端末）。もう無効な宛先は自動で消す。届いた数を返す */
export async function sendPush(payload: PushPayload, only?: string): Promise<number> {
  const c = getPushConfig();
  if (!c.configured) throw new Error("プッシュ通知の鍵（VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY）が設定されていません。");
  webpush.setVapidDetails(c.subject, c.publicKey!, c.privateKey!);
  const subs = (await listSubscriptions()).filter((s) => !only || s.endpoint === only);
  const gone: string[] = [];
  let sent = 0;
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, JSON.stringify(payload), { TTL: 60 * 60, urgency: "high" });
        sent++;
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) gone.push(s.endpoint); // 端末側で解除された
        else console.warn("[friday] push failed:", status ?? err);
      }
    }),
  );
  await removeSubscription(gone).catch(() => {});
  return sent;
}

/* ---------- 送ったかどうかの記録（朝のニュースは 1 日 1 回） ---------- */

export interface PushState {
  newsDate?: string;
  /** 週の振り返りを作った日（日曜の日付） */
  weeklyDate?: string;
  /** 出かける前の知らせを送った予定（id:開始時刻） */
  departed?: string[];
}

export async function readPushState(): Promise<PushState> {
  return readJson<PushState>(STATE_PATH, {});
}

export async function writePushState(state: PushState): Promise<void> {
  await updateNote(STATE_PATH, () => JSON.stringify(state), "F.R.I.D.A.Y.: 通知の記録");
}
