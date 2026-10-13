/**
 * E.D.I.T.H. の画面を、声・文字の指示で動かす（AI に渡さず、この端末で見分ける）。
 *   - 「渋谷をピックアップ」：その場所に寄って、近くのライブカメラを一覧で出す
 *   - 「新宿を3Dで見せて」：写真のような 3D の街を斜めから見せる
 *   - 「近くの飛行機を追って」「羽田の飛行機をピックアップ」：一番近い飛行機（船・バス）を選んで追いかける
 *   - 「雨雲を出して」「渋滞を消して」「地球全体に戻して」「追跡をやめて」：表示の切り替え
 * 質問・調べもの（教えて・天気・ニュース・検索など）は見分けず、これまでどおり AI に渡す。
 */
import { findCity, type CityPlace } from "@/lib/earth/places";
import { findPlaces } from "@/lib/edith-geo";

export type EarthLayerKey = "quakes" | "sats" | "aircraft" | "traffic" | "buses" | "ships" | "radar" | "clouds" | "detail" | "city3d" | "webcams";
export type TrackTarget = "aircraft" | "ship" | "bus";

export type EdithCommand =
  | { kind: "pickup"; place: CityPlace; cams: boolean; city3d: boolean; traffic: boolean; track: TrackTarget | null; country: boolean }
  | { kind: "cams"; traffic: boolean }
  | { kind: "track"; target: TrackTarget }
  | { kind: "untrack" }
  | { kind: "layer"; layer: EarthLayerKey; on: boolean }
  | { kind: "reset" };

export const LAYER_LABEL: Record<EarthLayerKey, string> = {
  quakes: "地震",
  sats: "人工衛星",
  aircraft: "飛行機",
  traffic: "道路の渋滞",
  buses: "都営バス",
  ships: "船",
  radar: "雨雲レーダー",
  clouds: "今日の地球の雲",
  detail: "詳細な衛星写真",
  city3d: "3D の街",
  webcams: "ライブカメラ",
};

const SHOW = /(見せ|みせ|映し|映せ|うつし|出し|だし|出せ|表示|ピックアップ|ぴっくあっぷ|pick ?up|寄っ|よっ|寄せ|飛ん|とん|移動|行って|いって|つけ|付け|点け|オン|開い|ひらい|映像に)/;
const GOTO = /(見せ|みせ|映し|映せ|うつし|寄っ|よっ|寄せ|飛ん|とん|移動|行って|いって)/;
const HIDE = /(消し|けし|消せ|隠し|かくし|非表示|オフ|止め|とめ|閉じ|とじ|外し|はずし|やめ)/;
const PICK = /(ピックアップ|ぴっくあっぷ|pick ?up|フォーカス|focus)/;
const TRACKV = /(追って|おって|追いかけ|おいかけ|追跡|ついせき|追尾|追従)/;
const QUESTION = /(教えて|おしえて|とは|って何|ってなに|なぜ|どうして|調べ|しらべ|検索|けんさく|ニュース|天気|てんき|資料|まとめ|翻訳|予報|[?？]$)/;
const CAM = /(ライブカメラ|カメラ|映像|中継|webcam|様子)/;
const TRAFFIC_CAM = /(監視カメラ|防犯カメラ|交通カメラ|道路カメラ|道路の(カメラ|映像)|cctv)/;
const CITY3D = /(3d|立体|街並み|まちなみ|建物|ビル群)/;
const NEAR = /(近く|ちかく|この辺|このへん|このあたり|周り|まわり|周辺|付近|ここ)/;
const AIR = /(飛行機|ひこうき|航空機|旅客機|機体|フライト)/;
const SHIP = /(船|ふね|タンカー)/;
const BUS = /バス/;
const RESET = /(地球(の)?全体|全体(を|に|表示)|初期(の)?(視点|位置|画面)|最初の(視点|位置)|元の(視点|位置)|リセット)/;
const UNTRACK = /(追跡|追従|追尾|追いかけ|追う|ついせき).{0,3}(やめ|止め|とめ|解除|終了|おわり|終わり)/;

// 上ほど優先（「衛星写真」は「衛星」より、「雨雲」は「雲」より先）
const LAYERS: [EarthLayerKey, RegExp][] = [
  ["detail", /(衛星写真|詳細な?(写真|画像)|高精細)/],
  ["webcams", /(ライブカメラ|カメラ|webcam)/],
  ["city3d", CITY3D],
  ["quakes", /(地震|震源)/],
  ["sats", /(人工衛星|衛星)/],
  ["aircraft", AIR],
  ["traffic", /(渋滞|交通量|混雑)/],
  ["buses", BUS],
  ["ships", SHIP],
  ["radar", /(雨雲|あまぐも|レーダー|降水|雨)/],
  ["clouds", /(雲|くも|今日の地球)/],
];

const trackTarget = (t: string): TrackTarget | null => (AIR.test(t) ? "aircraft" : SHIP.test(t) ? "ship" : BUS.test(t) ? "bus" : null);

/** 指示を見分ける（E.D.I.T.H. の画面の操作でなければ null） */
export function parseEdithCommand(text: string): EdithCommand | null {
  const t = text.normalize("NFKC").toLowerCase().replace(/[\s　、。,.!！]/g, "");
  if (!t || t.length > 60) return null;
  if (QUESTION.test(t)) return null;
  if (UNTRACK.test(t)) return { kind: "untrack" };
  if (RESET.test(t) && /(戻|もど|見せ|みせ|表示|リセット|にして)/.test(t)) return { kind: "reset" };

  const city = findCity(t);
  const country = city ? null : (findPlaces(t, 1)[0] ?? null);
  const place: CityPlace | null = city ?? (country ? { name: country.name, lat: country.lat, lon: country.lon, height: 1_500_000 } : null);
  const pick = PICK.test(t);
  const follow = TRACKV.test(t);
  const target = trackTarget(t);

  if (place && !HIDE.test(t)) {
    const media = CAM.test(t) || TRAFFIC_CAM.test(t) || CITY3D.test(t);
    if (!(pick || (follow && target) || (SHOW.test(t) && (media || GOTO.test(t))))) return null;
    const city3d = CITY3D.test(t);
    const traffic = TRAFFIC_CAM.test(t);
    const track = (pick || follow) && target ? target : null;
    const cams = CAM.test(t) || traffic || (pick && !track) || (!city3d && !track);
    return { kind: "pickup", place, cams, city3d, traffic, track, country: !city };
  }

  if (!place) {
    if (target && (follow || pick) && !HIDE.test(t)) return { kind: "track", target };
    if ((CAM.test(t) || TRAFFIC_CAM.test(t)) && !HIDE.test(t) && (SHOW.test(t) || NEAR.test(t)) && !CITY3D.test(t)) {
      return { kind: "cams", traffic: TRAFFIC_CAM.test(t) };
    }
    const hide = HIDE.test(t);
    if (!hide && !SHOW.test(t)) return null;
    const hit = LAYERS.find(([, re]) => re.test(t));
    if (hit) return { kind: "layer", layer: hit[0], on: !hide };
  }
  return null;
}

/* ---------- 画面側の受け口（E.D.I.T.H. の画面が開いている間だけ） ---------- */

/** 指示を実行して、返事の一言を返す */
export type EdithCommandHandler = (c: EdithCommand) => string;
let handler: EdithCommandHandler | null = null;

/** E.D.I.T.H. の画面が受け口を用意する（返り値で外す） */
export function setEdithCommandHandler(h: EdithCommandHandler): () => void {
  handler = h;
  return () => {
    if (handler === h) handler = null;
  };
}

/** 画面の操作の指示なら実行して返事を返す（画面が開いていない・操作でなければ null。AI に渡す） */
export function runEdithCommand(text: string): string | null {
  if (!handler) return null;
  const c = parseEdithCommand(text);
  return c ? handler(c) : null;
}
