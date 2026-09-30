"use client";

/**
 * 中央リアクターの内側に浮かぶ 3D ホログラム（three.js / WebGL）。
 *   光る線の地球儀・点の雲・傾いたリング・上下に走るスキャン線・中心のコア
 * - 考え中・返答中は回転が速くなり、F.R.I.D.A.Y. が話している間は声に合わせて脈打つ
 * - ドラッグで回す／ホイールで拡大縮小／ダブルクリックで元に戻す。手の動き（HandControl）でも動く
 * - 画面に見えていない間は描画を止める。WebGL が使えない環境では何も出さない（元の円盤が見える）
 */
import { useEffect, useRef, useState } from "react";
import type { ChatPhase } from "@/hooks/useChat";
import { holo, resetView, rotateBy, zoomBy } from "@/lib/hologram-control";

const ORANGE = 0xff8a1f;
const AMBER = 0xffb45a;
const CYAN = 0x2ee6ff;
const R = 1.5;

export function Hologram({ phase, speaking, active }: { phase: ChatPhase; speaking: boolean; active: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const live = useRef({ phase, speaking, active });
  live.current = { phase, speaking, active };
  const [failed, setFailed] = useState(false);

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
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
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
      body.add(new THREE.LineSegments(gridGeo, gridMat));

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
      body.add(new THREE.Points(dotGeo, dotMat));

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

      // 大きさ
      const resize = () => {
        const w = el.clientWidth;
        const h = el.clientHeight;
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
        const busy = ph !== "idle";
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
  return <div ref={box} className="core__holo" title="ドラッグで回す・ホイールで拡大・ダブルクリックで元に戻す" />;
}
