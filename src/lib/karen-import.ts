/**
 * 外部で作った 3D モデルのファイルを K.A.R.E.N. に取り込む（画面側だけで動く。サーバーには送らない）。
 *   対応：GLB / glTF（.bin・画像を一緒に選べば読める）/ OBJ（.mtl も可）/ FBX / STL / PLY / 3MF
 *   読み込んだら、形と色だけを残した GLB に直して（画像・圧縮は外す）、この端末（IndexedDB）にしまう。
 *   シーンには既存の 3D モデルと同じ「asset」として置くので、移動・回転・拡大縮小・色・保存・書き出しがそのまま使える。
 */
import type * as T from "three";
import { getLocal, setLocal } from "./local-store";
import type { HoloAsset } from "./hologram-schema";

type Three = typeof import("three");

/** 取り込める拡張子（ファイル選択の accept にも使う） */
export const IMPORT_EXTS = ["glb", "gltf", "obj", "fbx", "stl", "ply", "3mf"] as const;
export const IMPORT_ACCEPT = [...IMPORT_EXTS.map((e) => `.${e}`), ".bin", ".mtl", ".png", ".jpg", ".jpeg", ".webp"].join(",");
/** 1 つのファイルの上限（大きすぎると、端末が固まる） */
const MAX_BYTES = 150 * 1024 * 1024;
/** 三角形の数の上限（これより細かいと、弱いパソコンで動かなくなる） */
const MAX_TRIANGLES = 1_500_000;
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
async function loadObject(THREE: Three, main: File, files: File[]): Promise<T.Object3D> {
  const ext = extOf(main.name) as ImportExt;
  // glTF・OBJ が参照する別のファイル（.bin・画像・.mtl）を、一緒に選ばれたファイルから渡す
  const urls = new Map<string, string>();
  for (const f of files) urls.set(f.name.toLowerCase(), URL.createObjectURL(f));
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => {
    if (/^(blob|data):/.test(url)) return url;
    const name = decodeURIComponent(url.split(/[\\/]/).pop() ?? "").toLowerCase();
    return urls.get(name) ?? url;
  });
  try {
    switch (ext) {
      case "glb":
      case "gltf": {
        const [{ GLTFLoader }, { DRACOLoader }, { MeshoptDecoder }] = await Promise.all([
          import("three/examples/jsm/loaders/GLTFLoader.js"),
          import("three/examples/jsm/loaders/DRACOLoader.js"),
          import("three/examples/jsm/libs/meshopt_decoder.module.js"),
        ]);
        const draco = new DRACOLoader().setDecoderPath("/draco/");
        const loader = new GLTFLoader(manager).setDRACOLoader(draco).setMeshoptDecoder(MeshoptDecoder);
        try {
          const data = ext === "glb" ? await main.arrayBuffer() : await main.text();
          const gltf = await loader.parseAsync(data, "");
          return gltf.scene;
        } finally {
          draco.dispose();
        }
      }
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
  } finally {
    // 読み込みが済んだら、渡した一時的な URL を片付ける（画像はもう使わない）
    setTimeout(() => urls.forEach((u) => URL.revokeObjectURL(u)), 1000);
  }
}

/** 色の代表（材質の色。画像だけの材質は白） */
function baseColor(THREE: Three, mat: T.Material | undefined): T.Color {
  const c = (mat as T.MeshStandardMaterial | undefined)?.color;
  return c ? c.clone() : new THREE.Color(0xffffff);
}

/**
 * 形と色だけを残した、軽い GLB にする（画像・アニメーション・骨は外す。ホログラムの見た目には使わないため）。
 * 三角形の数も数えて、多すぎるときは断る
 */
async function toLightGlb(THREE: Three, root: T.Object3D): Promise<{ glb: ArrayBuffer; triangles: number }> {
  root.updateMatrixWorld(true);
  const out = new THREE.Scene();
  let triangles = 0;
  root.traverse((o) => {
    const src = o as T.Mesh;
    if (!src.isMesh || !src.geometry?.getAttribute("position")) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", src.geometry.getAttribute("position").clone());
    const normal = src.geometry.getAttribute("normal");
    if (normal) geo.setAttribute("normal", normal.clone());
    if (src.geometry.index) geo.setIndex(src.geometry.index.clone());
    geo.applyMatrix4(src.matrixWorld);
    triangles += (geo.index ? geo.index.count : geo.getAttribute("position").count) / 3;
    const mats = Array.isArray(src.material) ? src.material : [src.material];
    // 材質が複数あるときは、いちばん大きく使われている色にする（形を分けるほどの意味は無い）
    const color = baseColor(THREE, mats[0]);
    out.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color })));
  });
  if (!out.children.length) throw new ImportError("ファイルの中に形（メッシュ）が見つかりませんでした。点群・線だけのファイルは表示できません。");
  if (triangles > MAX_TRIANGLES) {
    throw new ImportError(`細かすぎるモデルです（三角形 ${Math.round(triangles / 10_000)} 万個）。150 万個以下に減らしてから取り込んでください（Blender の「デシメート」など）。`);
  }
  const { GLTFExporter } = await import("three/examples/jsm/exporters/GLTFExporter.js");
  const glb = (await new GLTFExporter().parseAsync(out, { binary: true })) as ArrayBuffer;
  out.traverse((o) => {
    const m = o as T.Mesh;
    if (!m.isMesh) return;
    m.geometry.dispose();
    (m.material as T.Material).dispose();
  });
  return { glb, triangles: Math.round(triangles) };
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
  let root: T.Object3D;
  try {
    root = await loadObject(THREE, main, files);
  } catch (err) {
    if (err instanceof ImportError) throw err;
    const ext = extOf(main.name);
    const hint =
      ext === "gltf" ? "（.gltf は、一緒に .bin と画像のファイルも選んでください。GLB にまとめて書き出すと確実です）" : ext === "fbx" ? "（古い FBX は読めないことがあります。GLB で書き出し直すと確実です）" : "";
    throw new ImportError(`「${main.name}」を読み込めませんでした${hint}。`);
  }
  const { glb, triangles } = await toLightGlb(THREE, root);
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
