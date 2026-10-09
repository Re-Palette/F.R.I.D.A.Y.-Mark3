"use client";

/**
 * E.D.I.T.H. の中央：立体平面地図の 3D ホログラム（three.js）。
 *   - 世界地図（Natural Earth の陸地データ）を、ゆるくふくらんだ地図板の上に紫に光る粒と輪郭で描き、斜め上から見下ろす
 *   - 地図板のまわりに楕円の軌道リング・南北の軸・下に台座のリング・粒子を重ねる
 *   - 情報の地点（ニュースなどの代表地点）を光る点で示し、東京から地点へ地図の上に弧を描く光の線を流す
 *   - ドラッグで回す（見下ろす角度・左右の向きは見やすい範囲に制限）／ホイールで寄る・引く／クリックで地点を選ぶ／
 *     ダブルクリックでその場所に寄る／初期の視点に戻す／自動のゆらぎ（ON/OFF）。「視差効果を減らす」設定なら動きを止める
 *   - WebGL が使えなければ、平面の地図（SVG）で地点を示す
 */
import { memo, useEffect, useRef, useState } from "react";
import type * as T from "three";
import { domeY, fromPlane, landDots, landRings, MAP_H, MAP_W, toPlane, type LonLat } from "@/lib/edith-globe-data";

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
/** 初期の視点（斜め上から見下ろす） */
const START = { x: 0, y: 4.15, z: 3.85 };
const DIST = { min: 1.4, max: 8.5 };
/** 南極は地図に出さない（参考の地図と同じく、帯のように大きく出て見づらいため） */
const SOUTH_LIMIT = -57;
/** 楕円の縁へ向かって粒を薄くする（地図が楕円の中に浮いて見えるように） */
function edgeFade(x: number, z: number): number {
  const r = (x / 2.2) ** 2 + (z / 1.3) ** 2;
  return Math.max(0.12, Math.min(1, (1.05 - r) / 0.45));
}
/** 東京（光の線の起点。F.R.I.D.A.Y. のいる場所の代表地点） */
const HOME: LonLat = [139.69, 35.69];

let landCache: { rings: LonLat[][]; dots: LonLat[]; flatDots: LonLat[] } | null = null;
async function loadLand() {
  if (landCache) return landCache;
  const topo = (await import("world-atlas/land-110m.json")).default;
  const rings = landRings(topo);
  landCache = { rings, dots: landDots(rings), flatDots: landDots(rings, 1.15, true) };
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

/** 楕円の輪（中心 y の高さ、横 rx・奥行き rz） */
function ellipse(rx: number, rz: number, y = 0, seg = 160): number[] {
  const pts: number[] = [];
  for (let i = 0; i <= seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    pts.push(rx * Math.cos(a), y, rz * Math.sin(a));
  }
  return pts;
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
      camera.position.set(START.x, START.y, START.z);
      const controls = new OrbitControls(camera, renderer.domElement);
      controls.target.set(0, 0, 0.05);
      controls.enablePan = false;
      controls.enableDamping = true;
      controls.dampingFactor = 0.08;
      controls.rotateSpeed = 0.5;
      controls.zoomSpeed = 0.7;
      controls.minDistance = DIST.min;
      controls.maxDistance = DIST.max;
      // 地図が読める範囲：真上〜やや横から。左右は ±75 度まで
      controls.minPolarAngle = 0.15;
      controls.maxPolarAngle = 1.32;
      controls.minAzimuthAngle = -1.3;
      controls.maxAzimuthAngle = 1.3;

      const map = new THREE.Group();
      scene.add(map);
      const disposables: { dispose: () => void }[] = [];
      const keep = <X extends { dispose: () => void }>(x: X) => (disposables.push(x), x);
      const lineMat = (color: number, opacity: number) => keep(new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false }));
      const addLines = (pts: number[], mat: T.Material, parent: T.Object3D = map, loop = false) => {
        const g = keep(new THREE.BufferGeometry());
        g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
        const l = loop ? new THREE.Line(g, mat) : new THREE.LineSegments(g, mat);
        parent.add(l);
        return l;
      };

      // 地図板（ゆるい凸面。うっすら光る面。クリックの当たり判定にも使う）
      const surfGeo = keep(new THREE.PlaneGeometry(MAP_W, MAP_H, 64, 32));
      surfGeo.rotateX(-Math.PI / 2);
      const pos = surfGeo.attributes.position as T.BufferAttribute;
      for (let i = 0; i < pos.count; i++) pos.setY(i, domeY(pos.getX(i), pos.getZ(i)));
      surfGeo.computeVertexNormals();
      const surface = new THREE.Mesh(
        surfGeo,
        keep(
          new THREE.ShaderMaterial({
            transparent: true,
            depthWrite: false,
            uniforms: { color: { value: new THREE.Color(PURPLE) } },
            vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }",
            fragmentShader:
              "uniform vec3 color; varying vec2 vUv; void main(){ vec2 d = (vUv - 0.5) * vec2(1.0, 1.0); float r = length(d * vec2(1.0, 1.6)); float a = smoothstep(0.62, 0.0, r) * 0.13; gl_FragColor = vec4(color, a); }",
          }),
        ),
      );
      map.add(surface);

      // 緯度・経度の網（板に沿って）
      const grid: number[] = [];
      for (let lat = -60; lat <= 60; lat += 30) for (let lon = -180; lon < 180; lon += 4) grid.push(...toPlane(lat, lon, 0.002), ...toPlane(lat, lon + 4, 0.002));
      for (let lon = -150; lon <= 150; lon += 30) for (let lat = -88; lat < 88; lat += 4) grid.push(...toPlane(lat, lon, 0.002), ...toPlane(lat + 4, lon, 0.002));
      addLines(grid, lineMat(PURPLE, 0.18));
      // 赤道と本初子午線は少し強く（参考の十字の軸）
      const cross: number[] = [];
      for (let lon = -180; lon < 180; lon += 3) cross.push(...toPlane(0, lon, 0.003), ...toPlane(0, lon + 3, 0.003));
      for (let lat = -90; lat < 90; lat += 3) cross.push(...toPlane(lat, 0, 0.003), ...toPlane(lat + 3, 0, 0.003));
      addLines(cross, lineMat(GLOW, 0.45));

      // 陸地の輪郭
      const coast: number[] = [];
      for (const ring of land.rings) {
        if (ring.every(([, lat]) => lat < SOUTH_LIMIT)) continue;
        for (let i = 0; i < ring.length - 1; i++) {
          if (ring[i][1] < SOUTH_LIMIT || ring[i + 1][1] < SOUTH_LIMIT) continue;
          // 日付変更線をまたぐ線は引かない（地図の端から端へ横切らないように）
          if (Math.abs(ring[i][0] - ring[i + 1][0]) > 180) continue;
          coast.push(...toPlane(ring[i][1], ring[i][0], 0.006), ...toPlane(ring[i + 1][1], ring[i + 1][0], 0.006));
        }
      }
      addLines(coast, lineMat(PALE, 0.55));

      // 陸地の粒
      const tex = keep(dotTexture(THREE));
      const shown = land.flatDots.filter(([, lat]) => lat >= SOUTH_LIMIT);
      const dots = new Float32Array(shown.length * 3);
      const colors = new Float32Array(shown.length * 3);
      const base = new THREE.Color(0xc79bff);
      shown.forEach(([lon, lat], i) => {
        const p = toPlane(lat, lon, 0.008);
        dots.set(p, i * 3);
        const f = edgeFade(p[0], p[2]);
        colors.set([base.r * f, base.g * f, base.b * f], i * 3);
      });
      const dotGeo = keep(new THREE.BufferGeometry());
      dotGeo.setAttribute("position", new THREE.BufferAttribute(dots, 3));
      dotGeo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
      map.add(
        new THREE.Points(
          dotGeo,
          keep(new THREE.PointsMaterial({ vertexColors: true, size: 0.04, map: tex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 1 })),
        ),
      );

      // 地図を囲む楕円のリング（板の高さ・少し上下）と、外側の回る輪
      addLines(ellipse(2.25, 1.32, 0.0), lineMat(GLOW, 0.75), map, true);
      addLines(ellipse(2.42, 1.45, 0.02), lineMat(PURPLE, 0.35), map, true);
      const spinA = addLines(ellipse(2.62, 1.56, 0.12), lineMat(GLOW, 0.4), map, true);
      const spinB = addLines(ellipse(2.05, 1.18, 0.42), lineMat(PURPLE, 0.25), map, true);
      // 輪の上を流れる光の粒
      const ringDots: T.Sprite[] = [];
      const spriteMatStatic = (color: number, opacity = 1) => keep(new THREE.SpriteMaterial({ map: tex, color, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending }));
      for (let i = 0; i < 6; i++) {
        const s = new THREE.Sprite(spriteMatStatic(PALE, 0.9));
        s.scale.setScalar(0.07);
        map.add(s);
        ringDots.push(s);
      }

      // 南北の軸（板の中心を縦に通る線と、上下の三角の印）
      addLines([0, -1.25, 0, 0, 1.15, 0], lineMat(GLOW, 0.5));
      const tri = (y: number, up: boolean) => {
        const g = keep(new THREE.ConeGeometry(0.05, 0.1, 3));
        const m = new THREE.Mesh(g, keep(new THREE.MeshBasicMaterial({ color: PALE, transparent: true, opacity: 0.85 })));
        m.position.set(0, y, 0);
        if (!up) m.rotation.z = Math.PI;
        map.add(m);
      };
      tri(1.2, true);
      tri(-1.3, false);

      // 下の台座（地図の下に重なる輪）
      for (const [rx, rz, y, op] of [
        [1.55, 0.82, -0.55, 0.45],
        [1.3, 0.68, -0.72, 0.35],
        [1.75, 0.92, -0.85, 0.22],
      ] as const) {
        addLines(ellipse(rx, rz, y), lineMat(GLOW, op), map, true);
      }
      // 台座の目盛り（短い放射状の線）
      const ticks: number[] = [];
      for (let i = 0; i < 72; i++) {
        const a = (i / 72) * Math.PI * 2;
        ticks.push(1.62 * Math.cos(a), -0.6, 0.86 * Math.sin(a), 1.72 * Math.cos(a), -0.6, 0.91 * Math.sin(a));
      }
      addLines(ticks, lineMat(PURPLE, 0.4));

      // まわりの粒子（控えめ）
      const dust = new Float32Array(320 * 3);
      for (let i = 0; i < 320; i++) {
        const a = Math.random() * Math.PI * 2;
        const r = 1.6 + Math.random() * 1.4;
        dust.set([r * Math.cos(a) * 1.3, -0.9 + Math.random() * 2.2, r * Math.sin(a) * 0.8], i * 3);
      }
      const dustGeo = keep(new THREE.BufferGeometry());
      dustGeo.setAttribute("position", new THREE.BufferAttribute(dust, 3));
      const dustPts = new THREE.Points(dustGeo, keep(new THREE.PointsMaterial({ color: PALE, size: 0.014, map: tex, transparent: true, opacity: 0.4, depthWrite: false, blending: THREE.AdditiveBlending })));
      scene.add(dustPts);

      // 情報の地点・光の線（親から差し替える）
      const pointLayer = new THREE.Group();
      map.add(pointLayer);
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
        const home = new THREE.Vector3(...toPlane(HOME[1], HOME[0], 0.02));
        const seen = new Set<string>();
        list.forEach((p, i) => {
          const key = `${p.lat.toFixed(1)},${p.lon.toFixed(1)}`;
          const at = new THREE.Vector3(...toPlane(p.lat, p.lon, 0.025));
          const hot = p.id === sel || p.hot;
          const s = new THREE.Sprite(spriteMat(hot ? 0xffffff : PALE));
          const base = hot ? 0.16 : 0.11;
          s.scale.setScalar(base);
          s.position.copy(at);
          pointLayer.add(s);
          pulses.push({ sprite: s, base, phase: i * 0.7 });
          // 地点の下に光の柱（立体感）
          const pillar = new THREE.BufferGeometry().setFromPoints([at.clone().setY(at.y - 0.02), at.clone().setY(at.y + (hot ? 0.28 : 0.16))]);
          const pm = new THREE.LineBasicMaterial({ color: hot ? 0xffffff : PALE, transparent: true, opacity: hot ? 0.9 : 0.5 });
          layerDisposables.push(pillar, pm);
          pointLayer.add(new THREE.Line(pillar, pm));
          // 選びやすいよう、見えない大きめの当たり判定
          const hit = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 6), new THREE.MeshBasicMaterial({ visible: false }));
          layerDisposables.push(hit.geometry, hit.material as T.Material);
          hit.position.copy(at);
          pointLayer.add(hit);
          pickables.push({ mesh: hit, id: p.id });
          // 東京から地点へ、地図の上に弧を描く光の線（同じ場所へは 1 本だけ）
          if (seen.has(key) || at.distanceTo(home) < 0.05) return;
          seen.add(key);
          const mid = at.clone().add(home).multiplyScalar(0.5);
          mid.y += 0.18 + at.distanceTo(home) * 0.32;
          const curve = new THREE.QuadraticBezierCurve3(home, mid, at);
          const g = new THREE.BufferGeometry().setFromPoints(curve.getPoints(48));
          const lm = new THREE.LineBasicMaterial({ color: hot ? PALE : GLOW, transparent: true, opacity: hot ? 0.85 : 0.5 });
          layerDisposables.push(g, lm);
          pointLayer.add(new THREE.Line(g, lm));
          const comet = new THREE.Sprite(spriteMat(0xffffff, 0.95));
          comet.scale.setScalar(0.06);
          pointLayer.add(comet);
          comets.push({ sprite: comet, curve, offset: Math.random() });
        });
        // 東京（起点）
        const h = new THREE.Sprite(spriteMat(0x43ffb0, 0.95));
        h.scale.setScalar(0.1);
        h.position.copy(home);
        pointLayer.add(h);
      };
      setPoints(latest.current.points, latest.current.selectedId);

      // 視点を地点へ寄せる（ダブルクリック）・初期の視点に戻す（見る中心と視点の位置を一緒に動かす）
      let flight: { fromPos: T.Vector3; toPos: T.Vector3; fromTarget: T.Vector3; toTarget: T.Vector3; t: number } | null = null;
      const startView = new THREE.Vector3(START.x, START.y, START.z);
      const startTarget = new THREE.Vector3(0, 0, 0.05);
      const fly = (toTarget: T.Vector3, toPos: T.Vector3) => {
        flight = { fromPos: camera.position.clone(), toPos, fromTarget: controls.target.clone(), toTarget, t: 0 };
      };
      const reset = () => fly(startTarget.clone(), startView.clone());

      // クリック（ドラッグと見分ける）・ダブルクリック
      const ray = new THREE.Raycaster();
      const ndc = new THREE.Vector2();
      const pick = (e: PointerEvent | MouseEvent) => {
        const r = renderer.domElement.getBoundingClientRect();
        ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
        ray.setFromCamera(ndc, camera);
      };
      let down: { x: number; y: number } | null = null;
      let interacting = false;
      const onDown = (e: PointerEvent) => {
        down = { x: e.clientX, y: e.clientY };
        interacting = true;
      };
      const onUp = (e: PointerEvent) => {
        interacting = false;
        if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return (down = null);
        down = null;
        pick(e);
        const hit = ray.intersectObjects(pickables.map((p) => p.mesh))[0];
        const id = hit ? (pickables.find((p) => p.mesh === hit.object)?.id ?? null) : null;
        latest.current.onSelect(id);
      };
      const onDbl = (e: MouseEvent) => {
        pick(e);
        const hit = ray.intersectObject(surface)[0];
        if (!hit) return;
        const target = hit.point.clone();
        // いまの見る向きのまま、その場所へ近づく
        const dir = camera.position.clone().sub(controls.target).normalize();
        const dist = Math.max(DIST.min + 0.2, camera.position.distanceTo(controls.target) * 0.55);
        fly(target, target.clone().add(dir.multiplyScalar(dist)));
      };
      renderer.domElement.addEventListener("pointerdown", onDown);
      renderer.domElement.addEventListener("pointerup", onUp);
      renderer.domElement.addEventListener("dblclick", onDbl);

      let auto = !reduce && latest.current.autoRotate;
      api.current = {
        setPoints,
        setAuto: (on) => (auto = on && !reduce),
        reset,
      };

      const resize = () => {
        const w = el.clientWidth || 1;
        const h = el.clientHeight || 1;
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        // 縦長の画面（スマホ）では引いて、地図が画面からはみ出さないようにする
        camera.zoom = Math.min(1, (w / h) * 0.85);
        camera.updateProjectionMatrix();
      };
      resize();
      const ro = new ResizeObserver(resize);
      ro.observe(el);

      let raf = 0;
      let last = performance.now();
      let viewAt = 0;
      let sway = 0;
      const tick = (now: number) => {
        raf = requestAnimationFrame(tick);
        if (document.hidden) return;
        const dt = Math.min(0.05, (now - last) / 1000);
        last = now;
        if (flight) {
          flight.t = Math.min(1, flight.t + dt * 1.6);
          const k = 1 - Math.pow(1 - flight.t, 3);
          camera.position.lerpVectors(flight.fromPos, flight.toPos, k);
          controls.target.lerpVectors(flight.fromTarget, flight.toTarget, k);
          if (flight.t >= 1) flight = null;
        }
        controls.update();
        const t = now / 1000;
        // 自動のゆらぎ：地図板を左右にゆっくり振る（触っている間は止める）
        if (auto && !interacting) {
          sway += dt;
          map.rotation.y = 0.22 * Math.sin(sway * 0.18);
        }
        if (!reduce) {
          spinA.rotation.y += dt * 0.1;
          spinB.rotation.y -= dt * 0.07;
          dustPts.rotation.y += dt * 0.015;
          ringDots.forEach((s, i) => {
            const a = t * 0.25 + (i / ringDots.length) * Math.PI * 2;
            const outer = i % 2 === 0;
            s.position.set((outer ? 2.25 : 1.55) * Math.cos(a), outer ? 0 : -0.55, (outer ? 1.32 : 0.82) * Math.sin(a));
          });
          for (const p of pulses) p.sprite.scale.setScalar(p.base * (1 + 0.25 * Math.sin(t * 2.4 + p.phase)));
          for (const c of comets) c.sprite.position.copy(c.curve.getPoint((t * 0.35 + c.offset) % 1));
        }
        renderer.render(scene, camera);
        // 見ている中心の緯度・経度（小窓に出す）
        if (++viewAt % 15 === 0 && latest.current.onView) {
          const local = map.worldToLocal(controls.target.clone());
          latest.current.onView(fromPlane(local.x, local.z));
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
    void loadLand().then((l) => setDots(l.flatDots));
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
