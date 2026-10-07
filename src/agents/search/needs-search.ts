/**
 * この発言に Web 検索が必要か（軽い判定）。
 * 無料枠の検索回数を節約するため、最新情報・調べものが要りそうなときだけ true。
 */
const SEARCH_HINTS = [
  /調べて|検索|ググ|ネットで|ウェブで|webで|サイト|公式/i,
  /ニュース|速報|最新|最近の|今話題|トレンド|話題になって/,
  /今年|今月|今週|昨日の|今日の(?!予定|スケジュール|天気)|現在の|いま何|今何/,
  /株価|為替|ドル円|レート|相場|価格|値段|いくら|セール|在庫/,
  /発売|リリース|公開日|放送|上映|開催|日程|チケット|営業時間|定休日/,
  /試合|結果|スコア|優勝|順位|選挙|決勝/,
  /誰が.*(した|なった)|何があった|どうなった|アップデート|バージョン/,
];

/** 検索しなくてよい話題（予定・天気・記憶は手元の情報で答える） */
const LOCAL_ONLY = /^(おはよう|こんにちは|こんばんは|おやすみ|ありがとう|了解|OK|うん|はい)/i;

/** はっきり「調べて」と言われたとき */
const EXPLICIT = /調べて|検索|ググ|ネットで|ウェブで|webで/i;

/**
 * 手元の情報（予定・ToDo・授業・プロジェクト・記憶・振り返り・自分のこと）で答える話。
 * 「今週の予定」「テストの結果」「最近の調子」などで検索して待たせないよう、はっきり頼まれたとき以外は検索しない
 */
const LOCAL_CONTEXT = /予定|スケジュール|ToDo|TODO|タスク|課題|宿題|授業|講義|テスト|試験|勉強|プロジェクト|進捗|ARQO|Re-?Palette|NEWTONE|FRIDAY|フライデー|記憶|覚えて|メモ|ノート|日記|振り返|調子|気分|俺|僕|私|自分|陽大|会社|社員|承認|メール|資料|スライド|PDF|クイズ/i;

/** SNS の投稿づくり・トレンドの相談か（SNS AI） */
export function asksForSns(text: string): boolean {
  return /インスタ|Instagram|instagram|X\s?の投稿|ツイート|ポスト(文|案)|投稿(文|案|内容)|SNS|ハッシュタグ|TikTok|ティックトック|リール|ストーリーズ|バズ/.test(text);
}

/** SNS のトレンドを調べる必要があるか */
export function asksForTrend(text: string): boolean {
  return asksForSns(text) && /トレンド|流行|はやって|話題|最近|今の/.test(text);
}

export function needsSearch(text: string): boolean {
  const t = text.trim();
  if (!t || t.length < 3 || LOCAL_ONLY.test(t)) return false;
  if (EXPLICIT.test(t)) return true;
  if (LOCAL_CONTEXT.test(t) || /^(今週|今日|今月|最近)(は|って)?どう/.test(t)) return false;
  return SEARCH_HINTS.some((re) => re.test(t));
}
