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
import { isBrainConfigured, updateNote } from "@/memory/github-brain";

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

/** 授業ノートを保存する（前に保存した場所があれば、そこを書き直す） */
export async function saveLectureNote(lecture: Lecture, previous?: string): Promise<{ path: string }> {
  if (!isBrainConfigured()) throw new Error("脳（Obsidian）が接続されていないため保存できません。");
  const path = previous ?? lecturePath(lecture);
  await updateNote(path, () => lectureMarkdown(lecture), `F.R.I.D.A.Y.: 授業ノートを保存（${path}）`);
  return { path };
}
