/**
 * glTF / GLB をそのまま読む部品（圧縮された形 Draco・meshopt にも対応）。画面側だけで使う。
 * K.A.R.E.N. に取り込んだファイルを、材質・画像・細かい形まで元のとおりに出すときに使う。
 */
import type * as T from "three";
import type { GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";

type Three = typeof import("three");

/** Draco の部品は public/draco/（npm run build の前にコピーされる） */
const DRACO_PATH = "/draco/";

export async function makeGltfLoader(manager?: T.LoadingManager) {
  const [{ GLTFLoader }, { DRACOLoader }, { MeshoptDecoder }] = await Promise.all([
    import("three/examples/jsm/loaders/GLTFLoader.js"),
    import("three/examples/jsm/loaders/DRACOLoader.js"),
    import("three/examples/jsm/libs/meshopt_decoder.module.js"),
  ]);
  const draco = new DRACOLoader().setDecoderPath(DRACO_PATH);
  const loader = new GLTFLoader(manager).setDRACOLoader(draco).setMeshoptDecoder(MeshoptDecoder);
  return { loader, dispose: () => draco.dispose() };
}

export async function parseGltf(data: ArrayBuffer | string, manager?: T.LoadingManager): Promise<GLTF> {
  const { loader, dispose } = await makeGltfLoader(manager);
  try {
    return await loader.parseAsync(data, "");
  } finally {
    dispose();
  }
}

/** 材質に付いた画像（テクスチャ）を全部集める */
export function texturesOf(root: T.Object3D): T.Texture[] {
  const out = new Set<T.Texture>();
  root.traverse((o) => {
    const mats = (o as T.Mesh).material;
    for (const m of Array.isArray(mats) ? mats : mats ? [mats] : []) {
      for (const v of Object.values(m)) if (v && typeof v === "object" && (v as T.Texture).isTexture) out.add(v as T.Texture);
    }
  });
  return [...out];
}

/** 取り込んだモデルを、元の材質・画像のまま表示用にする（大きさは直径 2.9、中心をそろえる。ホログラムと同じ扱い） */
export async function buildRealAsset(THREE: Three, buffer: ArrayBuffer): Promise<{ pivot: T.Group; dispose: () => void }> {
  const gltf = await parseGltf(buffer);
  const group = gltf.scene;
  let meshes = 0;
  group.traverse((o) => {
    const m = o as T.Mesh;
    if (!m.isMesh && !(o as T.Points).isPoints && !(o as T.Line).isLine) return;
    meshes++;
    // 色を塗り替えたあと元に戻せるよう、元の材質だと印を付ける
    for (const mat of Array.isArray(m.material) ? m.material : [m.material]) mat.userData.real = true;
  });
  if (!meshes) throw new Error("no mesh");
  group.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(group);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const fit = 2.9 / Math.max(size.x, size.y, size.z, 0.001);
  const pivot = new THREE.Group();
  group.position.sub(center);
  pivot.add(group);
  pivot.scale.setScalar(fit);
  pivot.userData.fit = fit;
  const textures = texturesOf(group);
  return { pivot, dispose: () => textures.forEach((t) => t.dispose()) };
}
