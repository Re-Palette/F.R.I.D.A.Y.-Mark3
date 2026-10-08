/**
 * Offline Core — ネットが切れて Vercel のサーバー（FRIDAY Core）に届かないときに、画面の中で動く小さな Core。
 *
 *   画面 → Offline Core → LM Studio（この PC のローカル AI）
 *            ├── 人格：オンライン中にサーバーから受け取った、いつもと同じ system prompt（控え）
 *            ├── 記憶：控えておいた Obsidian の脳（プロフィール・記憶・ノート）から、サーバーと同じ方法で探す
 *            ├── 会話：画面に残っている会話（Gemini で話した分も含む）
 *            └── Tool：返答の隠しタグをサーバーと同じ名前・同じ読み取り方で処理する
 *
 * 脳への書き込み（覚えたこと・ToDo・予定・文書・会話ログ）は端末に溜めておき、
 * オンラインに戻ったら /api/offline/sync でサーバーの Core に渡して、いつもと同じ処理で反映する。
 * 返すイベントはサーバーの /api/chat と同じ形（StreamEvent）なので、画面の表示処理はそのまま使える。
 */
import type { ChatMessage, StreamEvent } from "@/core/types";
import { TagFilter, toFact } from "@/core/hidden-tags";
import { BROWSER_TAGS, CORE_TAG_LIMITS, CORE_TAGS } from "@/core/tag-names";
import { toBrowserEvent } from "@/core/browser-actions";
import { parseFocus } from "@/lib/focus-command";
import { formatNow } from "@/lib/time";
import { buildConversationWindow } from "@/memory/context";
import { bigrams, score, type Chunk } from "@/memory/lexical";
import { DEFAULT_LM_STUDIO_URL, LMStudioError, listLMStudioModels, normalizeLMStudioUrl, pickLMStudioModel, streamLMStudio } from "@/llm/lmstudio";
import { getLocal, setLocal } from "./local-store";

/* ---------- オフライン用の控え（/api/offline/pack） ---------- */

export interface OfflinePack {
  version: 2;
  at: number;
  timezone: string;
  persona: { text: string; voice: string };
  recallMark: string;
  recall: { PROFILE_CHARS: number; RECENT_MEMORY_CHARS: number; TOP_CHUNKS: number; RECALL_BUDGET_CHARS: number };
  context: { maxMessages: number; maxChars: number };
  brain: { connected: boolean; profile: string; memory: string; chunks: Chunk[] };
}

const PACK_KEY = "offline-pack";
const OUTBOX_KEY = "offline-outbox";
/** オンラインの間、控えを取り直す間隔 */
const PACK_TTL_MS = 10 * 60_000;

let pack: OfflinePack | null | undefined;
let packFetching: Promise<boolean> | null = null;

export async function loadPack(): Promise<OfflinePack | null> {
  if (pack !== undefined) return pack;
  const stored = await getLocal<OfflinePack>(PACK_KEY);
  // 古い形の控え（長い人格）は使わず、次にオンラインのときに取り直す
  pack = stored?.version === 2 ? stored : null;
  return pack;
}

/** オンラインの間に控えを取り直す（前回から時間が経っていれば）。成功したら true */
export function refreshPack(force = false): Promise<boolean> {
  packFetching ??= (async () => {
    try {
      const current = await loadPack();
      if (!force && current && Date.now() - current.at < PACK_TTL_MS) return true;
      const res = await fetch("/api/offline/pack", { cache: "no-store" });
      if (!res.ok) return false;
      const next = (await res.json()) as OfflinePack;
      if (next?.version !== 2 || !next.persona?.text) return false;
      pack = next;
      await setLocal(PACK_KEY, next);
      return true;
    } catch {
      return false;
    } finally {
      packFetching = null;
    }
  })();
  return packFetching;
}

/* ---------- ローカル AI の設定（サーバーの環境変数 LM_STUDIO_BASE_URL / LM_STUDIO_MODEL を覚えておく） ---------- */

const LOCAL_AI_KEY = "friday.localai.v1";

/** SETTINGS で選んだローカル AI の設定（この端末だけ。オフラインでも変えられる） */
const LOCAL_AI_PREFS_KEY = "friday.localai.prefs.v1";

export interface LocalAiPrefs {
  /** 使うモデル（空ならサーバーの設定 → LM Studio で読み込み中のモデル） */
  model: string;
  /** 答える前に考えるか（既定はオフ＝速い） */
  thinking: boolean;
}

export function localAiPrefs(): LocalAiPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(LOCAL_AI_PREFS_KEY) ?? "null") as Partial<LocalAiPrefs> | null;
    return { model: typeof raw?.model === "string" ? raw.model : "", thinking: raw?.thinking === true };
  } catch {
    return { model: "", thinking: false };
  }
}

export function saveLocalAiPrefs(prefs: LocalAiPrefs): void {
  try {
    localStorage.setItem(LOCAL_AI_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* noop */
  }
}

export function localAiConfig(): { baseUrl: string; model: string; thinking: boolean } {
  const prefs = localAiPrefs();
  try {
    const raw = JSON.parse(localStorage.getItem(LOCAL_AI_KEY) ?? "null") as { baseUrl?: string; model?: string } | null;
    return { baseUrl: normalizeLMStudioUrl(raw?.baseUrl), model: prefs.model || raw?.model || "", thinking: prefs.thinking };
  } catch {
    return { baseUrl: DEFAULT_LM_STUDIO_URL, model: prefs.model, thinking: prefs.thinking };
  }
}

/** LM Studio で使えるモデルの一覧（SETTINGS 用。つながらなければ null） */
export function localAiModels(signal?: AbortSignal): Promise<string[] | null> {
  return listLMStudioModels(localAiConfig().baseUrl, signal);
}

export function rememberLocalAiConfig(cfg: { baseUrl?: string; model?: string }): void {
  try {
    localStorage.setItem(LOCAL_AI_KEY, JSON.stringify({ baseUrl: normalizeLMStudioUrl(cfg.baseUrl), model: cfg.model ?? "" }));
  } catch {
    /* noop */
  }
}

/** LM Studio が使えるか（読み込み済みのモデル名も返す） */
export async function checkLocalAi(signal?: AbortSignal): Promise<{ ok: boolean; model?: string }> {
  const cfg = localAiConfig();
  if (cfg.model) return (await listLMStudioModels(cfg.baseUrl, signal)) ? { ok: true, model: cfg.model } : { ok: false };
  const model = await pickLMStudioModel(cfg.baseUrl, signal);
  return model ? { ok: true, model } : { ok: false };
}

/* ---------- 記憶を探す（サーバーの ObsidianMemory.recall と同じ方法・同じ上限） ---------- */

interface Outbox {
  turns: OfflineTurn[];
}

export interface OfflineTurn {
  id: string;
  at: number;
  user: string;
  assistant: string;
  voice: boolean;
  captures: Record<string, string[]>;
  attrs: Record<string, Record<string, string>[]>;
}

async function outbox(): Promise<Outbox> {
  return (await getLocal<Outbox>(OUTBOX_KEY)) ?? { turns: [] };
}

function recall(p: OfflinePack, query: string, history: ChatMessage[], pendingFacts: string[]): string {
  const { PROFILE_CHARS, RECENT_MEMORY_CHARS, TOP_CHUNKS, RECALL_BUDGET_CHARS } = p.recall;
  const records: { title: string; content: string }[] = [];
  if (p.brain.profile.trim()) records.push({ title: "プロフィール", content: p.brain.profile.slice(0, PROFILE_CHARS) });
  // オフライン中に覚えたこと（まだ脳に反映していない分）も「最近の記憶」に含める
  const memory = `${p.brain.memory}${pendingFacts.length ? `\n${pendingFacts.map((f) => `- ${f}（オフライン中に記憶）`).join("\n")}` : ""}`;
  if (memory.trim()) records.push({ title: "最近の記憶", content: memory.slice(-RECENT_MEMORY_CHARS) });
  const recent = history.slice(-4).map((m) => m.content).join(" ");
  const q = bigrams(`${query} ${query} ${recent}`.slice(0, 600));
  const ranked = p.brain.chunks
    // オフラインでは意味の近さを測れない（通信が要る）ので、ノートの名前（例: Re-Palette）も手がかりにする
    .map((c) => ({ c, s: score(q, `${c.path.replace(/\.md$/, "")} ${c.heading} ${c.text}`) }))
    .filter((x) => x.s > 0.35)
    .sort((a, b) => b.s - a.s)
    .slice(0, TOP_CHUNKS);
  let budget = RECALL_BUDGET_CHARS;
  for (const { c } of ranked) {
    if (budget <= 0) break;
    const content = c.text.slice(0, budget);
    budget -= content.length;
    records.push({ title: `${c.path.replace(/\.md$/, "")} › ${c.heading}`, content });
  }
  return records.length ? records.map((r) => `## ${r.title}\n${r.content}`).join("\n\n") : "（今回の会話に関係するノートは見つからなかった）";
}

/** 一度もオンラインで開いていないとき（控えが無い）の最小限の人格 */
const MINIMAL_PERSONA = `あなたは F.R.I.D.A.Y.（フライデー）Mark3。陽大（はると）の副社長・参謀・秘書として、簡潔に、結論から日本語で答える。最後に「次に何をするか」を一言添える。
- 現在日時: {NOW}`;

function offlineSection(p: OfflinePack | null): string {
  const when = p ? new Intl.DateTimeFormat("ja-JP", { timeZone: p.timezone, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(p.at) : null;
  return `

# いまはオフライン（この PC のローカル AI で答えている）
- Web 検索・ニュース・メール・天気の更新・音楽などネットが要ることは使えない。頼まれたら「現在オフラインのため Web 検索は利用できません。」のように短く伝え、分かる範囲で手伝う。
- ${when ? `上の予定・ToDo・ノートは ${when} 時点の控え。` : "脳の控えがまだ無いので、過去のことは分からないと正直に伝える。"}`;
}

/** system prompt を組み立てる（いつもの人格＋その場で探した記憶＋オフラインの説明） */
async function buildSystem(history: ChatMessage[], voice: boolean): Promise<string> {
  const p = await loadPack();
  const now = new Date();
  if (!p) return MINIMAL_PERSONA.replace("{NOW}", formatNow(now, "Asia/Tokyo")) + offlineSection(null);
  let system = voice ? p.persona.voice : p.persona.text;
  system = system.replace(/- 現在日時: .*（([^）]+)）/, (_m, tz: string) => `- 現在日時: ${formatNow(now, tz)}（${tz}）`);
  if (p.brain.connected) {
    const pending = (await outbox()).turns.flatMap((t) => (t.captures.memory ?? []).map(toFact).filter(Boolean));
    const latest = history[history.length - 1]?.content ?? "";
    system = system.replace(p.recallMark, recall(p, latest, history, pending));
  }
  return system + offlineSection(p);
}

/* ---------- 会話（サーバーの handleConversation と同じ形のイベントを返す） ---------- */

const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** オフラインでは実行できない Tool（頼まれたら本文で知らせる） */
const ONLINE_ONLY: Partial<Record<(typeof CORE_TAGS)[number], string>> = {
  "gmail-draft": "メールの下書き",
  music: "音楽の操作",
  "company-instruct": "会社への指示",
  "company-advance": "会社への指示",
  "news-settings": "ニュースの設定",
  hologram: "3D ホログラム",
};
/** オンラインに戻ったら脳・カレンダーに反映する Tool */
const SYNC_LATER = ["memory", "document", "slides", "todo-add", "todo-done", "project-progress", "reminder", "calendar", "calendar-update", "calendar-delete"] as const;

export async function* runLocalConversation(history: ChatMessage[], opts: { voice: boolean; signal?: AbortSignal }): AsyncGenerator<StreamEvent> {
  const p = await loadPack();
  const cfg = localAiConfig();
  const window = buildConversationWindow(history, p?.context ?? { maxMessages: 24, maxChars: 24000 });
  const system = await buildSystem(window.messages, opts.voice);
  const tags = new TagFilter(CORE_TAGS, CORE_TAG_LIMITS);
  let reply = "";
  let model = cfg.model;
  const sent = { "open-url": 0, "close-tab": 0 };
  const browserEvents = function* (): Generator<StreamEvent> {
    for (const tag of BROWSER_TAGS) {
      const list = tags.captures[tag];
      for (; sent[tag] < list.length; sent[tag]++) yield toBrowserEvent(tag, list[sent[tag]], tags.attrs[tag][sent[tag]]);
    }
  };
  try {
    yield { type: "stage", stage: "think" };
    let finishReason: string | undefined;
    const messages = window.messages.map((m) => ({
      role: m.role,
      content: `${m.content}${m.image ? "\n（カメラの映像はオフラインでは見られません）" : ""}${m.files?.length ? "\n（添付ファイルはオフラインでは読めません）" : ""}`,
    }));
    for await (const chunk of streamLMStudio(cfg, { system, messages, signal: opts.signal, maxTokens: opts.voice ? 600 : 3000 })) {
      if (chunk.model) {
        model = chunk.model;
        yield { type: "meta", agent: "chat", model: `LOCAL AI (${model})`, contextMessages: window.messages.length };
      }
      if (chunk.text) {
        const text = tags.push(chunk.text);
        if (text) {
          reply += text;
          yield { type: "delta", text };
        }
        yield* browserEvents();
      }
      if (chunk.finishReason) finishReason = chunk.finishReason;
    }
    const rest = tags.flush();
    if (rest) {
      reply += rest;
      yield { type: "delta", text: rest };
    }
    yield* browserEvents();

    for (const raw of tags.captures.focus.slice(0, 1)) {
      const cmd = parseFocus(raw);
      if (cmd) yield { type: "focus", ...cmd };
    }
    const facts = tags.captures.memory.map(toFact).filter(Boolean);
    // 端末に控え、オンラインに戻ったら脳（Obsidian）に保存する（それまでもオフラインの会話では思い出せる）
    for (const text of facts) yield { type: "memory", text: `${text}（オフライン中：オンラインに戻ったら脳に保存）` };
    // 文書・スライドは画面のカードに出す（PDF・スライドは画面で作れる。脳への保存はオンラインに戻ってから）
    const docs = [
      ...tags.captures.document.map((content, i) => ({ content, attrs: tags.attrs.document[i] ?? {}, kind: /^pdf$/i.test(tags.attrs.document[i]?.format ?? "") ? ("pdf" as const) : undefined })),
      ...tags.captures.slides.map((content, i) => ({ content, attrs: tags.attrs.slides[i] ?? {}, kind: "slides" as const })),
    ];
    for (const d of docs) {
      const title = d.attrs.title || /^#\s+(.+)$/m.exec(d.content)?.[1]?.trim() || "無題";
      yield { type: "document", ok: true, title, content: d.content, kind: d.kind };
    }

    const notes: string[] = [];
    const later = SYNC_LATER.filter((t) => t !== "memory" && tags.captures[t].length);
    if (later.length) notes.push("（オフライン中のため、ToDo・予定・文書の保存はオンラインに戻ったときに脳とカレンダーへ反映します）");
    const blocked = [...new Set(Object.entries(ONLINE_ONLY).filter(([t]) => tags.captures[t as keyof typeof ONLINE_ONLY].length).map(([, label]) => label))];
    if (blocked.length) notes.push(`（現在オフラインのため、${blocked.join("・")}は実行できませんでした）`);
    for (const note of notes) {
      const text = `${reply.endsWith("\n") ? "" : "\n\n"}${note}`;
      reply += text;
      yield { type: "delta", text };
    }

    // 会話ログ・覚えたこと・ToDo などは、オンラインに戻ったら脳に反映する
    const last = window.messages[window.messages.length - 1];
    if (reply.trim()) {
      const captures: Record<string, string[]> = {};
      const attrs: Record<string, Record<string, string>[]> = {};
      for (const t of SYNC_LATER) {
        if (tags.captures[t].length) captures[t] = tags.captures[t];
        if (tags.attrs[t].length) attrs[t] = tags.attrs[t];
      }
      await queueTurn({ id: uid(), at: Date.now(), user: last?.content ?? "", assistant: reply.trim(), voice: opts.voice, captures, attrs });
    }
    yield { type: "done", finishReason };
  } catch (err) {
    if (opts.signal?.aborted) return;
    const message =
      err instanceof LMStudioError
        ? `${err.message}${err.code === "LOCAL_AI_UNAVAILABLE" ? LOCAL_AI_HELP : ""}`
        : "ローカル AI（LM Studio）で答えられませんでした。";
    yield { type: "error", code: "LOCAL_AI_UNAVAILABLE", message, retryable: true };
  }
}

/* ---------- オフライン中の会話を溜める・オンラインに戻ったら反映する ---------- */

async function queueTurn(turn: OfflineTurn): Promise<void> {
  const box = await outbox();
  box.turns.push(turn);
  await setLocal(OUTBOX_KEY, { turns: box.turns.slice(-200) });
}

export async function pendingTurns(): Promise<number> {
  return (await outbox()).turns.length;
}

let flushing: Promise<{ synced: number; notes: string[] }> | null = null;

/** 溜めた会話をサーバーの Core に渡して脳に反映する（オンラインに戻ったとき） */
export function flushOutbox(): Promise<{ synced: number; notes: string[] }> {
  flushing ??= (async () => {
    let synced = 0;
    const notes: string[] = [];
    try {
      for (let round = 0; round < 10; round++) {
        const box = await outbox();
        if (!box.turns.length) break;
        const batch = box.turns.slice(0, 10);
        const res = await fetch("/api/offline/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ turns: batch }) });
        if (!res.ok) break;
        const json = (await res.json()) as { done?: string[]; notes?: string[] };
        const done = new Set(json.done ?? []);
        notes.push(...(json.notes ?? []));
        const latest = await outbox();
        await setLocal(OUTBOX_KEY, { turns: latest.turns.filter((t) => !done.has(t.id)) });
        synced += done.size;
        if (done.size < batch.length) break;
      }
    } catch {
      /* 次の機会に */
    } finally {
      flushing = null;
    }
    if (synced) void refreshPack(true);
    return { synced, notes };
  })();
  return flushing;
}

/** LM Studio に届かない理由の案内（画面に出す） */
export const LOCAL_AI_HELP =
  "① LM Studio の「ローカルモデルAPI」でサーバーが ON か　② 同じ画面の「CORS を有効にする」が ON か　③ Chrome に「このデバイス上の他のアプリ（ローカル ネットワーク）へのアクセス」を許可したか（FRIDAY の画面上部の鍵のマーク → サイトの設定 → ローカル ネットワークへのアクセス を「許可」）を確かめてください。";

/**
 * LM Studio に届くか、届かないなら理由を調べる（SETTINGS の「試す」用）。
 *   blocked: すぐ失敗した（サーバーが止まっている・CORS がオフ・Chrome がブロック）
 *   waiting: 返事が無い（Chrome の許可の確認を待っている・LM Studio が固まっている）
 */
export async function diagnoseLocalAi(): Promise<{ ok: true; models: string[] } | { ok: false; reason: "blocked" | "waiting" | "http"; message: string }> {
  const { baseUrl } = localAiConfig();
  try {
    const res = await fetch(`${baseUrl}/models`, { cache: "no-store", signal: AbortSignal.timeout(8000) });
    if (!res.ok) return { ok: false, reason: "http", message: `LM Studio がエラーを返しました（${res.status}）。` };
    const json = (await res.json()) as { data?: { id?: string }[] };
    return { ok: true, models: (json.data ?? []).map((m) => m.id ?? "").filter(Boolean) };
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      return { ok: false, reason: "waiting", message: `LM Studio（${baseUrl}）から返事がありません。Chrome が「アクセスを許可しますか」と聞いていないか、画面の上部を確認してください。${LOCAL_AI_HELP}` };
    }
    return { ok: false, reason: "blocked", message: `LM Studio（${baseUrl}）に接続できません。${LOCAL_AI_HELP}` };
  }
}
