/**
 * 「〇〇の 3D ホログラム」の設計図。Gemini が箱・球・円柱などの部品の組み合わせで作り、画面が three.js で描く。
 * サーバー（作る側）と画面（描く側）の両方で使うので、ここには型と検証だけを置く。
 */

export const HOLO_SHAPES = ["box", "sphere", "cylinder", "cone", "torus", "capsule"] as const;
export const HOLO_COLORS = ["orange", "cyan", "amber", "white"] as const;
export type HoloShape = (typeof HOLO_SHAPES)[number];
export type HoloColor = (typeof HOLO_COLORS)[number];

export interface HoloPart {
  shape: HoloShape;
  /** 中心の位置 [x, y, z]（y が上） */
  position: [number, number, number];
  /** 回転 [x, y, z]（度） */
  rotation: [number, number, number];
  /**
   * 大きさ。形ごとに意味が違う
   *   box [幅, 高さ, 奥行き] ／ sphere [半径] ／ cylinder [上の半径, 下の半径, 高さ]
   *   cone [半径, 高さ] ／ torus [半径, 太さ] ／ capsule [半径, 長さ]
   */
  size: number[];
  color: HoloColor;
  /** この部品だけ回し続ける軸（プロペラ・惑星の輪など） */
  spin?: "x" | "y" | "z";
}

export interface HoloModel {
  title: string;
  parts: HoloPart[];
}

export const MAX_PARTS = 80;

const num = (v: unknown, fallback: number, min: number, max: number) => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const vec3 = (v: unknown, min: number, max: number): [number, number, number] => {
  const a = Array.isArray(v) ? v : [];
  return [num(a[0], 0, min, max), num(a[1], 0, min, max), num(a[2], 0, min, max)];
};

/** Gemini の出力を、描いても安全な形に整える（読めない部品は捨てる）。部品が 1 つも無ければ null */
export function sanitizeModel(raw: unknown, fallbackTitle: string): HoloModel | null {
  const obj = (raw && typeof raw === "object" ? raw : {}) as { title?: unknown; parts?: unknown };
  const parts: HoloPart[] = [];
  for (const p of Array.isArray(obj.parts) ? obj.parts : []) {
    if (parts.length >= MAX_PARTS) break;
    const q = (p ?? {}) as Record<string, unknown>;
    const shape = String(q.shape ?? "").toLowerCase() as HoloShape;
    if (!HOLO_SHAPES.includes(shape)) continue;
    const size = (Array.isArray(q.size) ? q.size : [q.size]).slice(0, 3).map((s) => num(s, 0.3, 0.005, 50));
    if (!size.length) continue;
    const color = String(q.color ?? "").toLowerCase() as HoloColor;
    const spin = String(q.spin ?? "").toLowerCase();
    parts.push({
      shape,
      position: vec3(q.position, -100, 100),
      rotation: vec3(q.rotation, -720, 720),
      size,
      color: HOLO_COLORS.includes(color) ? color : "orange",
      ...(spin === "x" || spin === "y" || spin === "z" ? { spin } : {}),
    });
  }
  if (!parts.length) return null;
  const title = typeof obj.title === "string" && obj.title.trim() ? obj.title.trim().slice(0, 40) : fallbackTitle;
  return { title, parts };
}
