/**
 * 読み上げ用の読み替え（画面の文字はそのまま、声にするときだけ）。
 * 音声合成は「陽大」を「ようだい」と読んでしまうので、正しい読みのひらがなにして渡す。
 */
import { OWNER, OWNER_READING } from "@/agents/chat/profile";

const READINGS: [RegExp, string][] = [[new RegExp(OWNER, "g"), OWNER_READING]];

export function withReadings(text: string): string {
  return READINGS.reduce((t, [from, to]) => t.replace(from, to), text);
}
