/**
 * 音声の文字起こし（スマホの音声会話用）。
 * スマホのブラウザの音声認識は、マイクが付いても声を拾わないことがある（iPhone のホーム画面から開いたときなど）ので、
 * スマホでは画面が録った短い音声（WAV）をここで Gemini に渡して文字にする。音声は文字にするためだけに使い、保存しない。
 */
import { streamGemini } from "@/llm/gemini";
import { warmGemini } from "@/llm/health";
import { getGeminiConfig } from "@/lib/config";

const PROMPT = `この音声は、日本語で AI 秘書「フライデー」に話しかけたものです。話した内容をそのまま文字にしてください。
- 文字起こしだけを返す（説明・かぎかっこ・前置きは付けない）。
- 言いよどみ（えーと、あの）は省いてよい。
- 呼びかけの「フライデー」「カレン」は省かず、聞こえたとおりカタカナで書く（「フライデー」だけの発言なら「フライデー」とだけ返す）。
- 話している人の名前は「陽大（はると）」。「はると」と聞こえたら「陽大」と書く。
- 声が入っていない・物音だけ・音楽やテレビの音・聞き取れないときは、何も返さない（空にする）。
- 「フライデー」「カレン」は、はっきりそう話しかけた声のときだけ書く。似た音・雑音を「フライデー」と書かない。`;

/**
 * 呼びかけを待っている間の文字起こし。「フライデー」という言葉を指示に入れない
 * （入れると、雑音やテレビの音まで「フライデー」と書いてしまい、呼んでいないのに起動するため）。
 */
const WAKE_PROMPT = `この音声を、聞こえたとおりに日本語で文字にしてください。
- 文字起こしだけを返す（説明・かぎかっこ・前置きは付けない）。
- 人がはっきり話した言葉だけを書く。雑音・物音・音楽・テレビやほかの人の小さな声・聞き取れない音は書かない。
- 話した言葉が無いときは、何も返さない（空にする）。推測で言葉を補わない。`;

/** 1 回に受け付ける音声の大きさ（base64 の文字数。16kHz・モノラルの WAV で約 60 秒） */
export const MAX_AUDIO_CHARS = 2_600_000;

export async function transcribe(audio: string, mimeType: string, signal?: AbortSignal, purpose: "talk" | "wake" = "talk"): Promise<string> {
  const config = getGeminiConfig();
  // 速さ優先：軽いモデル（Flash-Lite）を先に、考える時間は最小で
  const models = [...config.models].sort((a, b) => Number(b.includes("lite")) - Number(a.includes("lite")));
  let text = "";
  for await (const chunk of streamGemini({
    config: { ...config, models, model: models[0], thinkingLevel: "minimal", temperature: 0, maxOutputTokens: 300 },
    contents: [{ role: "user", parts: [{ inlineData: { mimeType, data: audio } }, { text: purpose === "wake" ? WAKE_PROMPT : PROMPT }] }],
    signal,
  })) {
    text += chunk.text;
  }
  return text
    .replace(/^[「『"]|[」』"]$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** 話し始めたときに呼ぶ：Gemini への接続を温めておく */
export function warmStt(): void {
  warmGemini();
}
