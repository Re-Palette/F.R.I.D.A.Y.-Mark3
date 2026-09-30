/**
 * 「〇〇の 3D ホログラム」を Gemini に設計させる（箱・球・円柱などの部品の組み合わせ）。
 * 同じものを何度も頼まれたときのために、しばらく覚えておく。
 */
import { getGeminiConfig } from "@/lib/config";
import { sanitizeModel, type HoloModel } from "@/lib/hologram-schema";
import { streamGemini } from "@/llm/gemini";

const SYSTEM = `あなたは映画の 3D ホログラムを作るモデラー。頼まれた対象を、下の立体の組み合わせで「シルエットを見ただけでそれと分かり、細部まで作り込まれた形」に組み立てる。
出力は JSON だけ（前置き・説明・コードブロックの記号は書かない）。

# 形式
{"title":"日本語の短い名前","parts":[{"shape":"…","position":[x,y,z],"rotation":[x,y,z],"size":[…],"points":[…],"scale":[x,y,z],"color":"…","spin":"y"}]}

# 立体（size・points の意味）
- box [幅, 高さ, 奥行き]
- sphere [半径] ／ ellipsoid [x 半径, y 半径, z 半径]（胴体・頭・卵形・機体など、丸みのある塊に最適）
- cylinder [上の半径, 下の半径, 高さ]（上下の半径を変えると円錐台）／ cone [半径, 高さ] ／ capsule [半径, 胴の長さ]
  ※ cylinder・cone・capsule は初期状態で y 軸方向（縦）。横にするときは rotation で 90 度回す。
- torus [半径, 太さ]（輪。初期状態で XZ 平面に寝ている。タイヤ・リング・縁取り）
- lathe: points=[[半径, 高さ], …] の縦断面を y 軸まわりに回した形。瓶・ロケットの胴・花瓶・電球・チェスの駒・グラス・鐘・ドーム・機首など、回転対称のなめらかな形はこれで 1 つにまとめる（6〜20 点、下から上へ）。size は不要。
- tube: points=[[x,y,z], …] を通るなめらかな管、size=[太さ]。ケーブル・らせん（DNA）・取っ手・しっぽ・触手・枝・フレーム・パイプ・眼鏡のつる。"closed":true で輪になる。
- extrude: points=[[x,y], …] の平らな輪郭（XY 平面、反時計回り）を size=[厚み] だけ z 方向に押し出した板。翼・尾翼・ひれ・葉・刃・耳・看板・星形など、平らで輪郭が特徴的な部分。
- どの立体にも scale:[x,y,z] で軸ごとの伸び縮みを付けられる。

# 座標と色
- y が上。全体の高さ（または長さ）は 2〜3 程度、中心は原点付近。position は部品の中心（lathe・tube・extrude は points の原点の位置）。rotation は度。
- color: 本体 "orange"、光る部分・窓・画面・エンジンの炎・目など "cyan"、副次的な部品 "amber"、ごく小さな強調 "white"。
- spin: 回り続けるとよい部品だけ（プロペラ・車輪・タービン・惑星の公転の輪など）。

# 作り方
1. まず全体の比率とシルエットを決め、大きな塊（胴体・土台）を lathe / ellipsoid / box で作る。
2. 次に特徴的な部分（翼・車輪・腕・脚・窓・アンテナ・ライト・扉・パネルの継ぎ目など）を必ず入れる。
3. 最後に細部（ボルト・縁取り・模様・小さな部品）で作り込む。左右対称のものは正確に対称に。
- 部品は 30〜120 個。少なすぎる大まかな形にしない。部品どうしが浮かないよう、つながる所はきちんと接するか少し重ねる。

# 例（ロケット、一部）
{"title":"ロケット","parts":[{"shape":"lathe","position":[0,-1,0],"rotation":[0,0,0],"points":[[0,0],[0.28,0.05],[0.32,0.3],[0.32,1.5],[0.3,1.75],[0.22,2.1],[0.1,2.35],[0,2.45]],"color":"orange"},{"shape":"extrude","position":[0.3,-0.95,0],"rotation":[0,0,0],"points":[[0,0],[0.45,-0.15],[0.45,0.1],[0,0.6]],"size":[0.03],"color":"amber"},{"shape":"torus","position":[0,0.2,0],"rotation":[0,0,0],"size":[0.325,0.015],"color":"white"},{"shape":"cylinder","position":[0,0.9,0.3],"rotation":[90,0,0],"size":[0.09,0.09,0.04],"color":"cyan"},{"shape":"tube","position":[0,0,0],"rotation":[0,0,0],"points":[[0.33,-0.6,0],[0.33,0.9,0]],"size":[0.012],"color":"amber"}]}`;

const cache = new Map<string, HoloModel>();

async function design(subject: string, thinkingLevel: "low" | "medium"): Promise<HoloModel | null> {
  const config = getGeminiConfig();
  let text = "";
  for await (const chunk of streamGemini({
    config: { ...config, thinkingLevel, maxOutputTokens: 20000, temperature: 0.5 },
    systemInstruction: SYSTEM,
    contents: [{ role: "user", parts: [{ text: `対象：${subject}` }] }],
  })) {
    text += chunk.text;
  }
  const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  try {
    return sanitizeModel(JSON.parse(json), subject);
  } catch {
    return null;
  }
}

export async function generateHologram(subject: string): Promise<HoloModel> {
  const key = subject.trim().toLowerCase();
  const hit = cache.get(key);
  if (hit) return hit;

  // じっくり考えて細かく作る。途中で切れて読めなかったときは、考えるのを軽くしてもう一度
  let model = await design(subject, "medium");
  if (!model) model = await design(subject, "low");
  if (!model) throw new Error("ホログラムの設計図を作れませんでした。もう一度頼んでみてください。");
  if (cache.size >= 30) cache.delete(cache.keys().next().value!);
  cache.set(key, model);
  return model;
}
