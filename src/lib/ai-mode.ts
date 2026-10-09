/**
 * いまどの AI が受け持っているか（F.R.I.D.A.Y. / K.A.R.E.N.）。画面の切り替えと会話の行き先は、必ずここを見る。
 *   F.R.I.D.A.Y.：ふだんの会話・検索・予定・情報整理・会社の支援・ほかの AI やツールの呼び出し
 *   K.A.R.E.N. ：3D モデル・3D シーン・ホログラム用の見た目・デザイン・アニメーション・モデル編集・レンダリング
 * 会話の履歴・設定・使えるツールは共有する（同じシステムの 2 つの AI）。
 * 切り替えの言葉は AI に聞かずにこの端末で見分ける（速く・オフラインでも・誤って会話として送らないように）。
 */
import { useSyncExternalStore } from "react";

export type AiMode = "friday" | "karen" | "edith";

const KEY = "friday.ai-mode.v1";
let mode: AiMode = "friday";
let loaded = false;
const listeners = new Set<() => void>();

function load() {
  if (loaded || typeof window === "undefined") return;
  loaded = true;
  try {
    // 開き直したときも同じ AI のまま（タブを閉じたら F.R.I.D.A.Y. に戻る）
    const saved = sessionStorage.getItem(KEY);
    if (saved === "karen" || saved === "edith") mode = saved;
  } catch {
    /* noop */
  }
}

export function getAiMode(): AiMode {
  load();
  return mode;
}

export function setAiMode(next: AiMode): void {
  load();
  if (mode === next) return;
  mode = next;
  try {
    sessionStorage.setItem(KEY, next);
  } catch {
    /* noop */
  }
  listeners.forEach((l) => l());
}

export function useAiMode(): AiMode {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    getAiMode,
    () => "friday",
  );
}

/** 名前の呼び方（K.A.R.E.N. / KAREN / カレン / かれん） */
const KAREN = /(k\.?\s*a\.?\s*r\.?\s*e\.?\s*n\.?(?![a-z])|カレン(?![ダトシ])|かれん|(?:可憐|花蓮|華蓮|夏蓮|佳蓮)(?!な))/i;
/** E.D.I.T.H. の呼び方（E.D.I.T.H. / EDITH / イーディス / エディス） */
const EDITH = /(e\.?\s*d\.?\s*i\.?\s*t\.?\s*h\.?(?![a-z])|イーディス|いーでぃす|エディス|イーディー(?=[、。,\s]|を|に|$))/i;
const FRIDAY = /(f\.?\s*r\.?\s*i\.?\s*d\.?\s*a\.?\s*y\.?|フライデー|ふらいでー)/i;

/**
 * 発言が AI の切り替えの指示か。違えば null。
 *   to-karen ：「K.A.R.E.N.を呼び出して」「カレン、起動」「クリエイティブモードに切り替えて」「3D制作を始めたい」
 *   to-friday：「FRIDAYに戻して」「通常モードに戻って」「カレン終了」
 * 迷うもの（「カレンって何？」など）は切り替えない。
 */
export function detectModeCommand(text: string): "to-karen" | "to-friday" | "to-edith" | null {
  const t = text.trim().replace(/[。、！!？?\s]+/g, " ").trim();
  if (!t || t.length > 40) return null;
  if (/(って|とは|って何|ってなに|について)/.test(t) && !/(呼|起動|切り替|戻|開)/.test(t)) return null;
  // 「〇〇を開いて」：名前の AI のモードへ（「カレンを開いて」「イーディスを開いて」「フライデーを開いて」）
  if (/(開いて|ひらいて|開く|ひらく|開け|オープン|立ち上げ)/.test(t)) {
    if (EDITH.test(t)) return "to-edith";
    if (KAREN.test(t)) return "to-karen";
    if (FRIDAY.test(t)) return "to-friday";
  }
  // F.R.I.D.A.Y. に戻る
  if (FRIDAY.test(t) && /(戻|もど|切り替|代わ|かわ|交代|に変え)/.test(t)) return "to-friday";
  // 呼びかけ（「フライデー」「カレン」）を取り除いたあとの「に戻して」「終了」（K.A.R.E.N. の間だけ意味がある）
  if (/^(に|へ)?(戻|もど)(して|って|る|ろう|りたい)$/.test(t) || /^(終了|おわり|終わり|おしまい)(して)?$/.test(t)) return "to-friday";
  if (FRIDAY.test(t) && /(呼|よん|お願い|おねがい)/.test(t)) return "to-friday";
  if (/(通常|ふつう|普通|いつもの)(の)?モード(に|へ)?(戻|もど|切り替)/.test(t)) return "to-friday";
  if (KAREN.test(t) && /(終了|終わ|おわ|閉じ|オフ|停止|おやすみ|ありがとう(、|\s)?(もう)?(いい|大丈夫))/.test(t)) return "to-friday";
  if (/クリエイティブモード(を)?(終了|終わ|やめ|オフ)/.test(t)) return "to-friday";
  if (EDITH.test(t) && /(終了|終わ|おわ|閉じ|オフ|停止|おやすみ)/.test(t)) return "to-friday";
  if (/(グローバル|インテリジェンス)(情報)?モード(を)?(終了|終わ|やめ|オフ)/.test(t)) return "to-friday";
  // K.A.R.E.N. を呼ぶ
  // 名前だけ（「カレン」）では切り替えない。呼ぶ・起動・切り替えの言葉があるときだけ
  if (KAREN.test(t) && /(呼|よ(ん|び)|起動|きどう|出して|だして|開いて|切り替|お願い|おねがい|に代わ|にかわ|交代|頼む)/.test(t)) return "to-karen";
  if (/クリエイティブ(モード)?(に|へ)?(切り替|変え|入|して|起動|お願い)/.test(t)) return "to-karen";
  if (/(3d|３d|３Ｄ|3D)(の)?(制作|製作|モデリング|作業)(を)?(始め|はじめ|したい|やりたい|開始)/i.test(t)) return "to-karen";
  // E.D.I.T.H. を呼ぶ
  if (EDITH.test(t) && /(呼|よ(ん|び)|起動|きどう|出して|だして|開いて|切り替|お願い|おねがい|に代わ|にかわ|交代|頼む)/.test(t)) return "to-edith";
  if (/(グローバル|インテリジェンス)(情報)?(モード)?(に|へ)?(切り替|変え|入|起動|お願い)/.test(t)) return "to-edith";
  return null;
}
