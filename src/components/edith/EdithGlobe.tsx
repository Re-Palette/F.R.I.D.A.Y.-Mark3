"use client";

/**
 * E.D.I.T.H. の中央：立体ホログラムの世界地図（three.js）。
 *   - 陸地（Natural Earth の陸地データ）を紫に光る粒と輪郭で描き、緯度・経度の網・軌道リング・粒子を重ねる
 *   - 情報の地点（ニュースなどの代表地点）を光る点で示し、東京から地点へ光の線を流す
 *   - ドラッグで回す／ホイールで寄る・引く（範囲は制限）／クリックで地点を選ぶ／ダブルクリックでその場所に寄る
 *   - 自動回転の切り替え・初期の視点に戻す（親から）。「視差効果を減らす」設定なら動きを止める
 *   - WebGL が使えなければ、平面の地図（SVG）で地点を示す
 */
import { memo, useEffect, useRef, useState } from "react";
import type * as T from "three";
import { landDots, landRings, toLatLon, toXYZ, type LonLat } from "@/lib/edith-globe-data";

export interface GlobePoint {
  id: string;
  lat: number;
  lon: number;
  /** 地点の名前（国・都市） */
  label: string;
  /** 強調する（選んだ・AI の答えに出てきた） */
  hot?: boolean;
}

interface Props {
  points: GlobePoint[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  autoRotate: boolean;
  /** 変わるたびに初期の視点へ戻す */
  resetKey: number;
  /** 視点の中心の緯度・経度（座標の小窓に出す） */
  onView?: (v: { lat: number; lon: number }) => void;
}

const PURPLE = 0x8b35ff;
const GLOW = 0xb56cff;
const PALE = 0xd7b4ff;
/** 視点の距離（初期・最小・最大） */
const DIST = { start: 4.1, min: 1.8, max: 6 };
/** 東京（光の線の起点。F.R.I.D.A.Y. のいる場所の代表地点） */
const HOME: LonLat = [139.69, 35.69];

let landCache: { rings: LonLat[][]; dots: LonLat[] } | null = null;
async function loadLand() {
  if (landCache) return landCache;
  const topo = (await import("world-atlas/land-110m.json")).default;
  const rings = landRings(topo);
  landCache = { rings, dots: landDots(rings) };
  return landCache;
}

function webglOk(): boolean {
  try {
    const c = document.createElement("canvas");
    return Boolean(c.getContext("webgl2") || c.getContext("webgl"));
  } catch {
    return false;
  }
}

/** 光る点の絵（中心が明るく、外へぼける） */
function dotTexture(THREE: typeof T): T.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.25, "rgba(215,180,255,0.9)");
  grad.addColorStop(0.6, "rgba(139,53,255,0.25)");
  grad.addColorStop(1, "rgba(139,53,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export const EdithGlobe = memo(function EdithGlobe({ points, selectedId, onSelect, autoRotate, resetKey, onView }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const [fallback, setFallback] = useState(false);
  const api = useRef<{
    setPoints: (p: GlobePoint[], sel: string | null) => void;
    setAuto: (on: boolean) => void;
    reset: () => void;
  } | null>(null);
  const latest = useRef({ points, selectedId, onSelect, onView, autoRotate });
  latest.current = { points, selectedId, onSelect, onView, autoRotate };

  useEffect(() => {
    if (!webglOk()) {
      setFallback(true);
      return;
    }
    const el = host.current;
    if (!el) return;
    let disposed = false;
    let cleanup = () => {};
    void (async () => {
      const [THREE, { OrbitControls }, land] = await Promise.all([
        import("three"),
        import("three/examples/jsm/controls/OrbitControls.js"),
        loadLand(),
      ]);
      if (disposed) return;
      const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
      renderer.setPixelRatio(Math.min(1.5, window.devicePixelRatio || 1));
      renderer.setClearColor(0x000000, 0);
      el.appendChild(renderer.domElement);
      renderer.domElement.className = "eglobe__canvas";
      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(38, 1, 0.05, 50);
      camera.position.set(0, 0.45, DIST.start);
      const controls = new OrbitControls(camera, renderer.domElement);
      controls.enablePan = false;
      controls.enableDamping = true;
      controls.dampingFactor = 0.08;
      controls.rotateSpeed = 0.55;
      controls.zoomSpeed = 0.7;
      controls.minDistance = DIST.min;
      controls.maxDistance = DIST.max;
      controls.minPolarAngle = 0.25;
      controls.maxPolarAngle = Math.PI - 0.25;
      controls.autoRotate = !reduce && latest.current.autoRotate;
      controls.autoRotateSpeed = 0.35;

      const globe = new THREE.Group();
      scene.add(globe);
      const disposables: { dispose: () => void }[] = [];
      const keep = <X extends { dispose: () => void }>(x: X) => (disposables.push(x), x);

      // 中の暗い球（裏側の点を隠し、ホログラムの奥行きを出す）
      globe.add(
        new THREE.Mesh(
          keep(new THREE.SphereGeometry(0.985, 64, 48)),
          keep(new THREE.MeshBasicMaterial({ color: 0x0b0620, transparent: true, opacity: 0.82 })),
        ),
      );
      // ふちの光（フレネル風）
      const rim = new THREE.Mesh(
        keep(new THREE.SphereGeometry(1.06, 64, 48)),
        keep(
          new THREE.ShaderMaterial({
            transparent: true,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
            side: THREE.BackSide,
            uniforms: { color: { value: new THREE.Color(PURPLE) } },
            vertexShader: "varying vec3 vN; void main(){ vN = normalize(normalMatrix * normal); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }",
            fragmentShader: "uniform vec3 color; varying vec3 vN; void main(){ float a = pow(0.72 - dot(vN, vec3(0.0,0.0,1.0)), 3.0); gl_FragColor = vec4(color, clamp(a,0.0,1.0)*0.9); }",
          }),
        ),
      );
      scene.add(rim);

      // 緯度・経度の網（15 度ごと）
      const grid: number[] = [];
      for (let lat = -75; lat <= 75; lat += 15) {
        for (let lon = -180; lon < 180; lon += 3) grid.push(...toXYZ(lat, lon, 1.001), ...toXYZ(lat, lon + 3, 1.001));
      }
      for (let lon = -180; lon < 180; lon += 15) {
        for (let lat = -87; lat < 87; lat += 3) grid.push(...toXYZ(lat, lon, 1.001), ...toXYZ(lat + 3, lon, 1.001));
      }
      const gridGeo = keep(new THREE.BufferGeometry());
      gridGeo.setAttribute("position", new THREE.Float32BufferAttribute(grid, 3));
      globe.add(new THREE.LineSegments(gridGeo, keep(new THREE.LineBasicMaterial({ color: PURPLE, transparent: true, opacity: 0.16 }))));

      // 陸地の輪郭
      const coast: number[] = [];
      for (const ring of land.rings) {
        for (let i = 0; i < ring.length - 1; i++) coast.push(...toXYZ(ring[i][1], ring[i][0], 1.003), ...toXYZ(ring[i + 1][1], ring[i + 1][0], 1.003));
      }
      const coastGeo = keep(new THREE.BufferGeometry());
      coastGeo.setAttribute("position", new THREE.Float32BufferAttribute(coast, 3));
      globe.add(new THREE.LineSegments(coastGeo, keep(new THREE.LineBasicMaterial({ color: GLOW, transparent: true, opacity: 0.75 }))));

      // 陸地の粒
      const tex = keep(dotTexture(THREE));
      const dots = new Float32Array(land.dots.length * 3);
      land.dots.forEach(([lon, lat], i) => dots.set(toXYZ(lat, lon, 1.004), i * 3));
      const dotGeo = keep(new THREE.BufferGeometry());
      dotGeo.setAttribute("position", new THREE.BufferAttribute(dots, 3));
      const dotMat = keep(
        new THREE.PointsMaterial({ color: 0xb98aff, size: 0.03, map: tex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 1 }),
      );
      globe.add(new THREE.Points(dotGeo, dotMat));

      // 軌道リング（地球を包む細い輪）
      const rings: T.Line[] = [];
      for (const [r, tilt, op] of [
        [1.32, 0.28, 0.55],
        [1.48, -0.18, 0.35],
        [1.22, 1.2, 0.25],
      ] as const) {
        const pts: number[] = [];
        for (let a = 0; a <= 360; a += 2) pts.push(r * Math.cos((a * Math.PI) / 180), 0, r * Math.sin((a * Math.PI) / 180));
        const g = keep(new THREE.BufferGeometry());
        g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
        const line = new THREE.Line(g, keep(new THREE.LineBasicMaterial({ color: GLOW, transparent: true, opacity: op })));
        line.rotation.x = tilt;
        scene.add(line);
        rings.push(line);
      }

      // まわりの粒子（控えめ）
      const dust = new Float32Array(360 * 3);
      for (let i = 0; i < 360; i++) {
        const r = 1.25 + Math.random() * 1.1;
        const t = Math.random() * Math.PI * 2;
        const p = Math.acos(2 * Math.random() - 1);
        dust.set([r * Math.sin(p) * Math.cos(t), r * Math.cos(p) * 0.6, r * Math.sin(p) * Math.sin(t)], i * 3);
      }
      const dustGeo = keep(new THREE.BufferGeometry());
      dustGeo.setAttribute("position", new THREE.BufferAttribute(dust, 3));
      const dustPts = new THREE.Points(dustGeo, keep(new THREE.PointsMaterial({ color: PALE, size: 0.012, map: tex, transparent: true, opacity: 0.45, depthWrite: false, blending: THREE.AdditiveBlending })));
      scene.add(dustPts);

      // 情報の地点・光の線（親から差し替える）
      const pointLayer = new THREE.Group();
      globe.add(pointLayer);
      let pickables: { mesh: T.Object3D; id: string }[] = [];
      let pulses: { sprite: T.Sprite; base: number; phase: number }[] = [];
      let comets: { sprite: T.Sprite; curve: T.QuadraticBezierCurve3; offset: number }[] = [];
      const layerDisposables: { dispose: () => void }[] = [];
      const spriteMat = (color: number, opacity = 1) => {
        const m = new THREE.SpriteMaterial({ map: tex, color, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending });
        layerDisposables.push(m);
        return m;
      };

      const setPoints = (list: GlobePoint[], sel: string | null) => {
        for (const d of layerDisposables.splice(0)) d.dispose();
        pointLayer.clear();
        pickables = [];
        pulses = [];
        comets = [];
        const home = new THREE.Vector3(...toXYZ(HOME[1], HOME[0], 1.01));
        const seen = new Set<string>();
        list.forEach((p, i) => {
          const key = `${p.lat.toFixed(1)},${p.lon.toFixed(1)}`;
          const pos = new THREE.Vector3(...toXYZ(p.lat, p.lon, 1.015));
          const hot = p.id === sel || p.hot;
          const s = new THREE.Sprite(spriteMat(hot ? 0xffffff : PALE));
          const base = hot ? 0.11 : 0.075;
          s.scale.setScalar(base);
          s.position.copy(pos);
          pointLayer.add(s);
          pulses.push({ sprite: s, base, phase: i * 0.7 });
          // 選びやすいよう、見えない大きめの当たり判定
          const hit = new THREE.Mesh(new THREE.SphereGeometry(0.045, 8, 6), new THREE.MeshBasicMaterial({ visible: false }));
          layerDisposables.push(hit.geometry, hit.material as T.Material);
          hit.position.copy(pos);
          pointLayer.add(hit);
          pickables.push({ mesh: hit, id: p.id });
          // 東京から地点へ光の線（同じ場所へは 1 本だけ）
          if (seen.has(key) || pos.distanceTo(home) < 0.05) return;
          seen.add(key);
          const mid = pos.clone().add(home).multiplyScalar(0.5);
          mid.setLength(1 + 0.25 + pos.distanceTo(home) * 0.22);
          const curve = new THREE.QuadraticBezierCurve3(home, mid, pos);
          const g = new THREE.BufferGeometry().setFromPoints(curve.getPoints(48));
          layerDisposables.push(g);
          const lm = new THREE.LineBasicMaterial({ color: hot ? PALE : GLOW, transparent: true, opacity: hot ? 0.8 : 0.42 });
          layerDisposables.push(lm);
          pointLayer.add(new THREE.Line(g, lm));
          const comet = new THREE.Sprite(spriteMat(0xffffff, 0.95));
          comet.scale.setScalar(0.05);
          pointLayer.add(comet);
          comets.push({ sprite: comet, curve, offset: Math.random() });
        });
        // 東京（起点）
        const h = new THREE.Sprite(spriteMat(0x43ffb0, 0.9));
        h.scale.setScalar(0.07);
        h.position.copy(home);
        pointLayer.add(h);
      };
      setPoints(latest.current.points, latest.current.selectedId);

      // 視点を地点へ寄せる（ダブルクリック・選んだとき）
      let flight: { from: T.Vector3; to: T.Vector3; t: number } | null = null;
      const flyTo = (dir: T.Vector3, dist: number) => {
        // 地球は回っているので、地球の向きを含めた世界の位置に向ける
        const world = dir.clone().applyQuaternion(globe.quaternion).normalize();
        flight = { from: camera.position.clone(), to: world.multiplyScalar(dist), t: 0 };
      };
      const reset = () => {
        flight = { from: camera.position.clone(), to: new THREE.Vector3(0, 0.45, DIST.start), t: 0 };
      };

      // クリック（ドラッグと見分ける）・ダブルクリック
      const ray = new THREE.Raycaster();
      const ndc = new THREE.Vector2();
      const pick = (e: PointerEvent | MouseEvent) => {
        const r = renderer.domElement.getBoundingClientRect();
        ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
        ray.setFromCamera(ndc, camera);
      };
      let down: { x: number; y: number } | null = null;
      const onDown = (e: PointerEvent) => (down = { x: e.clientX, y: e.clientY });
      const onUp = (e: PointerEvent) => {
        if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return (down = null);
        down = null;
        pick(e);
        const hit = ray.intersectObjects(pickables.map((p) => p.mesh))[0];
        const id = hit ? (pickables.find((p) => p.mesh === hit.object)?.id ?? null) : null;
        latest.current.onSelect(id);
      };
      const sphere = new THREE.Sphere(new THREE.Vector3(), 1);
      const onDbl = (e: MouseEvent) => {
        pick(e);
        const at = new THREE.Vector3();
        if (!ray.ray.intersectSphere(sphere, at)) return;
        const local = at.clone().applyQuaternion(globe.quaternion.clone().invert());
        flyTo(local, Math.max(DIST.min + 0.15, camera.position.length() * 0.7));
      };
      renderer.domElement.addEventListener("pointerdown", onDown);
      renderer.domElement.addEventListener("pointerup", onUp);
      renderer.domElement.addEventListener("dblclick", onDbl);

      api.current = {
        setPoints,
        setAuto: (on) => (controls.autoRotate = on && !reduce),
        reset,
      };

      const resize = () => {
        const w = el.clientWidth || 1;
        const h = el.clientHeight || 1;
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        // 縦長の画面（スマホ）では引いて、地球が画面からはみ出さないようにする
        camera.zoom = Math.min(1, (w / h) * 1.25);
        camera.updateProjectionMatrix();
      };
      resize();
      const ro = new ResizeObserver(resize);
      ro.observe(el);

      let raf = 0;
      let last = performance.now();
      let viewAt = 0;
      const tick = (now: number) => {
        raf = requestAnimationFrame(tick);
        if (document.hidden) return;
        const dt = Math.min(0.05, (now - last) / 1000);
        last = now;
        if (flight) {
          flight.t = Math.min(1, flight.t + dt * 1.6);
          const k = 1 - Math.pow(1 - flight.t, 3);
          camera.position.lerpVectors(flight.from, flight.to, k);
          if (flight.t >= 1) flight = null;
        }
        controls.update();
        if (!reduce) {
          rings[0].rotation.y += dt * 0.12;
          rings[1].rotation.y -= dt * 0.08;
          rings[2].rotation.z += dt * 0.05;
          dustPts.rotation.y += dt * 0.02;
          const t = now / 1000;
          for (const p of pulses) p.sprite.scale.setScalar(p.base * (1 + 0.25 * Math.sin(t * 2.4 + p.phase)));
          for (const c of comets) c.sprite.position.copy(c.curve.getPoint((t * 0.35 + c.offset) % 1));
        }
        renderer.render(scene, camera);
        // 視点の中心の緯度・経度（小窓に出す。4 回に 1 回）
        if (++viewAt % 15 === 0 && latest.current.onView) {
          const dir = camera.position.clone().normalize().applyQuaternion(globe.quaternion.clone().invert());
          latest.current.onView(toLatLon(dir.x, dir.y, dir.z));
        }
      };
      raf = requestAnimationFrame(tick);

      cleanup = () => {
        cancelAnimationFrame(raf);
        ro.disconnect();
        renderer.domElement.removeEventListener("pointerdown", onDown);
        renderer.domElement.removeEventListener("pointerup", onUp);
        renderer.domElement.removeEventListener("dblclick", onDbl);
        controls.dispose();
        for (const d of layerDisposables) d.dispose();
        for (const d of disposables) d.dispose();
        renderer.dispose();
        renderer.domElement.remove();
        api.current = null;
      };
    })().catch(() => setFallback(true));
    return () => {
      disposed = true;
      cleanup();
    };
  }, []);

  useEffect(() => api.current?.setPoints(points, selectedId), [points, selectedId]);
  useEffect(() => api.current?.setAuto(autoRotate), [autoRotate]);
  useEffect(() => {
    if (resetKey) api.current?.reset();
  }, [resetKey]);

  if (fallback) return <FlatMap points={points} selectedId={selectedId} onSelect={onSelect} />;
  return <div ref={host} className="eglobe" aria-label="3D の世界地図。ドラッグで回転、ホイールで拡大・縮小、ダブルクリックで寄る" role="img" />;
});

/** WebGL が使えないときの平面の地図（陸地の粒と地点） */
function FlatMap({ points, selectedId, onSelect }: Pick<Props, "points" | "selectedId" | "onSelect">) {
  const [dots, setDots] = useState<LonLat[]>([]);
  useEffect(() => {
    void loadLand().then((l) => setDots(l.dots));
  }, []);
  const x = (lon: number) => ((lon + 180) / 360) * 720;
  const y = (lat: number) => ((90 - lat) / 180) * 360;
  return (
    <svg className="eglobe eglobe--flat" viewBox="0 0 720 360" role="img" aria-label="世界地図（平面表示）">
      {dots.map(([lon, lat], i) => (
        <circle key={i} cx={x(lon)} cy={y(lat)} r={1.1} fill="#8b35ff" opacity={0.7} />
      ))}
      {points.map((p) => (
        <circle
          key={p.id}
          cx={x(p.lon)}
          cy={y(p.lat)}
          r={p.id === selectedId ? 6 : 4}
          fill={p.id === selectedId ? "#ffffff" : "#d7b4ff"}
          style={{ cursor: "pointer" }}
          onClick={() => onSelect(p.id)}
        >
          <title>{p.label}</title>
        </circle>
      ))}
    </svg>
  );
}
