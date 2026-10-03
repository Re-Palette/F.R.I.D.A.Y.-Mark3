/**
 * 読み上げる文の雰囲気（声の調子をほんの少しだけ変えるため）。画面・サーバー両用。
 *   calm    … ふだん（落ち着いて）
 *   curious … 新しいアイデア・問いかけ（少しだけ興味を帯びて）
 *   warm    … 進んだ・できた（少しだけ明るく）
 *   concern … リスク・締め切り・問題（静かに、少し心配そうに）
 * どれも大げさにはしない（変えるのは ElevenLabs の安定度・強調・速さを少しだけ）。
 */
export type Tone = "calm" | "curious" | "warm" | "concern";

const CONCERN = /リスク|危険|危ない|注意|心配|懸念|問題|トラブル|エラー|失敗|遅れ|遅延|間に合わ|期限(を)?(過ぎ|切れ)|締め切りが(近|迫|明日|今日)|足りな|赤字|ミス|慎重|気をつけ|避けた方/;
const WARM = /進みました|進んで(い|き)|完了|終わりました|できました|達成|順調|伸びて|前進|うまくいき|片付き|クリア|形になって|見えてきて|いい感じ|良くなって/;
const CURIOUS = /面白|おもしろ|興味深|なるほど|新しい|アイデア|発想|可能性|試して(み|も)|ありです|どうでしょう|かもしれません|[？?]$/;

export function detectTone(text: string): Tone {
  if (CONCERN.test(text)) return "concern";
  if (WARM.test(text)) return "warm";
  if (CURIOUS.test(text)) return "curious";
  return "calm";
}

export function isTone(v: unknown): v is Tone {
  return v === "calm" || v === "curious" || v === "warm" || v === "concern";
}
