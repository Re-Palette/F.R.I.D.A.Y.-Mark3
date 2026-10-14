/**
 * 外部で作った 3D モデルのファイルを K.A.R.E.N. に取り込む（画面側だけで動く。サーバーには送らない）。
 *   対応：GLB / glTF（.bin・画像を一緒に選べば読める）/ OBJ（.mtl も可）/ FBX / STL / PLY / 3MF
 *   細かい形・材質・画像（テクスチャ）は元のとおりに残す（単純な形に置き換えない）。GLB はファイルそのまま、
 *   ほかの形式は同じ中身の GLB に直して、この端末（IndexedDB）にしまう。画面では元の見た目のまま描く（ホログラム風にしない）。
 *   シーンには「asset」として置くので、移動・回転・拡大縮小・色・保存・書き出しがそのまま使える。
 */
import type * as T from "three";
import { parseGltf, texturesOf } from "./gltf-full";
import { getLocal, setLocal } from "./local-store";
import type { HoloAsset } from "./hologram-schema";

type Three = typeof import("three");

/** 取り込める拡張子（ファイル選択の accept にも使う） */
export const IMPORT_EXTS = ["glb", "gltf", "obj", "fbx", "stl", "ply", "3mf"] as const;
export const IMPORT_ACCEPT = [...IMPORT_EXTS.map((e) => `.${e}`), ".bin", ".mtl", ".png", ".jpg", ".jpeg", ".webp"].join(",");
/** 1 つのファイルの上限（大きすぎると、端末が固まる） */
const MAX_BYTES = 150 * 1024 * 1024;
/** 三角形の数の上限（これより細かいと、弱いパソコンで動かなくなる） */
const MAX_TRIANGLES = 3_000_000;
/** この端末にしまうときの名前の頭 */
const STORE_PREFIX = "karen.import.";
export const LOCAL_URL_PREFIX = "local:";

/** 取り込みの制作の名前（CREATIVE TASK に出す。探す・調べる・設計するは要らない） */
export const IMPORT_JOB_TITLE = "3D モデルのファイルを取り込む";

export type ImportExt = (typeof IMPORT_EXTS)[number];

const extOf = (name: string) => name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";

/** 選ばれたファイルの中から、本体（3D モデル）を選ぶ。.bin や画像だけなら null */
export function pickMainFile<F extends { name: string }>(files: F[]): F | null {
  for (const ext of IMPORT_EXTS) {
    const f = files.find((x) => extOf(x.name) === ext);
    if (f) return f;
  }
  return null;
}

/** 表示用の名前（拡張子を外す） */
export function displayName(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim().slice(0, 40) || "取り込んだモデル";
}

export class ImportError extends Error {}

/** ファイルを読み込んで、three.js の形にする */
async function loadObject(THREE: Three, main: File, files: File[], manager: T.LoadingManager): Promise<T.Object3D> {
  const ext = extOf(main.name) as ImportExt;
  switch (ext) {
    case "glb":
    case "gltf":
      return (await parseGltf(ext === "glb" ? await main.arrayBuffer() : await main.text(), manager)).scene;
    case "obj": {
      const [{ OBJLoader }, { MTLLoader }] = await Promise.all([
        import("three/examples/jsm/loaders/OBJLoader.js"),
        import("three/examples/jsm/loaders/MTLLoader.js"),
      ]);
      const loader = new OBJLoader(manager);
      const mtl = files.find((f) => extOf(f.name) === "mtl");
      if (mtl) {
        const materials = new MTLLoader(manager).parse(await mtl.text(), "");
        materials.preload();
        loader.setMaterials(materials);
      }
      return loader.parse(await main.text());
    }
    case "fbx": {
      const { FBXLoader } = await import("three/examples/jsm/loaders/FBXLoader.js");
      return new FBXLoader(manager).parse(await main.arrayBuffer(), "");
    }
    case "stl": {
      const { STLLoader } = await import("three/examples/jsm/loaders/STLLoader.js");
      const geo = new STLLoader(manager).parse(await main.arrayBuffer());
      const hasColor = Boolean(geo.getAttribute("color"));
      const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x9fdcff, vertexColors: hasColor }));
      // CAD・3D プリンター用は Z が上なので、Y を上にする
      mesh.rotation.x = -Math.PI / 2;
      return mesh;
    }
    case "ply": {
      const { PLYLoader } = await import("three/examples/jsm/loaders/PLYLoader.js");
      const geo = new PLYLoader(manager).parse(await main.arrayBuffer());
      if (!geo.index && !geo.getAttribute("normal")) geo.computeVertexNormals();
      return new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x9fdcff, vertexColors: Boolean(geo.getAttribute("color")) }));
    }
    case "3mf": {
      const { ThreeMFLoader } = await import("three/examples/jsm/loaders/3MFLoader.js");
      const group = new ThreeMFLoader(manager).parse(await main.arrayBuffer());
      group.rotation.x = -Math.PI / 2;
      return group;
    }
    default:
      throw new ImportError(`「${main.name}」は読み込めない形式です（GLB・glTF・OBJ・FBX・STL・PLY・3MF に対応）。`);
  }
}

/** 画像（テクスチャ）が読み終わるのを待つ（OBJ・FBX は形を返したあとで画像を読む）。待ちすぎたら、あるものだけで進める */
async function waitTextures(root: T.Object3D, timeoutMs = 20_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  const ready = (t: T.Texture) => {
    const img = t.image as { complete?: boolean; width?: number } | null | undefined;
    if (!img) return false;
    if (typeof HTMLImageElement !== "undefined" && img instanceof HTMLImageElement) return img.complete;
    return true;
  };
  while (Date.now() < until && texturesOf(root).some((t) => !ready(t))) await new Promise((r) => setTimeout(r, 100));
}

/**
 * 標準の材質（GLB で使えるもの）にそろえる。OBJ・FBX の材質（Phong・Lambert）は、色・画像・透明度・光り方を引き継いで置き換える。
 * 形・画像はそのまま
 */
function standardize(THREE: Three, root: T.Object3D): void {
  const convert = (m: T.Material): T.Material => {
    if ((m as T.MeshStandardMaterial).isMeshStandardMaterial || (m as T.MeshBasicMaterial).isMeshBasicMaterial) return m;
    const p = m as T.MeshPhongMaterial;
    if (!p.color) return m;
    const shininess = typeof p.shininess === "number" ? p.shininess : 30;
    const out = new THREE.MeshStandardMaterial({
      name: p.name,
      color: p.color.clone(),
      map: p.map ?? null,
      normalMap: p.normalMap ?? null,
      bumpMap: p.bumpMap ?? null,
      alphaMap: p.alphaMap ?? null,
      aoMap: p.aoMap ?? null,
      emissive: p.emissive?.clone() ?? new THREE.Color(0),
      emissiveMap: p.emissiveMap ?? null,
      transparent: p.transparent,
      opacity: p.opacity,
      side: p.side,
      vertexColors: p.vertexColors,
      flatShading: p.flatShading,
      roughness: 1 - Math.min(1, shininess / 100) * 0.7,
      metalness: 0,
    });
    return out;
  };
  root.traverse((o) => {
    const mesh = o as T.Mesh;
    if (!mesh.isMesh) return;
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(convert) : convert(mesh.material);
  });
}

/** 三角形の数（細かさ）と、形があるか */
function measure(root: T.Object3D): { triangles: number; shapes: number } {
  let triangles = 0;
  let shapes = 0;
  root.traverse((o) => {
    const g = (o as T.Mesh).geometry as T.BufferGeometry | undefined;
    if (!g?.getAttribute?.("position")) return;
    if ((o as T.Mesh).isMesh) triangles += (g.index ? g.index.count : g.getAttribute("position").count) / 3;
    if ((o as T.Mesh).isMesh || (o as T.Points).isPoints || (o as T.Line).isLine) shapes++;
  });
  return { triangles: Math.round(triangles), shapes };
}

/** そのままの中身（形・材質・画像）で GLB にする */
async function toFullGlb(root: T.Object3D): Promise<ArrayBuffer> {
  const { GLTFExporter } = await import("three/examples/jsm/exporters/GLTFExporter.js");
  return (await new GLTFExporter().parseAsync(root, { binary: true, maxTextureSize: 4096 })) as ArrayBuffer;
}

export interface ImportedModel {
  name: string;
  asset: HoloAsset;
  buffer: ArrayBuffer;
  triangles: number;
}

/** 選ばれた（落とされた）ファイルから 3D モデルを取り込む。うまくいかなければ ImportError */
export async function importModelFiles(fileList: FileList | File[]): Promise<ImportedModel> {
  const files = [...fileList];
  const main = pickMainFile(files);
  if (!main) throw new ImportError("3D モデルのファイル（GLB・glTF・OBJ・FBX・STL・PLY・3MF）を選んでください。");
  if (main.size > MAX_BYTES) throw new ImportError(`ファイルが大きすぎます（${Math.round(main.size / 1024 / 1024)}MB）。150MB 以下にしてください。`);
  const THREE = await import("three");
  // glTF・OBJ・FBX が参照する別のファイル（.bin・画像・.mtl）を、一緒に選ばれたファイルから渡す
  const urls = new Map<string, string>();
  for (const f of files) urls.set(f.name.toLowerCase(), URL.createObjectURL(f));
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => {
    if (/^(blob|data):/.test(url)) return url;
    const name = decodeURIComponent(url.split(/[\\/]/).pop() ?? "").toLowerCase();
    return urls.get(name) ?? url;
  });
  try {
    return await importWith(THREE, main, files, manager);
  } finally {
    // 書き出しまで済んだら、渡した一時的な URL を片付ける
    urls.forEach((u) => URL.revokeObjectURL(u));
  }
}

async function importWith(THREE: Three, main: File, files: File[], manager: T.LoadingManager): Promise<ImportedModel> {
  let root: T.Object3D;
  try {
    root = await loadObject(THREE, main, files, manager);
  } catch (err) {
    if (err instanceof ImportError) throw err;
    const ext = extOf(main.name);
    const hint =
      ext === "gltf" ? "（.gltf は、一緒に .bin と画像のファイルも選んでください。GLB にまとめて書き出すと確実です）" : ext === "fbx" ? "（古い FBX は読めないことがあります。GLB で書き出し直すと確実です）" : "";
    throw new ImportError(`「${main.name}」を読み込めませんでした${hint}。`);
  }
  const { triangles, shapes } = measure(root);
  if (!shapes) throw new ImportError("ファイルの中に形（メッシュ）が見つかりませんでした。");
  if (triangles > MAX_TRIANGLES) {
    throw new ImportError(`細かすぎるモデルです（三角形 ${Math.round(triangles / 10_000)} 万個）。300 万個以下に減らしてから取り込んでください（Blender の「デシメート」など）。`);
  }
  // GLB はファイルそのもの（細かさ・材質・画像・圧縮も元のまま）。ほかの形式は、画像を読み終えてから同じ中身の GLB に直す
  let glb: ArrayBuffer;
  if (extOf(main.name) === "glb") glb = await main.arrayBuffer();
  else {
    await waitTextures(root);
    standardize(THREE, root);
    try {
      glb = await toFullGlb(root);
    } catch (err) {
      console.warn("[karen] import export failed:", err);
      throw new ImportError(`「${main.name}」を表示用に変換できませんでした。GLB で書き出し直すと確実です。`);
    }
  }
  const id = `imp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  // この端末にしまう（保存したプロジェクトを開き直したときに読むため）。しまえなくても、いまの画面には出す
  await setLocal(`${STORE_PREFIX}${id}`, glb);
  const name = displayName(main.name);
  return {
    name,
    triangles,
    buffer: glb,
    asset: { id, title: name, url: `${LOCAL_URL_PREFIX}${id}`, creator: "", license: "取り込んだファイル", page: "" },
  };
}

/** しまっておいた取り込みモデルを読む（無ければ null） */
export async function readImported(url: string): Promise<ArrayBuffer | null> {
  if (!url.startsWith(LOCAL_URL_PREFIX)) return null;
  const buf = await getLocal<ArrayBuffer>(`${STORE_PREFIX}${url.slice(LOCAL_URL_PREFIX.length)}`);
  return buf instanceof ArrayBuffer ? buf : null;
}

/* ---------- ファイル選択を開く（ボタン・声の「取り込んで」から） ---------- */

let picker: (() => void) | null = null;
/** 画面のファイル選択を登録する（K.A.R.E.N. の画面が出ている間） */
export function registerImportPicker(open: (() => void) | null): void {
  picker = open;
}
/** ファイル選択を開く。開けなければ false */
export function openImportPicker(): boolean {
  if (!picker) return false;
  picker();
  return true;
}
