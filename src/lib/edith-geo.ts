/**
 * E.D.I.T.H. の世界地図に印を付けるための地名の一覧（国・主な都市の代表地点）。
 * 文章に出てくる国名・都市名を見つけて、緯度・経度を返す（その場所の正確な位置ではなく、国・都市の代表地点）。
 */

export interface Place {
  /** 画面に出す名前 */
  name: string;
  lat: number;
  lon: number;
}

/** [名前, 緯度, 経度, 見つける言葉（正規表現の一部）] */
const PLACES: [string, number, number, string][] = [
  ["日本", 36.2, 138.3, "日本|東京|大阪|京都|japan|tokyo"],
  ["アメリカ", 38.9, -77.0, "アメリカ|米国|米(?=[政大首軍中株])|ワシントン|ホワイトハウス|united states|u\\.s\\.|usa|america"],
  ["ニューヨーク", 40.7, -74.0, "ニューヨーク|ウォール街|new york"],
  ["シリコンバレー", 37.4, -122.1, "シリコンバレー|サンフランシスコ|カリフォルニア|silicon valley|san francisco|california"],
  ["カナダ", 45.4, -75.7, "カナダ|canada"],
  ["メキシコ", 19.4, -99.1, "メキシコ|mexico"],
  ["ブラジル", -15.8, -47.9, "ブラジル|brazil"],
  ["アルゼンチン", -34.6, -58.4, "アルゼンチン|argentina"],
  ["チリ", -33.4, -70.6, "チリ(?!ソース)|chile"],
  ["イギリス", 51.5, -0.1, "イギリス|英国|英(?=[政首国中])|ロンドン|united kingdom|britain|\\buk\\b|london"],
  ["フランス", 48.9, 2.35, "フランス|仏(?=[政大国])|パリ|france|paris"],
  ["ドイツ", 52.5, 13.4, "ドイツ|独(?=[政国首])|ベルリン|germany|berlin"],
  ["イタリア", 41.9, 12.5, "イタリア|ローマ|italy|rome"],
  ["スペイン", 40.4, -3.7, "スペイン|マドリード|spain|madrid"],
  ["オランダ", 52.4, 4.9, "オランダ|アムステルダム|netherlands"],
  ["スイス", 46.9, 7.4, "スイス|ジュネーブ|switzerland|geneva"],
  ["EU", 50.85, 4.35, "欧州連合|\\beu\\b|ブリュッセル|欧州委員会|european union|brussels"],
  ["スウェーデン", 59.3, 18.1, "スウェーデン|sweden"],
  ["ノルウェー", 59.9, 10.8, "ノルウェー|norway"],
  ["ポーランド", 52.2, 21.0, "ポーランド|poland"],
  ["ウクライナ", 50.45, 30.5, "ウクライナ|キーウ|ukraine|kyiv"],
  ["ロシア", 55.75, 37.6, "ロシア|露(?=[政大国])|モスクワ|russia|moscow"],
  ["トルコ", 39.9, 32.9, "トルコ|türkiye|turkey"],
  ["イスラエル", 31.8, 35.2, "イスラエル|israel"],
  ["パレスチナ", 31.5, 34.45, "パレスチナ|ガザ|palestine|gaza"],
  ["イラン", 35.7, 51.4, "イラン|iran"],
  ["サウジアラビア", 24.7, 46.7, "サウジ|saudi"],
  ["アラブ首長国連邦", 24.45, 54.4, "UAE|アラブ首長国連邦|ドバイ|アブダビ|dubai|abu dhabi"],
  ["エジプト", 30.0, 31.2, "エジプト|egypt"],
  ["南アフリカ", -25.7, 28.2, "南アフリカ|south africa"],
  ["ナイジェリア", 9.1, 7.5, "ナイジェリア|nigeria"],
  ["ケニア", -1.3, 36.8, "ケニア|kenya"],
  ["インド", 28.6, 77.2, "インド(?!ネシア)|ニューデリー|india"],
  ["パキスタン", 33.7, 73.1, "パキスタン|pakistan"],
  ["中国", 39.9, 116.4, "中国|北京|上海|深セン|china|beijing|shanghai"],
  ["香港", 22.3, 114.2, "香港|hong kong"],
  ["台湾", 25.0, 121.5, "台湾|台北|taiwan"],
  ["韓国", 37.6, 127.0, "韓国|ソウル|korea|seoul"],
  ["北朝鮮", 39.0, 125.75, "北朝鮮|north korea"],
  ["シンガポール", 1.35, 103.8, "シンガポール|singapore"],
  ["タイ", 13.75, 100.5, "タイ(?![ムプトルヤミ])|バンコク|thailand"],
  ["ベトナム", 21.0, 105.85, "ベトナム|vietnam"],
  ["インドネシア", -6.2, 106.8, "インドネシア|ジャカルタ|indonesia"],
  ["フィリピン", 14.6, 121.0, "フィリピン|philippines"],
  ["マレーシア", 3.1, 101.7, "マレーシア|malaysia"],
  ["オーストラリア", -35.3, 149.1, "オーストラリア|豪州|豪(?=[政首])|シドニー|australia|sydney"],
  ["ニュージーランド", -41.3, 174.8, "ニュージーランド|new zealand"],
];

const COMPILED = PLACES.map(([name, lat, lon, re]) => ({ name, lat, lon, re: new RegExp(re, "i") }));

/** 文章に出てくる場所（出てきた順・重複なし） */
export function findPlaces(text: string, max = 3): Place[] {
  const hits: { place: Place; at: number }[] = [];
  for (const p of COMPILED) {
    const m = p.re.exec(text);
    if (m) hits.push({ place: { name: p.name, lat: p.lat, lon: p.lon }, at: m.index });
  }
  return hits
    .sort((a, b) => a.at - b.at)
    .slice(0, max)
    .map((h) => h.place);
}
