/**
 * ホログラムの見た目（three.js）。Hologram.tsx から、読み込んだ three を渡して使う。
 *   - 面：縁ほど明るく光り（フレネル）、横の走査線と上下に流れる光の帯、かすかなちらつき
 *   - 線：角ばった所の輪郭だけ（なめらかな面は面の光り方で形が分かる）
 *   - 点：表面にまいた光の粒
 */
import type * as T from "three";
import type { HoloModel } from "@/lib/hologram-schema";

type Three = typeof import("three");

export const COLORS = { orange: 0xff8a1f, cyan: 0x2ee6ff, amber: 0xffb45a, white: 0xfff1dd } as const;

const VERT = /* glsl */ `
varying vec3 vNormal;
varying vec3 vView;
varying float vHeight;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vHeight = world.y;
  vec4 mv = viewMatrix * world;
  vView = -mv.xyz;
  vNormal = normalMatrix * normal;
  gl_Position = projectionMatrix * mv;
}`;

const FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uTime;
uniform float uOpacity;
varying vec3 vNormal;
varying vec3 vView;
varying float vHeight;
void main() {
  float facing = abs(dot(normalize(vNormal), normalize(vView)));
  float rim = pow(1.0 - facing, 2.4);
  float lines = 0.7 + 0.3 * sin(vHeight * 90.0 - uTime * 3.0);
  float band = smoothstep(0.08, 0.0, abs(fract(vHeight * 0.35 - uTime * 0.22) - 0.5));
  float flicker = 0.93 + 0.07 * sin(uTime * 41.0) * sin(uTime * 17.0);
  float a = (0.025 + rim * 0.5 + band * 0.18) * lines * flicker * uOpacity;
  gl_FragColor = vec4(uColor * (0.45 + rim * 0.9 + band * 0.6), a);
}`;

/** ホログラムの面の材質。uTime は全部の材質で共有して、毎フレーム 1 回だけ進める */
export function holoMaterial(THREE: Three, color: number, time: { value: number }, opacity = 1) {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(color) }, uTime: time, uOpacity: { value: opacity } },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
}

/** 光の粒用の丸い点の画像 */
export function dotTexture(THREE: Three) {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.35, "rgba(255,255,255,0.6)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

type Geo = T.BufferGeometry<T.NormalBufferAttributes>;

function partGeometry(THREE: Three, p: HoloModel["parts"][number]): Geo {
  const [a, b = a, c = b] = p.size;
  const pts = p.points ?? [];
  switch (p.shape) {
    case "box":
      return new THREE.BoxGeometry(a, b, c);
    case "sphere":
      return new THREE.SphereGeometry(a, 28, 18);
    case "ellipsoid": {
      const g = new THREE.SphereGeometry(1, 28, 18);
      g.scale(a, b, c);
      return g;
    }
    case "cylinder":
      return new THREE.CylinderGeometry(a, b, p.size[2] ?? a * 2, 28);
    case "cone":
      return new THREE.ConeGeometry(a, b, 28);
    case "torus": {
      const g = new THREE.TorusGeometry(a, Math.min(b, a), 12, 40);
      g.rotateX(Math.PI / 2); // 寝かせた輪を基本にする
      return g;
    }
    case "capsule":
      return new THREE.CapsuleGeometry(a, b, 6, 20);
    case "lathe":
      return new THREE.LatheGeometry(
        pts.map(([r, y]) => new THREE.Vector2(Math.max(0, r), y)),
        36,
      );
    case "tube": {
      const curve = new THREE.CatmullRomCurve3(
        pts.map(([x, y, z]) => new THREE.Vector3(x, y, z)),
        p.closed === true,
      );
      return new THREE.TubeGeometry(curve, Math.min(200, Math.max(16, pts.length * 12)), a, 8, p.closed === true);
    }
    case "extrude": {
      const shape = new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y)));
      const g = new THREE.ExtrudeGeometry(shape, { depth: a, bevelEnabled: false });
      g.translate(0, 0, -a / 2);
      return g;
    }
  }
}

/** 設計図（部品のリスト）から、ホログラムの立体を組み立てる */
export async function buildModel(THREE: Three, model: HoloModel, time: { value: number }) {
  const { MeshSurfaceSampler } = await import("three/examples/jsm/math/MeshSurfaceSampler.js");
  const group = new THREE.Group();
  const spinners: { obj: T.Object3D; axis: "x" | "y" | "z" }[] = [];
  const faceMats = new Map<string, T.ShaderMaterial>();
  const lineMats = new Map<string, T.LineBasicMaterial>();
  const deg = Math.PI / 180;
  const meshes: { mesh: T.Mesh; color: number; area: number }[] = [];

  for (const p of model.parts) {
    let geo: Geo;
    try {
      geo = partGeometry(THREE, p);
    } catch {
      continue; // 形にならない部品は飛ばす
    }
    const color = COLORS[p.color];
    if (!faceMats.has(p.color)) {
      faceMats.set(p.color, holoMaterial(THREE, color, time, 0.75));
      lineMats.set(
        p.color,
        new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false }),
      );
    }
    const holder = new THREE.Group();
    holder.position.set(...p.position);
    holder.rotation.set(p.rotation[0] * deg, p.rotation[1] * deg, p.rotation[2] * deg);
    if (p.scale) holder.scale.set(...p.scale);
    const mesh = new THREE.Mesh(geo, faceMats.get(p.color));
    holder.add(mesh);
    holder.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo, 28), lineMats.get(p.color)));
    if (p.spin) spinners.push({ obj: holder, axis: p.spin });
    group.add(holder);
    geo.computeBoundingBox();
    const s = geo.boundingBox!.getSize(new THREE.Vector3());
    meshes.push({ mesh, color, area: Math.max(1e-4, s.x * s.y + s.y * s.z + s.x * s.z) });
  }

  // 表面に光の粒をまく（大きい部品ほど多く）
  group.updateMatrixWorld(true);
  const total = meshes.reduce((n, m) => n + m.area, 0) || 1;
  const COUNT = 2600;
  const pos: number[] = [];
  const col: number[] = [];
  const v = new THREE.Vector3();
  const tint = new THREE.Color();
  for (const m of meshes) {
    const n = Math.round((m.area / total) * COUNT);
    if (!n) continue;
    try {
      const sampler = new MeshSurfaceSampler(m.mesh).build();
      tint.set(m.color);
      for (let i = 0; i < n; i++) {
        sampler.sample(v);
        v.applyMatrix4(m.mesh.matrixWorld);
        pos.push(v.x, v.y, v.z);
        const k = 0.35 + Math.random() ** 2 * 0.9;
        col.push(tint.r * k, tint.g * k, tint.b * k);
      }
    } catch {
      /* 面の無い部品など */
    }
  }
  const dotTex = dotTexture(THREE);
  if (pos.length) {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
    group.add(
      new THREE.Points(
        g,
        new THREE.PointsMaterial({ size: 0.035, map: dotTex, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
      ),
    );
  }

  // 大きさと位置をそろえる（地球儀と同じくらいの大きさで、中心に）
  const box = new THREE.Box3().setFromObject(group);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const fit = 2.9 / Math.max(size.x, size.y, size.z, 0.001);
  const pivot = new THREE.Group();
  group.position.set(-center.x, -center.y, -center.z);
  pivot.add(group);
  pivot.scale.setScalar(fit);
  pivot.userData.fit = fit;
  return { pivot, spinners, dispose: () => dotTex.dispose() };
}
