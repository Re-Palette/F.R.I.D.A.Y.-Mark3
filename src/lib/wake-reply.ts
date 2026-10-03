/**
 * 「フライデー」とだけ呼ばれたときの最初の一言（あいさつの前置きはしない）。
 * 状況で選ぶ:
 *   - その日はじめて / 久しぶり … 「準備できています。」
 *   - さっきまで話していた       … 「どうしました、陽大。」
 *   - 続けて何度も呼ばれた       … 「お呼びでしょうか、陽大。」
 *   - それ以外                   … 「はい、陽大。」
 * 声は先に作っておき（ElevenLabs）、呼ばれたらすぐ返せるようにする。
 */
import { OWNER } from "@/agents/chat/profile";

export const WAKE_REPLIES = [`はい、${OWNER}。`, `どうしました、${OWNER}。`, `お呼びでしょうか、${OWNER}。`, "準備できています。"] as const;

const MIN = 60_000;

export interface WakeContext {
  now: number;
  /** 最後に呼ばれた時刻（なければ 0） */
  lastWakeAt: number;
  /** 最後に会話した（話した・聞いた）時刻（なければ 0） */
  lastTalkAt: number;
}

export function pickWakeReply({ now, lastWakeAt, lastTalkAt }: WakeContext): string {
  const [yes, what, called, ready] = WAKE_REPLIES;
  const sameDay = lastTalkAt > 0 && new Date(lastTalkAt).toDateString() === new Date(now).toDateString();
  if (!lastTalkAt || !sameDay || now - lastTalkAt > 3 * 60 * MIN) return ready;
  if (lastWakeAt && now - lastWakeAt < 20_000) return called;
  if (now - lastTalkAt < 3 * MIN) return what;
  return yes;
}
