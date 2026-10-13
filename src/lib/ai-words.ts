/**
 * AI の名前の呼び方・切り替えの言葉を見分ける（F.R.I.D.A.Y. / K.A.R.E.N. / E.D.I.T.H.）。
 * 画面（ai-mode・speech）とサーバー（LINE）の両方で使うので、ブラウザや React に頼らない。
 */

export type AiMode = "friday" | "karen" | "edith";

/** 名前の呼び方（K.A.R.E.N. / KAREN / カレン / かれん） */
const KAREN = /(k\.?\s*a\.?\s*r\.?\s*e\.?\s*n\.?(?![a-z])|カレン(?![ダトシ])|かれん|(?:可憐|花蓮|華蓮|夏蓮|佳蓮)(?!な))/i;
/** E.D.I.T.H. の呼び方（E.D.I.T.H. / EDITH / イーディス / エディス） */
/**
 * E.D.I.T.H. の名前の書かれ方（文字起こしの揺れも拾う）：EDITH / E.D.I.T.H. / Edith / イーディス / イディス / イーデス / エディス / エーディス /
 * エディット / いーでぃす / いでぃす / えでぃす。「かわいいです」の「いです」のような普通の言葉は拾わない（ひらがなは「でぃ」のときだけ）。
 */
export const EDITH_NAME_SRC =
  "e\\.?\\s*d\\.?\\s*i\\.?\\s*t\\.?\\s*h\\.?(?![a-z])|イ[ー・\\s]?(?:ディ|デ)ー?ス|エ[ー・\\s]?(?:ディ|デ)ス|エディット|イーディー(?=[、。,\\s]|を|に|$)|[いえ]ー?でぃす";
const EDITH = new RegExp(`(${EDITH_NAME_SRC})`, "i");
/** 「グローバルプロトコル起動」：名前を言わなくても E.D.I.T.H. を起動する合言葉（どのモードからでも） */
export const GLOBAL_PROTOCOL_RE = /(グローバル|ぐろーばる|global)[\s・･\-]*(プロトコル|ぷろとこる|protocol)[\s、。]*(を)?[\s]*(起動|きどう|発動|開始|スタート|オン|start|on|開いて|開け)/i;
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
  if (GLOBAL_PROTOCOL_RE.test(t)) return "to-edith";
  // 「〇〇を開いて」：名前の AI のモードへ（「カレンを開いて」「イーディスを開いて」「フライデーを開いて」）
  if (/(開いて|ひらいて|開く|ひらく|開け|あけて|オープン|open|立ち上げ)/i.test(t)) {
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

/**
 * 音声認識での表記ゆれを拾う：フライデー / フライデイ / フライディ / ふらいでー / フライ・デー / Friday / ＦＲＩＤＡＹ、
 * 聞き間違いの多い プライデー / ブライデー（伸ばす音まであるときだけ）。
 * 発言の頭で呼んだときだけ起きる（「ねえ」「ヘイ」などは前に付いてよい）。文の途中の「ブラックフライデー」「今日はフライデー」では起きない。
 */
const WAKE_BODY =
  "(?:[フふ][\\s・]*[ラら][\\s・]*[イいィぃ][\\s・]*(?:ディ|でぃ|[デで])[\\s・]*[ーィぃイいエえ〜]?|[プぷブぶ][\\s・]*[ラら][\\s・]*[イい][\\s・]*[デで][\\s・]*[ーイい]|f\\s*r\\s*i\\s*d\\s*a\\s*y|ｆ\\s*ｒ\\s*ｉ\\s*ｄ\\s*ａ\\s*ｙ)";
/** 呼びかけの前に付いてよい言葉 */
const WAKE_LEAD = "(?:(?:ねえ|ねぇ|ねー|ヘイ|へい|hey|おい|あの|えっと|えーと|ちょっと|ok|オッケー)[\\s、。,.!！ー〜]*)?";
const WAKE_TAIL = "[\\s、。,.!！?？ー〜]*";
export const WAKE_RE = new RegExp(`^[\\s、。「]*${WAKE_LEAD}${WAKE_BODY}${WAKE_TAIL}`, "i");

/** K.A.R.E.N. の呼び方（カレン / K.A.R.E.N.）。「カレンダー」「カレント」は呼びかけではない。これも発言の頭で呼んだときだけ */
export const KAREN_WAKE_RE = new RegExp(
  `^[\\s、。「]*${WAKE_LEAD}(?:[カか]\\s*[レれ]\\s*[ンん](?![ダだトとシし])|(?:可憐|花蓮|華蓮|夏蓮|佳蓮)(?!な)|k\\.?\\s*a\\.?\\s*r\\.?\\s*e\\.?\\s*n\\.?(?![a-z]))${WAKE_TAIL}`,
  "i",
);

/** E.D.I.T.H. の呼び方（イーディス / エディス / E.D.I.T.H.）。これも発言の頭で呼んだときだけ */
export const EDITH_WAKE_RE = new RegExp(
  `^[\\s、。「]*${WAKE_LEAD}(?:${EDITH_NAME_SRC})${WAKE_TAIL}`,
  "i",
);

/** aiCall と同じ。いまのモードを渡す（画面の外＝サーバー、LINE などで使う） */
export function aiCallFrom(text: string, mode: AiMode): { mode: AiMode; rest: string } | null {
  for (const [m, re] of [
    ["friday", WAKE_RE],
    ["karen", KAREN_WAKE_RE],
    ["edith", EDITH_WAKE_RE],
  ] as const) {
    if (m === mode) continue;
    const hit = re.exec(text);
    if (hit) return { mode: m, rest: text.slice(hit[0].length).trim() };
  }
  return null;
}
