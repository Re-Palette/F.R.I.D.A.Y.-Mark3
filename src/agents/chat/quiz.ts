/**
 * 授業ノートからのクイズ。「線形代数のクイズ出して」→ 脳の授業ノートから 1 問ずつ出し、答えを判定し、最後に成績と苦手なところを伝える。
 * クイズの途中（答えている間）も材料を渡し続けるため、直近の会話でクイズを頼まれていれば続けてクイズの指示を入れる。
 */
import type { ChatMessage } from "@/core/types";
import type { LectureDigest } from "@/integrations/brain-notes";

const ASK = /クイズ|問題(を)?出して|テストして|理解度(を)?(チェック|確認)|復習(しよう|したい|させて|に付き合って)|一問一答/;

/** クイズを頼まれたか（今回の発言） */
export function asksForQuiz(text: string): boolean {
  return ASK.test(text);
}

/** 成績を伝えた返答（「5問中4問」など）。これが出たらクイズは終わり */
const FINISHED = /\d+\s*問中\s*\d+\s*問/;

/** クイズの途中か（直近 12 件の中でクイズを頼まれていて、まだ成績を伝えておらず、やめるとも言われていない） */
export function inQuiz(messages: ChatMessage[]): string | null {
  const recent = messages.slice(-12);
  for (let i = recent.length - 1; i >= 0; i--) {
    const m = recent[i];
    if (m.role === "assistant") {
      if (FINISHED.test(m.content)) return null;
      continue;
    }
    if (/クイズ(を)?(やめ|終わ|おわ)|もういい/.test(m.content) && i !== recent.length - 1) return null;
    if (ASK.test(m.content)) return m.content;
  }
  return null;
}

export function quizSection(m: { subject: string | null; notes: LectureDigest[]; weak: string[] }, voice: boolean): string {
  const notes = m.notes.length
    ? m.notes
        .map((n) => `## ${n.date} ${n.subject}「${n.title}」\n### 重要なところ\n${n.key || "（なし）"}\n### 用語\n${n.terms || "（なし）"}\n### 復習チェック\n${n.review || "（なし）"}`)
        .join("\n\n")
    : "（授業ノートが見つからない。頼まれた分野について、自分の知識から基本的な問題を出す）";
  return `

# クイズ（授業の復習）
- ユーザーの理解を確かめるクイズを出す相棒になる。1 回の返答で出すのは 1 問だけ。答えを聞いてから次へ進む。
- 問題は下の授業ノート（重要なところ・用語・復習チェック）から作る。ノートに無いことは出さない。前に出した問題と同じものは出さない。
- 形式を混ぜる：一問一答・三択（「A・B・C のどれ？」）・「〇〇を一言で説明してください」。${voice ? "声なので、問題も選択肢も短く、記号を使わずに読める形で。" : ""}
- 答えが来たら、まず「正解です」「おしい」「ちがいます」のどれかで判定し、正しい答えと短い解説（1〜2 文）を言ってから、次の問題を出す。
- 何問か言われなければ 5 問。最後の問題に答えたら（または「やめる」と言われたら）、成績（何問中何問正解）と、苦手そうなところ・次に復習するとよいところを伝え、
  返答の最後に次のタグを付ける（画面には出ず、Obsidian の「学習/クイズ記録.md」に残る）：
  <quiz-result>{"subject":"科目名","score":正解数,"total":出した問題数,"weak":["苦手なところ（短く）"]}</quiz-result>
- 成績を伝えたあとは、クイズを終えて普通の会話に戻る。
${m.weak.length ? `- 前回までのクイズで苦手だったところ：${m.weak.join("、")}（ノートにあれば優先して出す）` : ""}

# クイズの材料（授業ノート${m.subject ? `：${m.subject}` : ""}）
${notes}`;
}
