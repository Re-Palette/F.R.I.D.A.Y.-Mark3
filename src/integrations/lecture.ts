/**
 * 授業の文字起こしから、まとめ（全体像・流れ・重要なところ・用語・テストに出そうなところ・課題）を作る。
 * 文字起こしは音声認識なので、聞き間違い・言いよどみ・雑談が混じっている前提で読ませる。
 */
import type { LectureSummary } from "@/lib/lecture";
import { getGeminiConfig } from "@/lib/config";
import { streamGemini } from "@/llm/gemini";

/** 受け付ける文字起こしの長さ（約 3 時間分） */
export const MAX_TRANSCRIPT = 120_000;

const SYSTEM = `あなたは大学・学校の授業ノートを作るのが得意なアシスタント。授業の文字起こしから、あとで復習・試験勉強に使えるまとめを作る。
文字起こしは音声認識なので、聞き間違い・言いよどみ・板書の読み上げの切れ端・雑談が混じっている。文脈から正しい言葉を推し量って直し、
授業の中身と関係ない雑談は省く。ただし、文字起こしに無いことを付け足したり、推測で事実を作ったりしない（分からない所は書かない）。
[mm:ss] は授業の始まりからの時刻。
出力は JSON だけ（前置き・説明・コードブロックの記号は書かない）。

# 形式
{"title":"この授業の内容を表す短い題（30 字以内）",
 "overview":"全体像：この授業で何を学んだか、話のつながりが分かるように 3〜6 文で",
 "outline":[{"time":"mm:ss","heading":"話の区切りの見出し","points":["その区切りの要点（1 文ずつ、2〜5 個）"]}],
 "keyPoints":[{"point":"重要なところ（1 文）","detail":"補足・理由・例（1〜2 文。無ければ省く）","time":"mm:ss"}],
 "terms":[{"term":"用語","meaning":"授業での意味（1〜2 文）"}],
 "exam":["テストに出そうなところ・先生が「大事」「試験に出す」などと強調したところ"],
 "notices":["課題・提出物・締め切り・次回の予告・持ち物などの連絡（無ければ空）"],
 "tasks":[{"text":"やること（課題・提出物・小テストの準備など。短く）","due":"YYYY-MM-DD（締め切りが分かるときだけ。「来週の授業まで」なら授業の日付の 7 日後のように計算する）"}],
 "review":["復習で確かめるとよいこと（問いの形で）"]}

# 量の目安
- outline は話の区切りごと（授業の長さに合わせて 3〜10 個）
- keyPoints は 5〜12 個、terms は出てきた重要な用語（0〜15 個）、exam は 0〜8 個、review は 3〜6 個
- 文字起こしが短い・中身が少ないときは、無理に埋めずに少なくてよい`;

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const list = <T>(v: unknown, max: number, map: (x: unknown) => T | null): T[] =>
  Array.isArray(v) ? v.map(map).filter((x): x is T => x !== null).slice(0, max) : [];
const time = (v: unknown) => (typeof v === "string" && /^\d{1,2}:\d{2}(:\d{2})?$/.test(v.trim()) ? v.trim() : undefined);

/** Gemini の返事を検証して、決まった形にそろえる */
export function sanitizeSummary(v: unknown, subject: string): LectureSummary {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const lines = (x: unknown) => list(x, 12, (s) => str(s, 300) || null);
  const summary: LectureSummary = {
    title: str(o.title, 60) || subject || "授業のまとめ",
    overview: str(o.overview, 1500),
    outline: list(o.outline, 12, (x) => {
      const r = (x ?? {}) as Record<string, unknown>;
      const heading = str(r.heading, 80);
      return heading ? { time: time(r.time), heading, points: lines(r.points).slice(0, 8) } : null;
    }),
    keyPoints: list(o.keyPoints, 15, (x) => {
      const r = (x ?? {}) as Record<string, unknown>;
      const point = str(r.point, 300);
      return point ? { point, detail: str(r.detail, 400) || undefined, time: time(r.time) } : null;
    }),
    terms: list(o.terms, 20, (x) => {
      const r = (x ?? {}) as Record<string, unknown>;
      const term = str(r.term, 60);
      const meaning = str(r.meaning, 300);
      return term && meaning ? { term, meaning } : null;
    }),
    exam: lines(o.exam),
    notices: lines(o.notices),
    tasks: list(o.tasks, 10, (x) => {
      const r = (x ?? {}) as Record<string, unknown>;
      const text = str(r.text, 120);
      const due = typeof r.due === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.due.trim()) ? r.due.trim() : undefined;
      return text ? { text, ...(due ? { due } : {}) } : null;
    }),
    review: lines(o.review),
  };
  if (!summary.overview && !summary.keyPoints.length) throw new Error("まとめを作れませんでした。もう一度試してください。");
  return summary;
}

export async function summarizeLecture(input: { subject: string; transcript: string; minutes: number; date?: string }): Promise<LectureSummary> {
  const config = getGeminiConfig();
  const ask = `科目：${input.subject || "（未入力）"}
授業の日付：${input.date ?? "（不明）"}
授業の長さ：約 ${Math.max(1, Math.round(input.minutes))} 分

# 文字起こし
${input.transcript}`;
  let text = "";
  for await (const chunk of streamGemini({
    config: { ...config, thinkingLevel: "low", maxOutputTokens: 12_000, temperature: 0.3 },
    systemInstruction: SYSTEM,
    contents: [{ role: "user", parts: [{ text: ask }] }],
  })) {
    text += chunk.text;
  }
  const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("まとめを作れませんでした。もう一度試してください。");
  }
  return sanitizeSummary(parsed, input.subject);
}
