/**
 * LINE（Messaging API）から F.R.I.D.A.Y. に話しかける（サーバー専用）。
 *   - 届いたメッセージ（文字・声・写真）を、パソコンの画面と同じ会話の仕組み（handleConversation）で答える
 *     予定・ToDo・リマインダー・覚えること・資料・メールの下書きなどの操作もできる（カレンダー・Gmail は GOOGLE_REFRESH_TOKEN の接続を使う）
 *   - 会話は脳（Obsidian）の会話ログに残り、関連する脳のノートを探して答える。使ったノートの名前を返事の最後に添える（引用）
 *   - 「メモ：〜」は AI を通さず、脳の「メモ/LINE/YYYY-MM-DD.md」に書く
 *   - 直前の会話（16 件）は脳の .friday/line/ に置く（Obsidian には出てこない）。続けて話しても話が通じる
 *   - キー：LINE_CHANNEL_SECRET（通知の署名を確かめる）・LINE_CHANNEL_ACCESS_TOKEN（返事を送る）。画面・ログには出さない
 */
import { createHash } from "node:crypto";
import { handleConversation } from "@/core/friday";
import type { ChatMessage, StreamEvent } from "@/core/types";
import { CalendarAccess, getCalendarConfig, hasComposeScope, isCalendarConfigured } from "@/integrations/google-calendar";
import { createDraft, recentMail, unreadMail } from "@/integrations/gmail";
import { getTimezone } from "@/lib/config";
import { allowedLineUsers, parseMemoCommand, plainForLine, splitForLine, type LineIncoming } from "@/lib/line";
import { isBrainConfigured, readFresh, updateNote } from "@/memory/github-brain";
import { getLongTermMemory, type SaveTurnInput } from "@/memory/long-term";

const API = "https://api.line.me/v2/bot";
const DATA_API = "https://api-data.line.me/v2/bot";
/** 声・写真の大きさの上限（これより大きいものは受け取らない） */
const MAX_CONTENT_BYTES = 8_000_000;
const HISTORY_MAX = 16;
/** 返事を作る時間の上限（LINE の返事の権利は長く待つと使えなくなる） */
const ANSWER_TIMEOUT_MS = 45_000;

export function lineConfig(env: Record<string, string | undefined> = process.env): { secret: string; token: string } | null {
  const secret = env.LINE_CHANNEL_SECRET?.trim();
  const token = env.LINE_CHANNEL_ACCESS_TOKEN?.trim();
  return secret && token ? { secret, token } : null;
}

type FetchLike = typeof fetch;

/* ---------- LINE への送信 ---------- */

async function lineCall(token: string, path: string, body: unknown, fetchImpl: FetchLike): Promise<Response> {
  return fetchImpl(`${API}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
}

/** 返事を送る。返事の権利（replyToken）が切れていたら、push で送る（push は無料の月の通数に数える） */
export async function sendLine(token: string, to: { replyToken: string; userId: string }, texts: string[], fetchImpl: FetchLike = fetch): Promise<"reply" | "push" | "failed"> {
  const messages = texts.slice(0, 5).map((text) => ({ type: "text", text }));
  try {
    const r = await lineCall(token, "/message/reply", { replyToken: to.replyToken, messages }, fetchImpl);
    if (r.ok) return "reply";
  } catch {
    /* push を試す */
  }
  try {
    const p = await lineCall(token, "/message/push", { to: to.userId, messages }, fetchImpl);
    return p.ok ? "push" : "failed";
  } catch {
    return "failed";
  }
}

/**
 * F.R.I.D.A.Y. から LINE に知らせる（リマインダー・出発の時間など。5 分ごとの見回り /api/cron/push から）。
 * 登録した人（LINE_ALLOWED_USER_IDS）全員に push で送る（LINE の無料の枠：月 200 通まで）。送れた人数を返す
 */
export async function notifyLine(title: string, body: string, opts: { env?: Record<string, string | undefined>; fetchImpl?: FetchLike } = {}): Promise<number> {
  const env = opts.env ?? process.env;
  const cfg = lineConfig(env);
  if (!cfg) return 0;
  let sent = 0;
  for (const userId of allowedLineUsers(env)) {
    try {
      const r = await lineCall(cfg.token, "/message/push", { to: userId, messages: [{ type: "text", text: `${title}\n${body}`.slice(0, 4900) }] }, opts.fetchImpl ?? fetch);
      if (r.ok) sent++;
    } catch {
      /* 次の人へ */
    }
  }
  return sent;
}

/** LINE に知らせられるか（設定と、登録した人がいるか） */
export const canNotifyLine = (env: Record<string, string | undefined> = process.env) => Boolean(lineConfig(env)) && allowedLineUsers(env).size > 0;

/** 考えている間、トークに「…」を出す（届かなくても会話は続ける） */
export async function showLoading(token: string, userId: string, fetchImpl: FetchLike = fetch): Promise<void> {
  await lineCall(token, "/chat/loading/start", { chatId: userId, loadingSeconds: 60 }, fetchImpl).catch(() => undefined);
}

/** 声・写真の中身を受け取る（base64） */
export async function lineContent(token: string, messageId: string, fetchImpl: FetchLike = fetch): Promise<{ mimeType: string; data: string } | null> {
  try {
    const r = await fetchImpl(`${DATA_API}/message/${encodeURIComponent(messageId)}/content`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length || buf.length > MAX_CONTENT_BYTES) return null;
    return { mimeType: (r.headers.get("content-type") ?? "").split(";")[0].trim(), data: buf.toString("base64") };
  } catch {
    return null;
  }
}

/* ---------- 直前の会話（脳の .friday/line/） ---------- */

interface StoredTurn {
  role: "user" | "assistant";
  content: string;
  at: number;
}
const historyPath = (userId: string) => `.friday/line/${createHash("sha256").update(userId).digest("hex").slice(0, 16)}.json`;

function parseHistory(raw: string | null): StoredTurn[] {
  try {
    const j = JSON.parse(raw ?? "[]") as unknown;
    if (!Array.isArray(j)) return [];
    return j
      .filter((t): t is StoredTurn => !!t && (t.role === "user" || t.role === "assistant") && typeof t.content === "string" && typeof t.at === "number")
      .slice(-HISTORY_MAX);
  } catch {
    return [];
  }
}

/* ---------- 脳へのメモ ---------- */

const ymd = (d: Date, tz: string) => new Intl.DateTimeFormat("sv-SE", { timeZone: tz }).format(d);
const hm = (d: Date, tz: string) => new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(d);

export function memoPath(now: Date, tz: string): string {
  return `メモ/LINE/${ymd(now, tz)}.md`;
}

/* ---------- 1 通を処理する ---------- */

export interface LineDeps {
  fetchImpl?: FetchLike;
  now?: () => Date;
  env?: Record<string, string | undefined>;
  /** 会話（テスト用に差し替える） */
  converse?: (history: ChatMessage[], signal: AbortSignal, onTurn: (t: SaveTurnInput | null) => void) => AsyncGenerator<StreamEvent>;
  brain?: { configured: boolean; read: (path: string) => Promise<string | null>; update: (path: string, f: (cur: string | null) => string, message: string) => Promise<void> };
  recall?: (query: string, history: ChatMessage[]) => Promise<{ source: string; title?: string }[]>;
  save?: (turn: SaveTurnInput) => Promise<void>;
}

/** 返事のうしろに添える一言（操作したこと）。画面でしかできない操作は、画面で頼むよう伝える */
export function describeEvent(e: StreamEvent): string | null {
  switch (e.type) {
    case "calendar":
      return e.ok ? `📅 予定を${e.action === "add" ? "追加" : e.action === "update" ? "変更" : "削除"}しました：${e.title}（${e.when}）` : `⚠️ 予定の操作に失敗しました：${e.error ?? e.title}`;
    case "action":
      return e.ok ? `✅ ${e.label}` : `⚠️ ${e.label}：${e.error ?? "できませんでした"}`;
    case "document":
      return e.ok ? `📄 資料を${e.updated ? "更新" : "作成"}しました：${e.title}${e.path ? `（脳の ${e.path}）` : ""}` : `⚠️ 資料を作れませんでした：${e.error ?? e.title}`;
    case "mail-draft":
      return e.ok ? `✉️ Gmail に下書きを作りました：${e.to}「${e.subject}」（送信はしていません）` : `⚠️ 下書きを作れませんでした：${e.error ?? ""}`;
    case "memory":
      return `🧠 覚えました：${e.text}`;
    case "browser":
      return e.action === "open" ? `🖥 「${e.label}」を開くのは、パソコンの F.R.I.D.A.Y. の画面から頼んでください` : null;
    case "music":
      return `🎵 音楽の操作は、パソコンの F.R.I.D.A.Y. の画面から頼んでください`;
    case "hologram":
      return `🔷 ホログラムは、パソコンの F.R.I.D.A.Y. の画面で表示します`;
    case "focus":
      return `⏱ 集中モードは、パソコンの F.R.I.D.A.Y. の画面で始めてください`;
    default:
      return null;
  }
}

/** 届いた 1 通に答えて、返事の文（LINE の吹き出しごと）を返す */
export async function answerLine(ev: LineIncoming, deps: LineDeps = {}): Promise<string[]> {
  const env = deps.env ?? process.env;
  const cfg = lineConfig(env);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now?.() ?? new Date();
  const tz = getTimezone();
  const brain = deps.brain ?? { configured: isBrainConfigured(), read: (p: string) => readFresh(p), update: (p: string, f: (c: string | null) => string, m: string) => updateNote(p, f, m) };

  // 話してよい人か（登録されていなければ、登録に使う ID だけ伝える）
  if (!allowedLineUsers(env).has(ev.userId)) {
    return [`このアカウントは、まだ F.R.I.D.A.Y. に登録されていません。\n持ち主の方なら、Vercel の環境変数 LINE_ALLOWED_USER_IDS に次の ID を入れて、再デプロイしてください。\n\n${ev.userId}`];
  }

  // メモ：AI を通さず、そのまま脳に書く
  if (ev.kind === "text") {
    const memo = parseMemoCommand(ev.text);
    if (memo) {
      if (!brain.configured) return ["脳（Obsidian）がつながっていないため、メモを書けませんでした。"];
      const path = memoPath(now, tz);
      try {
        await brain.update(
          path,
          (cur) => `${cur?.trimEnd() || `# LINE のメモ ${ymd(now, tz)}`}\n- ${hm(now, tz)} ${memo.replace(/\n+/g, " ")}\n`,
          "FRIDAY: LINE のメモ",
        );
        return [`📝 脳に記録しました（${path}）\n${memo}`];
      } catch {
        return ["脳への書き込みに失敗しました。少し待ってから、もう一度送ってください。"];
      }
    }
  }
  if (ev.kind === "other") return ["文字・声（ボイスメッセージ）・写真で話しかけてください。"];

  // 届いたもの → 会話の最後の発言
  let user: ChatMessage;
  if (ev.kind === "text") user = { role: "user", content: ev.text };
  else {
    const content = cfg ? await lineContent(cfg.token, ev.messageId, fetchImpl) : null;
    if (!content) return [ev.kind === "audio" ? "声を受け取れませんでした（長すぎる・形式が違う）。もう一度送ってください。" : "写真を受け取れませんでした。もう一度送ってください。"];
    if (ev.kind === "audio") user = { role: "user", content: "", audio: { mimeType: content.mimeType === "audio/x-m4a" || !content.mimeType ? "audio/mp4" : content.mimeType, data: content.data } };
    else {
      const mime = content.mimeType === "image/png" || content.mimeType === "image/webp" ? content.mimeType : "image/jpeg";
      user = { role: "user", content: "この写真を見て、分かることを教えて", image: { mimeType: mime, data: content.data } };
    }
  }

  // 直前の会話
  const path = historyPath(ev.userId);
  const past = brain.configured ? parseHistory(await brain.read(path).catch(() => null)) : [];
  const history: ChatMessage[] = [...past.map((t) => ({ role: t.role, content: t.content })), user];

  // 答える（予定・メールは、全端末共通の Google の接続があれば使える）
  const converse =
    deps.converse ??
    ((h: ChatMessage[], signal: AbortSignal, onTurn: (t: SaveTurnInput | null) => void) => {
      const c = getCalendarConfig();
      const refresh = isCalendarConfigured(c) ? c.refreshToken : undefined;
      return handleConversation(h, signal, {
        onTurn,
        calendar: refresh ? new CalendarAccess(refresh, tz) : undefined,
        mail: refresh ? () => unreadMail(refresh) : undefined,
        mailRecent: refresh ? () => recentMail(refresh) : undefined,
        mailCanDraft: refresh ? () => hasComposeScope(refresh) : undefined,
        draft: refresh ? (input) => createDraft(refresh, input) : undefined,
      });
    });
  let answer = "";
  let heard: string | null = null;
  const notes: string[] = [];
  const webSources: { title: string; uri: string }[] = [];
  let turn: SaveTurnInput | null = null;
  let failed: string | null = null;
  const signal = AbortSignal.timeout(ANSWER_TIMEOUT_MS);
  try {
    for await (const e of converse(history, signal, (t) => (turn = t))) {
      if (e.type === "delta") answer += e.text;
      else if (e.type === "transcript") heard = e.text;
      else if (e.type === "sources") webSources.push(...e.sources);
      else if (e.type === "error") failed = e.message;
      else {
        const line = describeEvent(e);
        if (line && !notes.includes(line)) notes.push(line);
      }
    }
  } catch (err) {
    failed = signal.aborted ? "時間内に答えられませんでした。もう少し短く頼んでみてください。" : err instanceof Error ? err.message : "答えを作れませんでした。";
  }
  if (heard === "") return ["声を聞き取れませんでした。もう一度送ってください。"];
  const userText = heard ?? user.content;

  // 引用：関連する脳のノート（会話ログなど F.R.I.D.A.Y. の内部のものは除く）
  let cited: string[] = [];
  if (brain.configured && userText) {
    const recall = deps.recall ?? ((q: string, h: ChatMessage[]) => getLongTermMemory().recall(q, h));
    cited = (await recall(userText, history).catch(() => []))
      .map((r) => r.source)
      .filter((s, i, a) => s && !s.startsWith(".") && a.indexOf(s) === i)
      .slice(0, 3);
  }

  // 脳に残す（会話ログ・覚えたこと）と、直前の会話の保存
  if (turn) {
    const save = deps.save ?? ((t: SaveTurnInput) => getLongTermMemory().save?.(t) ?? Promise.resolve());
    await save(turn).catch(() => undefined);
  }
  if (brain.configured && answer) {
    const at = now.getTime();
    await brain
      .update(path, (cur) => JSON.stringify([...parseHistory(cur), { role: "user", content: userText, at }, { role: "assistant", content: answer.slice(0, 4000), at }].slice(-HISTORY_MAX)), "FRIDAY: LINE の会話")
      .catch(() => undefined);
  }

  const parts: string[] = [];
  if (heard) parts.push(`🎤 聞き取り：${heard}`);
  parts.push(answer ? plainForLine(answer) : (failed ?? "答えを作れませんでした。"));
  if (notes.length) parts.push(notes.join("\n"));
  if (cited.length) parts.push(`📝 脳の関連ノート：\n${cited.map((s) => `・${s.replace(/\.md$/, "")}`).join("\n")}`);
  if (webSources.length) parts.push(`🔗 出典：\n${webSources.slice(0, 3).map((s) => `・${s.title} ${s.uri}`).join("\n")}`);
  return splitForLine(parts.join("\n\n"));
}
