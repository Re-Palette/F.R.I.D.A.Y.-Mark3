/**
 * 音声の文字起こし（スマホの音声会話用）。
 * スマホのブラウザの音声認識は、マイクが付いても声を拾わないことがある（iPhone のホーム画面から開いたときなど）ので、
 * スマホでは画面が録った短い音声（WAV）をここで Gemini に渡して文字にする。音声は文字にするためだけに使い、保存しない。
 */
import { streamGemini } from "@/llm/gemini";
import { getGeminiConfig } from "@/lib/config";

const PROMPT = `この音声は、日本語で AI 秘書「フライデー」に話しかけたものです。話した内容をそのまま文字にしてください。
- 文字起こしだけを返す（説明・かぎかっこ・前置きは付けない）。
- 言いよどみ（えーと、あの）は省いてよい。
- 声が入っていない・物音だけ・聞き取れないときは、何も返さない（空にする）。`;

/** 1 回に受け付ける音声の大きさ（base64 の文字数。16kHz・モノラルの WAV で約 60 秒） */
export const MAX_AUDIO_CHARS = 2_600_000;

export async function transcribe(audio: string, mimeType: string, signal?: AbortSignal): Promise<string> {
  const config = getGeminiConfig();
  let text = "";
  for await (const chunk of streamGemini({
    config: { ...config, thinkingLevel: undefined, temperature: 0, maxOutputTokens: 400 },
    contents: [{ role: "user", parts: [{ inlineData: { mimeType, data: audio } }, { text: PROMPT }] }],
    signal,
  })) {
    text += chunk.text;
  }
  return text
    .replace(/^[「『"]|[」』"]$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
