"use client";

/**
 * 中央リアクターの内側に浮かぶ 3D ホログラム（three.js / WebGL）。
 *   光る線の地球儀・点の雲・傾いたリング・上下に走るスキャン線・中心のコア
 * - 考え中・返答中は回転が速くなり、F.R.I.D.A.Y. が話している間は声に合わせて脈打つ
 * - ドラッグで回す／ホイールで拡大縮小／ダブルクリックで元に戻す。手の動き（HandControl）でも動く
 * - 画面に見えていない間は描画を止める。WebGL が使えない環境では何も出さない（元の円盤が見える）
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ChatPhase } from "@/hooks/useChat";
import { holo, resetView, rotateBy, zoomBy } from "@/lib/hologram-control";
import { clearHologram, getHoloState, setHoloExpanded, subscribeHolo, useHoloState } from "@/lib/hologram-model";
import type { HoloModel } from "@/lib/hologram-schema";
import { toggleHand, useHandStatus } from "./HandControl";

const ORANGE = 0xff8a1f;
const AMBER = 0xffb45a;
const CYAN = 0x2ee6ff;
const R = 1.5;
const PART_COLORS = { orange: ORANGE, cyan: CYAN, amber: AMBER, white: 0xfff1dd } as const;

type Three = typeof import("three");

/** 設計図（部品のリスト）から、ホログラム風の線と薄い面でできた立体を組み立てる */
function buildModel(THREE: Three, model: HoloModel) {
  const group = new THREE.Group();
  const spinners: { obj: InstanceType<Three["Object3D"]>; axis: "x" | "y" | "z" }[] = [];
  const lineMats = new Map<string, InstanceType<Three["LineBasicMaterial"]>>();
  const fillMats = new Map<string, InstanceType<Three["MeshBasicMaterial"]>>();
  const deg = Math.PI / 180;
  for (const p of model.parts) {
    const [a, b = a, c = b] = p.size;
    let geo: import("three").BufferGeometry<import("three").NormalBufferAttributes>;
    let smooth = false;
    switch (p.shape) {
      case "box":
        geo = new THREE.BoxGeometry(a, b, c);
        break;
      case "sphere":
        geo = new THREE.SphereGeometry(a, 14, 10);
        smooth = true;
        break;
      case "cylinder":
        geo = new THREE.CylinderGeometry(a, b, p.size[2] ?? a * 2, 16);
        break;
      case "cone":
        geo = new THREE.ConeGeometry(a, b, 16);
        break;
      case "torus":
        geo = new THREE.TorusGeometry(a, Math.min(b, a), 8, 28);
        geo.rotateX(Math.PI / 2); // 寝かせた輪を基本にする
        smooth = true;
        break;
      default:
        geo = new THREE.CapsuleGeometry(a, b, 4, 10);
        smooth = true;
    }
    const color = PART_COLORS[p.color];
    if (!lineMats.has(p.color)) {
      lineMats.set(p.color, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false }));
      fillMats.set(
        p.color,
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.07, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
      );
    }
    const holder = new THREE.Group();
    holder.position.set(...p.position);
    holder.rotation.set(p.rotation[0] * deg, p.rotation[1] * deg, p.rotation[2] * deg);
    const edges = smooth ? new THREE.WireframeGeometry(geo) : new THREE.EdgesGeometry(geo, 12);
    holder.add(new THREE.LineSegments(edges, lineMats.get(p.color)));
    holder.add(new THREE.Mesh(geo, fillMats.get(p.color)));
    if (p.spin) spinners.push({ obj: holder, axis: p.spin });
    group.add(holder);
  }
  // 大きさと位置をそろえる（地球儀と同じくらいの大きさで、中心に）
  const box = new THREE.Box3().setFromObject(group);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const fit = (R * 1.9) / Math.max(size.x, size.y, size.z, 0.001);
  const pivot = new THREE.Group();
  group.position.set(-center.x, -center.y, -center.z);
  pivot.add(group);
  pivot.scale.setScalar(fit);
  pivot.userData.fit = fit;
  return { pivot, spinners };
}

export function Hologram({ phase, speaking, active }: { phase: ChatPhase; speaking: boolean; active: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const live = useRef({ phase, speaking, active });
  live.current = { phase, speaking, active };
  const [failed, setFailed] = useState(false);
  const hs = useHoloState();
  // 拡大表示の枠は body に出す。サーバーの HTML と食い違わないよう、表示後に出す
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let disposed = false;
    let cleanup = () => {};

    void import("three").then((THREE) => {
      if (disposed) return;
      let renderer: InstanceType<typeof THREE.WebGLRenderer>;
      try {
        renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: "low-power" });
      } catch {
        setFailed(true);
        return;
      }
      // 高解像度の画面でも描く点の数を抑える（拡大表示は面積が大きいのでさらに控えめに）
      const pixelRatio = () => Math.min(window.devicePixelRatio || 1, getHoloState().expanded ? 1.25 : 1.5);
      renderer.setPixelRatio(pixelRatio());
      renderer.setClearColor(0x000000, 0);
      el.appendChild(renderer.domElement);

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
      camera.position.set(0, 0, 6.8);

      const glow = (color: number, opacity: number) =>
        new THREE.LineBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false });

      const root = new THREE.Group(); // 手・マウスで回す
      const body = new THREE.Group(); // 自転
      root.add(body);
      root.rotation.x = 0.35;
      scene.add(root);

      // 地球儀の経線・緯線
      const grid: number[] = [];
      for (let i = 1; i < 12; i++) {
        const lat = -Math.PI / 2 + (i * Math.PI) / 12;
        const y = R * Math.sin(lat);
        const r = R * Math.cos(lat);
        for (let j = 0; j < 72; j++) {
          const a1 = (j / 72) * Math.PI * 2;
          const a2 = ((j + 1) / 72) * Math.PI * 2;
          grid.push(r * Math.cos(a1), y, r * Math.sin(a1), r * Math.cos(a2), y, r * Math.sin(a2));
        }
      }
      for (let k = 0; k < 18; k++) {
        const lon = (k / 18) * Math.PI * 2;
        for (let j = 0; j < 48; j++) {
          const t1 = -Math.PI / 2 + (j / 48) * Math.PI;
          const t2 = -Math.PI / 2 + ((j + 1) / 48) * Math.PI;
          grid.push(
            R * Math.cos(t1) * Math.cos(lon), R * Math.sin(t1), R * Math.cos(t1) * Math.sin(lon),
            R * Math.cos(t2) * Math.cos(lon), R * Math.sin(t2), R * Math.cos(t2) * Math.sin(lon),
          );
        }
      }
      const gridGeo = new THREE.BufferGeometry();
      gridGeo.setAttribute("position", new THREE.Float32BufferAttribute(grid, 3));
      const gridMat = glow(ORANGE, 0.28);
      const globe = new THREE.LineSegments(gridGeo, gridMat);
      body.add(globe);

      // 表面の点の雲（明るさをばらつかせる）
      const N = 1100;
      const pts = new Float32Array(N * 3);
      const cols = new Float32Array(N * 3);
      const base = new THREE.Color(AMBER);
      for (let i = 0; i < N; i++) {
        const y = 1 - (i / (N - 1)) * 2;
        const r = Math.sqrt(1 - y * y);
        const a = i * Math.PI * (3 - Math.sqrt(5));
        const rr = R * (1.005 + Math.random() * 0.02);
        pts.set([Math.cos(a) * r * rr, y * rr, Math.sin(a) * r * rr], i * 3);
        const b = 0.25 + Math.random() ** 3 * 0.9;
        cols.set([base.r * b, base.g * b, base.b * b], i * 3);
      }
      const dotGeo = new THREE.BufferGeometry();
      dotGeo.setAttribute("position", new THREE.BufferAttribute(pts, 3));
      dotGeo.setAttribute("color", new THREE.BufferAttribute(cols, 3));
      const dotMat = new THREE.PointsMaterial({
        size: 0.04,
        vertexColors: true,
        transparent: true,
        opacity: 0.95,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const dots = new THREE.Points(dotGeo, dotMat);
      body.add(dots);

      // 中心のコア（多面体 + 光）
      const coreGeo = new THREE.IcosahedronGeometry(0.42, 1);
      const coreMat = new THREE.MeshBasicMaterial({ color: 0xffd9a0, wireframe: true, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false });
      const core = new THREE.Mesh(coreGeo, coreMat);
      root.add(core);

      const glowCanvas = document.createElement("canvas");
      glowCanvas.width = glowCanvas.height = 128;
      const g = glowCanvas.getContext("2d")!;
      const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
      grad.addColorStop(0, "rgba(255,230,190,1)");
      grad.addColorStop(0.25, "rgba(255,150,50,0.55)");
      grad.addColorStop(1, "rgba(255,110,10,0)");
      g.fillStyle = grad;
      g.fillRect(0, 0, 128, 128);
      const glowTex = new THREE.CanvasTexture(glowCanvas);
      const glowMat = new THREE.SpriteMaterial({ map: glowTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
      const halo = new THREE.Sprite(glowMat);
      halo.scale.setScalar(1.9);
      root.add(halo);

      // 傾いたリング（破線）と、その上を回る光点
      const ringLine = (radius: number, color: number, dash: number, gap: number, opacity: number) => {
        const p: number[] = [];
        for (let i = 0; i <= 160; i++) {
          const a = (i / 160) * Math.PI * 2;
          p.push(Math.cos(a) * radius, 0, Math.sin(a) * radius);
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.Float32BufferAttribute(p, 3));
        const mat = new THREE.LineDashedMaterial({ color, dashSize: dash, gapSize: gap, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false });
        const line = new THREE.Line(geo, mat);
        line.computeLineDistances();
        return line;
      };
      const rings = [
        { tilt: [1.15, 0, 0.25], radius: 1.85, color: ORANGE, speed: 0.35, dash: [0.5, 0.12] },
        { tilt: [-0.95, 0.6, 0], radius: 1.97, color: CYAN, speed: -0.25, dash: [0.08, 0.1] },
        { tilt: [0.12, 0, -0.1], radius: 2.08, color: AMBER, speed: 0.12, dash: [1.4, 0.35] },
      ].map((d) => {
        const holder = new THREE.Group();
        holder.rotation.set(d.tilt[0], d.tilt[1], d.tilt[2]);
        const spin = new THREE.Group();
        spin.add(ringLine(d.radius, d.color, d.dash[0], d.dash[1], 0.75));
        const sat = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: d.color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
        sat.scale.setScalar(0.28);
        sat.position.set(d.radius, 0, 0);
        spin.add(sat);
        holder.add(spin);
        root.add(holder);
        return { spin, speed: d.speed };
      });

      // 上下に走るスキャン線
      const scanGeo = new THREE.BufferGeometry();
      const scanPts: number[] = [];
      for (let i = 0; i <= 96; i++) {
        const a = (i / 96) * Math.PI * 2;
        scanPts.push(Math.cos(a), 0, Math.sin(a));
      }
      scanGeo.setAttribute("position", new THREE.Float32BufferAttribute(scanPts, 3));
      const scanMat = glow(CYAN, 0.8);
      const scan = new THREE.Line(scanGeo, scanMat);
      body.add(scan);

      // 大きさ（拡大表示のときは、画面いっぱいの枠の大きさ）
      const resize = () => {
        const host = renderer.domElement.parentElement ?? el;
        const w = host.clientWidth;
        const h = host.clientHeight;
        if (!w || !h) return;
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
      };
      const ro = new ResizeObserver(resize);
      ro.observe(el);
      resize();

      // マウス・タッチ
      const canvas = renderer.domElement;
      let drag: { x: number; y: number } | null = null;
      const down = (e: PointerEvent) => {
        drag = { x: e.clientX, y: e.clientY };
        canvas.setPointerCapture(e.pointerId);
      };
      const move = (e: PointerEvent) => {
        if (!drag) return;
        rotateBy((e.clientX - drag.x) * 0.0009, (e.clientY - drag.y) * 0.0009);
        drag = { x: e.clientX, y: e.clientY };
      };
      const up = () => (drag = null);
      const wheel = (e: WheelEvent) => {
        e.preventDefault();
        zoomBy(Math.exp(-e.deltaY * 0.0012));
      };
      const dbl = () => resetView();
      canvas.addEventListener("pointerdown", down);
      canvas.addEventListener("pointermove", move);
      canvas.addEventListener("pointerup", up);
      canvas.addEventListener("pointercancel", up);
      canvas.addEventListener("wheel", wheel, { passive: false });
      canvas.addEventListener("dblclick", dbl);

      // 作った「〇〇のホログラム」を入れ替える・拡大表示の枠へ移す
      let shown: { pivot: InstanceType<Three["Group"]>; spinners: ReturnType<typeof buildModel>["spinners"] } | null = null;
      let shownModel: HoloModel | undefined;
      let appear = 1;
      const disposeModel = () => {
        if (!shown) return;
        root.remove(shown.pivot);
        shown.pivot.traverse((o) => {
          const m = o as unknown as { geometry?: { dispose(): void }; material?: { dispose(): void } };
          m.geometry?.dispose();
          m.material?.dispose();
        });
        shown = null;
      };
      const sync = () => {
        const st = getHoloState();
        if (st.model !== shownModel) {
          shownModel = st.model;
          disposeModel();
          if (st.model && st.status === "ready") {
            shown = buildModel(THREE, st.model);
            root.add(shown.pivot);
            appear = 0;
          }
        }
        const target = st.expanded ? document.querySelector<HTMLElement>(".holo-stage__canvas") : el;
        if (target && canvas.parentElement !== target) {
          renderer.setPixelRatio(pixelRatio());
          target.appendChild(canvas);
          ro.disconnect();
          ro.observe(target);
          resize();
        }
      };
      const unsubscribe = subscribeHolo(sync);
      sync();

      // 見えている間だけ描く
      let onScreen = true;
      const io = new IntersectionObserver(([entry]) => (onScreen = entry.isIntersecting));
      io.observe(el);
      const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

      let raf = 0;
      let last = performance.now();
      let t = 0;
      let seenResets = holo.resets;
      let returning = false;
      let energy = 0; // 考え中・話し中の勢い（0〜1、なめらかに変える）
      const frame = (now: number) => {
        raf = requestAnimationFrame(frame);
        const { phase: ph, speaking: talk, active: on } = live.current;
        if (!on || !onScreen || document.hidden) {
          last = now;
          return;
        }
        const dt = Math.min(0.05, (now - last) / 1000);
        last = now;
        t += dt;
        const hstate = getHoloState();
        const busy = ph !== "idle" || hstate.status === "loading";
        energy += ((busy || talk ? 1 : 0) - energy) * Math.min(1, dt * 3);
        const pace = (calm ? 0.4 : 1) * (1 + energy * 2.2);

        body.rotation.y += dt * 0.25 * pace;
        core.rotation.x += dt * 0.6 * pace;
        core.rotation.y += dt * 0.9 * pace;
        for (const r of rings) r.spin.rotation.y += dt * r.speed * pace;
        const sy = Math.sin(t * (0.6 + energy * 0.8)) * R * 0.95;
        scan.position.y = sy;
        scan.scale.setScalar(Math.sqrt(Math.max(0.0001, R * R - sy * sy)) * 1.01);

        // 手・マウスの回転（慣性つき）
        if (holo.resets !== seenResets) {
          seenResets = holo.resets;
          returning = true;
        }
        if (returning) {
          root.rotation.x += (0.35 - root.rotation.x) * Math.min(1, dt * 5);
          root.rotation.y += (0 - root.rotation.y) * Math.min(1, dt * 5);
          if (Math.abs(root.rotation.y) < 0.002 && Math.abs(root.rotation.x - 0.35) < 0.002) returning = false;
        }
        root.rotation.y += holo.spinY;
        root.rotation.x = Math.max(-1.3, Math.min(1.3, root.rotation.x + holo.spinX));
        const decay = Math.pow(0.9, dt * 60);
        holo.spinX *= decay;
        holo.spinY *= decay;

        // 話している間は声に合わせて脈打つ
        // 作ったホログラムがあるときは、地球儀とコアを隠してそれを見せる
        const modelOn = Boolean(shown);
        globe.visible = dots.visible = core.visible = !modelOn;
        halo.visible = !modelOn || hstate.status === "loading";
        if (shown) {
          appear = Math.min(1, appear + dt * 1.6);
          shown.pivot.rotation.y += dt * 0.3 * (calm ? 0.4 : 1);
          const k = 1 - Math.pow(1 - appear, 3);
          shown.pivot.scale.setScalar((shown.pivot.userData.fit as number) * (0.2 + 0.8 * k));
          for (const sp of shown.spinners) sp.obj.rotation[sp.axis] += dt * 2.2;
        }

        const beat = talk ? 0.5 + 0.5 * Math.sin(t * 11) * Math.sin(t * 3.7 + 1) : 0;
        const scale = holo.zoom * (1 + beat * 0.035);
        root.scale.setScalar(root.scale.x + (scale - root.scale.x) * Math.min(1, dt * 8));
        halo.scale.setScalar(1.6 + energy * 0.5 + beat * 0.6);
        glowMat.opacity = 0.65 + energy * 0.25 + beat * 0.2;
        gridMat.opacity = 0.22 + energy * 0.14;
        coreMat.opacity = 0.45 + beat * 0.4;

        renderer.render(scene, camera);
      };
      raf = requestAnimationFrame(frame);

      cleanup = () => {
        cancelAnimationFrame(raf);
        unsubscribe();
        disposeModel();
        ro.disconnect();
        io.disconnect();
        canvas.removeEventListener("pointerdown", down);
        canvas.removeEventListener("pointermove", move);
        canvas.removeEventListener("pointerup", up);
        canvas.removeEventListener("pointercancel", up);
        canvas.removeEventListener("wheel", wheel);
        canvas.removeEventListener("dblclick", dbl);
        scene.traverse((o) => {
          const m = o as unknown as { geometry?: { dispose(): void }; material?: { dispose(): void } };
          m.geometry?.dispose();
          m.material?.dispose();
        });
        glowTex.dispose();
        renderer.dispose();
        canvas.remove();
      };
    }, () => setFailed(true));

    return () => {
      disposed = true;
      cleanup();
    };
  }, []);

  if (failed) return null;
  return (
    <>
      <div ref={box} className="core__holo" title="ドラッグで回す・ホイールで拡大・ダブルクリックで元に戻す" />
      {hs.status !== "idle" && (
        <div className="holo-chip" data-status={hs.status}>
          <button type="button" className="holo-chip__name" onClick={() => setHoloExpanded(true)} title="大きく表示">
            {hs.status === "loading" ? "GENERATING…" : hs.status === "error" ? "FAILED" : (hs.model?.title ?? hs.subject)}
          </button>
          <button type="button" className="holo-chip__x" onClick={clearHologram} aria-label="ホログラムを消す">
            ×
          </button>
        </div>
      )}
      {mounted && createPortal(<HoloStage open={hs.expanded && active} />, document.body)}
    </>
  );
}

/** 作ったホログラムを画面いっぱいに大きく見せる枠（中身の canvas は Hologram が移してくる） */
function HoloStage({ open }: { open: boolean }) {
  const hs = useHoloState();
  const hand = useHandStatus();
  const handOn = hand === "loading" || hand === "ready";
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setHoloExpanded(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  return (
    <div className="holo-stage" data-open={open || undefined} aria-hidden={!open}>
      <div className="holo-stage__frame">
        <div className="holo-stage__canvas" />
        <div className="holo-stage__head">
          <span className="holo-stage__label">HOLOGRAM</span>
          <b>{hs.model?.title ?? hs.subject ?? ""}</b>
          {hs.status === "loading" && <span className="holo-stage__status">設計しています…</span>}
          {hs.status === "error" && <span className="holo-stage__status holo-stage__status--err">{hs.error}</span>}
        </div>
        <p className="holo-stage__help">ドラッグ・つまんで回す ／ ホイール・両手で拡大 ／ ダブルクリック・グーで元の向き</p>
        <div className="holo-stage__hand" />
        <div className="holo-stage__actions">
          <button type="button" className="ghost-btn" aria-pressed={handOn} onClick={toggleHand}>
            HAND {handOn ? "ON" : "OFF"}
          </button>
          <button type="button" className="ghost-btn" onClick={() => setHoloExpanded(false)}>
            小さくする
          </button>
          <button type="button" className="ghost-btn" onClick={clearHologram}>
            消す
          </button>
        </div>
      </div>
    </div>
  );
}
