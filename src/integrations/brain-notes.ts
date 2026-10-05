/**
 * 添えたファイルと授業ノートを、脳（Obsidian）に保存する。
 *
 *   資料/YYYY-MM-DD <題>.md                … 添えたファイルの要点・聞いたこと・答え（原本へのリンクつき）
 *   添付/YYYY-MM/...                        … 添えたファイルの原本（画面から /api/brain/attach で送る）
 *   授業/<科目>/YYYY-MM-DD HHmm <題>.md    … 授業のまとめと文字起こし全文
 */
import type { Lecture } from "@/lib/lecture";
import { safeName } from "@/lib/brain-paths";
import { getTimezone } from "@/lib/config";
import { isBrainConfigured, listNotes, readFresh, readNote, updateNote, type BrainFile } from "@/memory/github-brain";
import { addTodo, getTasksOverview } from "@/integrations/tasks";

const day = (d = new Date()) => new Intl.DateTimeFormat("sv-SE", { timeZone: getTimezone() }).format(d);
const hhmm = (d: Date) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: getTimezone(), hour: "2-digit", minute: "2-digit", hour12: false }).format(d).replace(":", "");
const yamlStr = (s: string) => JSON.stringify(s);

/* ---------- 添えたファイルの要点 ---------- */

const IMAGE_EXT = /\.(jpe?g|png|webp|gif|bmp|avif|svg)$/i;

/** Obsidian で原本を見られるリンク（写真・PDF はノートの中に埋め込んで表示する） */
function linkTo(file: { name: string; path?: string }): string {
  if (!file.path) return `- ${file.name}（原本は大きいため保存していません）`;
  return IMAGE_EXT.test(file.path) || /\.pdf$/i.test(file.path) ? `- ${file.name}\n\n  ![[${file.path}]]` : `- [[${file.path}|${file.name}]]`;
}

export async function saveFileNote(input: {
  title: string;
  points: string;
  question: string;
  answer: string;
  files: { name: string; path?: string }[];
}): Promise<{ path: string; title: string }> {
  if (!isBrainConfigured()) throw new Error("脳（Obsidian）が接続されていないため保存できません。");
  const date = day();
  const title = safeName(input.title.replace(/\s+/g, " ").trim() || input.files[0]?.name || "資料", 60);
  const path = `資料/${date} ${title}.md`;
  const answer = input.answer.trim().slice(0, 8000);
  const points = input.points.trim().slice(0, 4000);
  const note = `---
date: ${date}
tags: [資料]
files: [${input.files.map((f) => yamlStr(f.name)).join(", ")}]
---
# ${title}

## ファイル
${input.files.map(linkTo).join("\n")}

## 要点
${points || "（要点はありません）"}

## 聞いたこと
${input.question
  .trim()
  .split("\n")
  .map((l) => `> ${l}`)
  .join("\n")}

## F.R.I.D.A.Y. の答え
${answer}

---
*F.R.I.D.A.Y. が保存（${date}）*
`;
  // 同じ日に同じ題の資料があれば、下に書き足す（上書きして前の分を消さない）
  await updateNote(path, (current) => (current ? `${current.trimEnd()}\n\n${note.replace(/^---[\s\S]*?---\n/, "")}` : note), `F.R.I.D.A.Y.: 資料を保存（${path}）`);
  return { path, title };
}

/* ---------- 授業ノート ---------- */

const clock = (sec: number) => {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const p = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${p(m)}:${p(s % 60)}` : `${p(m)}:${p(s % 60)}`;
};

/** 授業ノートの置き場所（科目のフォルダ・日時・題） */
export function lecturePath(lecture: Pick<Lecture, "subject" | "startedAt" | "summary">): string {
  const at = new Date(lecture.startedAt);
  const subject = safeName(lecture.subject || "科目なし", 40);
  const title = safeName(lecture.summary?.title || lecture.subject || "授業", 60);
  return `授業/${subject}/${day(at)} ${hhmm(at)} ${title}.md`;
}

export function lectureMarkdown(lecture: Lecture): string {
  const s = lecture.summary;
  const at = new Date(lecture.startedAt);
  const lines: string[] = [
    "---",
    `date: ${day(at)}`,
    `subject: ${yamlStr(lecture.subject || "")}`,
    `minutes: ${Math.max(1, Math.round(lecture.duration / 60))}`,
    "tags: [授業]",
    "---",
    `# ${s?.title || lecture.subject || "授業ノート"}`,
    "",
    `${lecture.subject || "（科目なし）"}｜${day(at)} ${hhmm(at).replace(/^(\d\d)/, "$1:")}｜${Math.max(1, Math.round(lecture.duration / 60))} 分`,
    "",
  ];
  if (s) {
    if (s.overview) lines.push("## 全体像", "", `> ${s.overview.replace(/\n/g, "\n> ")}`, "");
    if (s.keyPoints.length) {
      lines.push("## 重要なところ", "");
      s.keyPoints.forEach((k, i) => lines.push(`${i + 1}. **${k.point}**${k.time ? `（${k.time}）` : ""}${k.detail ? `\n   ${k.detail}` : ""}`));
      lines.push("");
    }
    if (s.exam.length) lines.push("## テストに出そうなところ", "", ...s.exam.map((e) => `- ⭐ ${e}`), "");
    if (s.outline.length) {
      lines.push("## 授業の流れ", "");
      for (const o of s.outline) lines.push(`### ${o.heading}${o.time ? `（${o.time}〜）` : ""}`, ...o.points.map((p) => `- ${p}`), "");
    }
    if (s.terms.length) lines.push("## 用語", "", ...s.terms.map((t) => `- **${t.term}**：${t.meaning}`), "");
    if (s.notices.length) lines.push("## 課題・連絡", "", ...s.notices.map((n) => `- [ ] ${n}`), "");
    if (s.review.length) lines.push("## 復習チェック", "", ...s.review.map((r) => `- [ ] ${r}`), "");
  }
  if (lecture.segments.length) {
    // 文字起こしは長いので、Obsidian で畳んでおける囲み（callout）に入れる
    lines.push("## 文字起こし", "", "> [!note]- 文字起こし（全文・音声認識による自動の文字起こし）");
    let minute = -1;
    let para: string[] = [];
    const flush = () => {
      if (para.length) lines.push(`> ${para.join(" ")}`, ">");
      para = [];
    };
    for (const seg of lecture.segments) {
      const m = Math.floor(seg.t / 60);
      if (m !== minute) {
        flush();
        lines.push(`> **${clock(seg.t)}**`);
        minute = m;
      }
      para.push(seg.text.replace(/\n/g, " "));
    }
    flush();
    lines.push("");
  }
  lines.push("---", `*F.R.I.D.A.Y. が保存（${day()}）*`, "");
  return lines.join("\n");
}

/** 授業ノートを保存する（前に保存した場所があれば、そこを書き直す）。課題は ToDo にも入れる（もう入っているものは入れない） */
export async function saveLectureNote(lecture: Lecture, previous?: string): Promise<{ path: string; todos: number }> {
  if (!isBrainConfigured()) throw new Error("脳（Obsidian）が接続されていないため保存できません。");
  const path = previous ?? lecturePath(lecture);
  await updateNote(path, () => lectureMarkdown(lecture), `F.R.I.D.A.Y.: 授業ノートを保存（${path}）`);
  let todos = 0;
  const tasks = lecture.summary?.tasks ?? [];
  if (tasks.length) {
    const norm = (t: string) => t.replace(/\s+/g, "");
    const existing = new Set([...(await getTasksOverview().catch(() => ({ todos: [] as { text: string }[] }))).todos].map((t) => norm(t.text)));
    for (const t of tasks) {
      const text = `【${lecture.subject || "授業"}】${t.text}`;
      if (existing.has(norm(text))) continue;
      try {
        await addTodo({ text, due: t.due });
        existing.add(norm(text));
        todos++;
      } catch {
        /* 1 件入れられなくても続ける */
      }
    }
  }
  return { path, todos };
}

/* ---------- 最近の授業の復習ポイント（朝のブリーフィング・クイズ用） ---------- */


/** ノートから「## 見出し」の部分を取り出す */
function section(text: string, heading: string): string {
  const m = new RegExp(`^## ${heading}\\n([\\s\\S]*?)(?=^## |^---\\n\\*F\\.R\\.I\\.D\\.A\\.Y\\.|$(?![\\s\\S]))`, "m").exec(text);
  return m ? m[1].trim() : "";
}

export interface LectureDigest {
  path: string;
  subject: string;
  date: string;
  title: string;
  key: string;
  review: string;
  tasks: string;
  terms: string;
}

/** 授業ノートの一覧（新しい順）。subject を渡すと、その科目（フォルダ名に含まれるもの）だけ */
export async function listLectureNotes(subject?: string) {
  const files = (await listNotes()).filter((f) => /^授業\/[^/]+\/\d{4}-\d{2}-\d{2} /.test(f.path));
  const want = subject?.replace(/\s+/g, "");
  return files
    .filter((f) => !want || f.path.split("/")[1].replace(/\s+/g, "").includes(want) || want.includes(f.path.split("/")[1].replace(/\s+/g, "")))
    .sort((a, b) => b.path.split("/")[2].localeCompare(a.path.split("/")[2]));
}

/** 授業ノートを要点だけにする */
export async function lectureDigest(file: BrainFile): Promise<LectureDigest> {
  const text = await readNote(file);
  const [, subject, name] = file.path.split("/");
  return {
    path: file.path,
    subject,
    date: name.slice(0, 10),
    title: /^# (.+)$/m.exec(text)?.[1] ?? name.replace(/\.md$/, ""),
    key: section(text, "重要なところ").slice(0, 1200),
    review: section(text, "復習チェック").slice(0, 600),
    tasks: section(text, "課題・連絡").slice(0, 600),
    terms: section(text, "用語").slice(0, 1200),
  };
}

/** 最近（days 日以内）の授業の要点（新しい順・最大 max 件） */
export async function recentLectures(tz: string, days: number, max = 3): Promise<LectureDigest[]> {
  if (!isBrainConfigured()) return [];
  const from = new Intl.DateTimeFormat("sv-SE", { timeZone: tz }).format(new Date(Date.now() - days * 24 * 60 * 60_000));
  const files = (await listLectureNotes()).filter((f) => f.path.split("/")[2].slice(0, 10) >= from).slice(0, max);
  return Promise.all(files.map((f) => lectureDigest(f)));
}

/** 資料・PDF・スライドを頼まれているか（「〇〇の資料作って」「PDF でまとめて」「スライド作って」） */
export function asksForDocument(text: string): boolean {
  return /資料|PDF|ＰＤＦ|ピーディーエフ|スライド|プレゼン|発表(用|の)?資料|レジュメ|まとめ(て|た)?(もの|やつ)?(を)?(作|つく)/i.test(text) || (/まとめて/.test(text) && /授業|講義|ノート|範囲|テスト/.test(text));
}

/**
 * 資料づくりの材料：発言に科目名（授業フォルダの名前）が入っていれば、その科目の授業ノート（新しい順に最大 6 回分）。
 * 文字起こしの全文は除き、まとめの部分だけを渡す。科目が分からなければ null
 */
export async function lectureMaterial(text: string): Promise<{ subject: string; notes: { date: string; title: string; text: string }[] } | null> {
  if (!isBrainConfigured()) return null;
  const all = await listLectureNotes();
  const plain = text.replace(/\s+/g, "");
  const subject = [...new Set(all.map((f) => f.path.split("/")[1]))].find((s) => plain.includes(s.replace(/\s+/g, "")));
  if (!subject) return null;
  const files = all.filter((f) => f.path.split("/")[1] === subject).slice(0, 6);
  const notes = await Promise.all(
    files.map(async (f) => {
      const body = await readNote(f);
      const name = f.path.split("/")[2];
      const cut = body.search(/^#{1,3}\s*文字起こし/m);
      return {
        date: name.slice(0, 10),
        title: /^# (.+)$/m.exec(body)?.[1] ?? name.replace(/\.md$/, ""),
        text: (cut > 0 ? body.slice(0, cut) : body).slice(0, 6000),
      };
    }),
  );
  return { subject, notes };
}

/* ---------- 集中モードの記録 ---------- */

export const FOCUS_LOG_PATH = "FRIDAY/集中ログ.md";

/** 集中した記録を 1 行書き足す（日付ごとに見出し） */
export async function appendFocusLog(input: { task: string; minutes: number; startedAt: number; completed: boolean }): Promise<void> {
  if (!isBrainConfigured()) throw new Error("脳（Obsidian）が接続されていないため保存できません。");
  const start = new Date(input.startedAt);
  const end = new Date(input.startedAt + input.minutes * 60_000);
  const date = day(start);
  const hm = (d: Date) => hhmm(d).replace(/^(\d\d)/, "$1:");
  const line = `- ${hm(start)}–${hm(end)}（${input.minutes} 分）${input.task || "集中"}${input.completed ? " ✓" : " （途中で終了）"}`;
  await updateNote(
    FOCUS_LOG_PATH,
    (current) => {
      const base = current ?? "# 集中ログ\n\nF.R.I.D.A.Y. の集中モードの記録です。\n";
      const head = `## ${date}`;
      if (!base.includes(`\n${head}\n`)) return `${base.trimEnd()}\n\n${head}\n${line}\n`;
      // その日の見出しの下（次の見出しの前）に足す
      return base.replace(new RegExp(`(\\n${head}\\n(?:- .*\\n)*)`), `$1${line}\n`);
    },
    `F.R.I.D.A.Y.: 集中ログ（${date}）`,
  );
}

/* ---------- クイズ ---------- */

export const QUIZ_LOG_PATH = "学習/クイズ記録.md";

/** クイズの材料：頼まれた科目（フォルダ名が発言に含まれるもの）の最近の授業ノート。科目が分からなければ最近の授業ノート */
export async function quizMaterial(text: string): Promise<{ subject: string | null; notes: LectureDigest[] }> {
  if (!isBrainConfigured()) return { subject: null, notes: [] };
  const all = await listLectureNotes();
  const subjects = [...new Set(all.map((f) => f.path.split("/")[1]))];
  const plain = text.replace(/\s+/g, "");
  const subject = subjects.find((s) => plain.includes(s.replace(/\s+/g, ""))) ?? null;
  const files = (subject ? all.filter((f) => f.path.split("/")[1] === subject) : all).slice(0, 3);
  return { subject, notes: await Promise.all(files.map((f) => lectureDigest(f))) };
}

/** クイズの結果を「学習/クイズ記録.md」に書き足す */
export async function appendQuizResult(r: { subject: string; score: number; total: number; weak: string[] }): Promise<void> {
  if (!isBrainConfigured()) throw new Error("脳（Obsidian）が接続されていないため保存できません。");
  const date = day();
  const line = `- ${date} ${hhmm(new Date()).replace(/^(\d\d)/, "$1:")}｜${r.subject || "クイズ"}｜${r.score} / ${r.total} 問${r.weak.length ? `｜苦手：${r.weak.join("、")}` : ""}`;
  await updateNote(
    QUIZ_LOG_PATH,
    (current) => `${(current ?? "# クイズ記録\n\nF.R.I.D.A.Y. のクイズの結果です。苦手なところは、次のクイズや朝のブリーフィングで優先して復習します。\n").trimEnd()}\n${line}\n`,
    `F.R.I.D.A.Y.: クイズの結果（${date}）`,
  );
}

/** 最近のクイズの苦手なところ（新しい順・最大 8 個） */
export async function recentWeakPoints(): Promise<string[]> {
  if (!isBrainConfigured()) return [];
  // 書いた直後でも読めるよう、一覧（キャッシュ）を通さずに直接読む
  const text = await readFresh(QUIZ_LOG_PATH);
  if (!text) return [];
  return [...new Set(text.split("\n").reverse().flatMap((l) => /苦手：(.+)$/.exec(l)?.[1].split("、") ?? []))].slice(0, 8);
}
