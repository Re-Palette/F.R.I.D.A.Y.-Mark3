/**
 * 「〇〇の 3D ホログラム」を Gemini に設計させる（箱・球・円柱などの部品の組み合わせ）。
 * 同じものを何度も頼まれたときのために、しばらく覚えておく。
 */
import { getGeminiConfig } from "@/lib/config";
import { sanitizeModel, type HoloModel, MAX_PARTS } from "@/lib/hologram-schema";
import { streamGemini } from "@/llm/gemini";

const SYSTEM = `あなたは 3D ホログラムの設計者。頼まれた対象を、単純な立体の組み合わせで「ひと目でそれと分かる形」に組み立てる。
出力は JSON だけ（前置き・説明・コードブロックの記号は書かない）。

# 形式
{"title":"日本語の短い名前","parts":[{"shape":"…","position":[x,y,z],"rotation":[x,y,z],"size":[…],"color":"…","spin":"y"}]}
- shape と size の意味:
  box [幅, 高さ, 奥行き] ／ sphere [半径] ／ cylinder [上の半径, 下の半径, 高さ]
  cone [半径, 高さ] ／ torus [半径, 太さ]（輪。初期状態では XZ 平面に寝ている） ／ capsule [半径, 胴の長さ]
- cylinder・cone・capsule は初期状態で y 軸方向（縦）に立っている。横にするときは rotation で 90 度回す。
- position は部品の中心。y が上、全体の高さはおよそ 2 前後、中心は原点付近。rotation は度。
- color: 本体 "orange"、光る部分・窓・エンジンの炎など "cyan"、副次的な部品 "amber"、ごく小さな強調 "white"。
- spin: 回り続けるとよい部品だけ（プロペラ・車輪・惑星の公転の輪など）。無ければ書かない。
- 部品は 12〜${MAX_PARTS - 10} 個。左右対称のものは対称に。特徴的な部分（翼・窓・車輪・腕・アンテナなど）を必ず入れる。

# 例（ロケット）
{"title":"ロケット","parts":[{"shape":"cylinder","position":[0,0,0],"rotation":[0,0,0],"size":[0.3,0.3,1.6],"color":"orange"},{"shape":"cone","position":[0,1.1,0],"rotation":[0,0,0],"size":[0.3,0.6],"color":"orange"},{"shape":"sphere","position":[0,0.4,0.28],"rotation":[0,0,0],"size":[0.1],"color":"cyan"},{"shape":"box","position":[0.35,-0.65,0],"rotation":[0,0,-20],"size":[0.35,0.4,0.04],"color":"amber"},{"shape":"box","position":[-0.35,-0.65,0],"rotation":[0,0,20],"size":[0.35,0.4,0.04],"color":"amber"},{"shape":"cone","position":[0,-1.0,0],"rotation":[180,0,0],"size":[0.22,0.4],"color":"cyan"}]}`;

const cache = new Map<string, HoloModel>();

export async function generateHologram(subject: string): Promise<HoloModel> {
  const key = subject.trim().toLowerCase();
  const hit = cache.get(key);
  if (hit) return hit;

  const config = getGeminiConfig();
  let text = "";
  for await (const chunk of streamGemini({
    config: { ...config, thinkingLevel: "low", maxOutputTokens: 8000, temperature: 0.4 },
    systemInstruction: SYSTEM,
    contents: [{ role: "user", parts: [{ text: `対象：${subject}` }] }],
  })) {
    text += chunk.text;
  }
  const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  let raw: unknown = null;
  try {
    raw = JSON.parse(json);
  } catch {
    /* 下で失敗扱い */
  }
  const model = sanitizeModel(raw, subject);
  if (!model) throw new Error("ホログラムの設計図を作れませんでした。もう一度頼んでみてください。");
  if (cache.size >= 30) cache.delete(cache.keys().next().value!);
  cache.set(key, model);
  return model;
}
