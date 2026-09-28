/**
 * F.R.I.D.A.Y. の脳（Obsidian Vault）を GitHub リポジトリとして読み書きする（サーバー専用）。
 *
 *   Obsidian（PC / スマホ） ⇄ Obsidian Git プラグイン ⇄ GitHub リポジトリ ⇄ F.R.I.D.A.Y.
 *
 * - 読み: リポジトリ内の Markdown を一覧・取得（内容はファイルの SHA ごとにキャッシュ）
 * - 書き: 記憶・会話ログを追記（GitHub の Contents API で 1 ファイルずつコミット）
 * - 初回: 脳が空なら、フォルダ構成と最初のノートを自動で作る
 */
import { settingsHint } from "@/lib/config";

export interface BrainConfig {
  token: string | undefined;
  owner: string | undefined;
  repo: string | undefined;
  apiBase: string;
}

export function getBrainConfig(): BrainConfig {
  const [owner, repo] = (process.env.BRAIN_REPO ?? "").trim().replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "").split("/");
  return {
    token: process.env.BRAIN_GITHUB_TOKEN?.trim() || undefined,
    owner: owner || undefined,
    repo: repo || undefined,
    apiBase: (process.env.BRAIN_GITHUB_API_BASE?.trim() || "https://api.github.com").replace(/\/+$/, ""),
  };
}

export function isBrainConfigured(c: BrainConfig = getBrainConfig()): boolean {
  return Boolean(c.token && c.owner && c.repo);
}

export class BrainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/* ---------- 脳の中の決まった場所 ---------- */

// Windows は末尾が「.」のフォルダを作れないため、記号なしの名前にする
export const BRAIN_DIR = "FRIDAY";
/** 以前のフォルダ名（Windows で取り込めなかったため、見つけたら BRAIN_DIR へ引っ越す） */
const LEGACY_DIR = "F.R.I.D.A.Y.";
export const PROFILE_PATH = `${BRAIN_DIR}/プロフィール.md`;
export const MEMORY_PATH = `${BRAIN_DIR}/記憶.md`;
export const LOG_DIR = `${BRAIN_DIR}/会話ログ`;

/* ---------- GitHub API ---------- */

async function gh(c: BrainConfig, path: string, init: RequestInit = {}, timeoutMs = 8000): Promise<Response> {
  try {
    return await fetch(`${c.apiBase}/repos/${c.owner}/${c.repo}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${c.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
  } catch {
    throw new BrainError("BRAIN_NETWORK", "GitHub に接続できませんでした。");
  }
}

function explain(status: number): BrainError {
  if (status === 401) return new BrainError("BRAIN_TOKEN", `脳（GitHub）のトークンが無効です。${settingsHint("BRAIN_GITHUB_TOKEN")}`);
  if (status === 403)
    return new BrainError("BRAIN_FORBIDDEN", `脳（GitHub）のトークンに書き込み権限がありません。Contents を Read and write にしてください。`);
  if (status === 404)
    return new BrainError("BRAIN_NOT_FOUND", `脳のリポジトリが見つかりません（トークンの対象リポジトリも確認してください）。${settingsHint("BRAIN_REPO")}`);
  return new BrainError("BRAIN_UPSTREAM", `GitHub でエラーが発生しました（${status}）。`);
}

const b64encode = (text: string) => Buffer.from(text, "utf8").toString("base64");
const b64decode = (b64: string) => Buffer.from(b64, "base64").toString("utf8");

export interface BrainFile {
  path: string;
  sha: string;
  size: number;
}

let treeCache: { key: string; at: number; files: BrainFile[] } | undefined;
const TREE_TTL = 60_000;
const blobCache = new Map<string, string>();

/** 書き込んだ後: 一覧は捨てずに「古い」印を付ける（次に読むとき、待たせずに裏で取り直す） */
function markTreeStale(): void {
  if (treeCache) treeCache.at = Date.now() - TREE_TTL;
}

/** 一覧が古くても、この時間以内なら古い一覧を返しつつ裏で取り直す（返答を待たせない） */
const TREE_STALE_OK = 60 * 60_000;
let treeRefresh: Promise<BrainFile[]> | undefined;

/**
 * 脳の中の Markdown 一覧。空のリポジトリなら []。
 * 1 分以内は前回の一覧、1 時間以内なら前回の一覧を返しつつ裏で取り直す（force で必ず取り直す）。
 */
export async function listNotes(force = false): Promise<BrainFile[]> {
  const c = getBrainConfig();
  if (!isBrainConfigured(c)) throw new BrainError("BRAIN_NOT_CONFIGURED", "脳が設定されていません。");
  const key = `${c.owner}/${c.repo}`;
  const cached = !force && treeCache?.key === key ? treeCache : undefined;
  if (cached && Date.now() - cached.at < TREE_TTL) return cached.files;
  if (cached && Date.now() - cached.at < TREE_STALE_OK) {
    treeRefresh ??= fetchTree(c, key).finally(() => (treeRefresh = undefined));
    treeRefresh.catch(() => {});
    return cached.files;
  }
  return fetchTree(c, key);
}

async function fetchTree(c: BrainConfig, key: string): Promise<BrainFile[]> {
  const res = await gh(c, `/git/trees/HEAD?recursive=1`);
  let files: BrainFile[] = [];
  if (res.ok) {
    const json = (await res.json()) as { tree?: { path: string; type: string; sha: string; size?: number }[] };
    files = (json.tree ?? [])
      .filter((t) => t.type === "blob" && t.path.toLowerCase().endsWith(".md") && !t.path.startsWith(".") && !t.path.includes("/."))
      .map((t) => ({ path: t.path, sha: t.sha, size: t.size ?? 0 }));
  } else if (res.status === 409) {
    files = []; // コミットがまだない空のリポジトリ
  } else {
    throw explain(res.status);
  }
  treeCache = { key, at: Date.now(), files };
  return files;
}

/** ノートの本文（SHA ごとにキャッシュするので、変更がなければ再取得しない） */
export async function readNote(file: BrainFile): Promise<string> {
  const cached = blobCache.get(file.sha);
  if (cached !== undefined) return cached;
  const c = getBrainConfig();
  const res = await gh(c, `/git/blobs/${file.sha}`);
  if (!res.ok) throw explain(res.status);
  const json = (await res.json()) as { content?: string; encoding?: string };
  const text = json.encoding === "base64" ? b64decode(json.content ?? "") : (json.content ?? "");
  if (blobCache.size > 2000) blobCache.clear();
  blobCache.set(file.sha, text);
  return text;
}

async function getFile(path: string): Promise<{ text: string; sha: string } | null> {
  const c = getBrainConfig();
  const res = await gh(c, `/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}`);
  if (res.status === 404) return null;
  if (!res.ok) throw explain(res.status);
  const json = (await res.json()) as { content?: string; sha: string };
  return { text: b64decode((json.content ?? "").replace(/\n/g, "")), sha: json.sha };
}

async function putFile(path: string, text: string, message: string, sha?: string): Promise<Response> {
  const c = getBrainConfig();
  return gh(c, `/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}`, {
    method: "PUT",
    body: JSON.stringify({ message, content: b64encode(text), ...(sha ? { sha } : {}) }),
  });
}

/** ファイルを書き換える（無ければ作る）。同時更新でぶつかったら 1 回だけ取り直して再試行 */
export async function updateNote(path: string, update: (current: string | null) => string, message: string): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const current = await getFile(path);
    const next = update(current?.text ?? null);
    if (current && next === current.text) return; // 変更なし
    const res = await putFile(path, next, message, current?.sha);
    if (res.ok) {
      markTreeStale(); // 次に一覧を読むとき裏で取り直させる
      return;
    }
    if ((res.status === 409 || res.status === 422) && attempt === 0) continue;
    throw explain(res.status);
  }
}

async function deleteFile(path: string, sha: string, message: string): Promise<void> {
  const c = getBrainConfig();
  const res = await gh(c, `/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}`, {
    method: "DELETE",
    body: JSON.stringify({ message, sha }),
  });
  if (!res.ok && res.status !== 404) throw explain(res.status);
}

/** 旧フォルダ（F.R.I.D.A.Y./）のノートを新フォルダへ移す。移した件数を返す */
async function migrateLegacy(files: BrainFile[]): Promise<number> {
  const legacy = files.filter((f) => f.path.startsWith(`${LEGACY_DIR}/`));
  for (const f of legacy) {
    const text = await readNote(f);
    const target = `${BRAIN_DIR}/${f.path.slice(LEGACY_DIR.length + 1)}`;
    // 新しい場所に既にあれば、そちらを優先する
    await updateNote(target, (current) => current ?? text, `F.R.I.D.A.Y.: フォルダ名を変更（${target}）`);
    await deleteFile(f.path, f.sha, `F.R.I.D.A.Y.: 旧フォルダを削除（${f.path}）`);
  }
  if (legacy.length && files.some((f) => f.path === "README.md")) {
    await updateNote(
      "README.md",
      (current) => (current ?? "").split(`${LEGACY_DIR}/`).join(`${BRAIN_DIR}/`),
      "F.R.I.D.A.Y.: README のフォルダ名を更新",
    );
  }
  if (legacy.length) markTreeStale();
  return legacy.length;
}

/* ---------- 初回: 脳を作る ---------- */

const today = (tz: string) => new Intl.DateTimeFormat("sv-SE", { timeZone: tz }).format(new Date());

function starterFiles(tz: string): Record<string, string> {
  const d = today(tz);
  return {
    "README.md": `# F.R.I.D.A.Y. の脳

このフォルダ（Vault）は F.R.I.D.A.Y. Mark3 の長期記憶です。
Obsidian で開くと、F.R.I.D.A.Y. が覚えたことを読んだり、自分でノートを書き足したりできます。
ここに書いたノートは、F.R.I.D.A.Y. が会話の中で自動的に参考にします。

- \`${BRAIN_DIR}/プロフィール.md\` … あなたについて（自由に書き足してください）
- \`${BRAIN_DIR}/記憶.md\` … F.R.I.D.A.Y. が覚えたこと
- \`${BRAIN_DIR}/会話ログ/\` … 日ごとの会話の記録
- \`プロジェクト/\` … 取り組んでいることのメモ
- \`メモ/\` … 自由なメモ置き場
`,
    [PROFILE_PATH]: `# プロフィール

F.R.I.D.A.Y. が会話のたびに必ず読むノートです。自分について知っておいてほしいことを書いてください。

## 基本
- 呼び名：
- 所属・学校：

## 好きなこと・大切にしていること
-

## 目標
-

## F.R.I.D.A.Y. への希望（話し方など）
-
`,
    [MEMORY_PATH]: `# 記憶

F.R.I.D.A.Y. が会話の中で「覚えておくべき」と判断したことを、日付つきで書き足していきます。
間違っている行は消したり直したりしてかまいません。

## ${d}
- 脳（Obsidian Vault）が作られた
`,
    "プロジェクト/はじめに.md": `# プロジェクト

取り組んでいること 1 つにつき 1 ノート作ると、F.R.I.D.A.Y. が状況を踏まえて相談に乗れます。

例：\`プロジェクト/Re-Palette.md\`
- 概要
- 今の状況
- 次にやること
- 悩んでいること
`,
    [`${BRAIN_DIR}/ニュース.md`]: `# ニュース

F.R.I.D.A.Y. が毎日「時間」を過ぎてから最初に話しかけたときに、その日のニュースをまとめて伝えます。
「興味のある分野」のニュースは分野ごとに詳しく伝えます。自由に書き換えてください（時間を off にすると自動では伝えません）。

## 時間
07:00

## 興味のある分野
- 
`,
    "メモ/はじめに.md": `# メモ

思いついたこと、調べたこと、なんでも自由に書いてください。F.R.I.D.A.Y. の記憶になります。
`,
  };
}

let ensured = false;

/** 脳が空（または F.R.I.D.A.Y. 用フォルダが無い）なら、最初のノートを作る */
export async function ensureBrain(tz: string): Promise<{ created: boolean }> {
  if (ensured) return { created: false };
  let files = await listNotes(true);
  if (await migrateLegacy(files)) files = await listNotes(true);
  const existing = new Set(files.map((f) => f.path));
  const missing = Object.entries(starterFiles(tz)).filter(([p]) => !existing.has(p));
  // 既に脳がある（プロフィールがある）なら何もしない。README だけあるリポジトリには足りないものを作る
  if (missing.length === 0 || existing.has(PROFILE_PATH)) {
    ensured = true;
    return { created: false };
  }
  for (const [path, text] of missing) {
    await updateNote(path, () => text, `F.R.I.D.A.Y.: 脳を作成（${path}）`);
  }
  ensured = true;
  markTreeStale();
  return { created: true };
}

/* ---------- 記憶・会話ログの書き込み ---------- */

/** 覚えたことを「記憶.md」の今日の見出しの下に追記する */
export async function appendMemories(facts: string[], tz: string): Promise<void> {
  if (!facts.length) return;
  const d = today(tz);
  await updateNote(
    MEMORY_PATH,
    (current) => {
      let text = current ?? "# 記憶\n";
      // 既に覚えていることは書き足さない
      const known = new Set(text.split("\n").map((l) => l.replace(/^\s*-\s*/, "").trim()));
      const fresh = facts.filter((f) => !known.has(f));
      if (!fresh.length) return text;
      if (!text.includes(`## ${d}`)) text = `${text.trimEnd()}\n\n## ${d}\n`;
      // 今日の見出しの末尾に追記（今日の見出しは常に一番下にある想定）
      return `${text.trimEnd()}\n${fresh.map((f) => `- ${f}`).join("\n")}\n`;
    },
    `F.R.I.D.A.Y.: 記憶を追加（${facts.length} 件）`,
  );
}

/** 会話を日ごとの会話ログに追記する */
export async function appendConversationLog(user: string, assistant: string, tz: string, voice: boolean): Promise<void> {
  const d = today(tz);
  const time = new Intl.DateTimeFormat("ja-JP", { timeZone: tz, hour: "2-digit", minute: "2-digit" }).format(new Date());
  const quote = (t: string) => t.trim().replace(/\n/g, "\n> ");
  await updateNote(
    `${LOG_DIR}/${d}.md`,
    (current) =>
      `${(current ?? `# 会話ログ ${d}\n`).trimEnd()}\n\n### ${time}${voice ? "（音声）" : ""}\n**あなた**：${user.trim()}\n\n> ${quote(assistant)}\n`,
    `F.R.I.D.A.Y.: 会話ログ ${d} ${time}`,
  );
}
