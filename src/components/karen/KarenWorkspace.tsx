"use client";

/**
 * K.A.R.E.N. の制作ワークスペース（中央の 3D ビュー。three.js / WebGL）。背景の CSS の方眼の上に、透けて重なる。
 *   - ドラッグで視点を回す／右ドラッグ・2 本指で平行移動／ホイールで寄る・引く（OrbitControls）
 *   - クリックでオブジェクトを選ぶ（輪郭の箱を出す）→ 移動・回転・拡大縮小のハンドルで直接動かす（TransformControls）
 *   - 中身は karen-scene の一覧どおりに描き、ハンドルで動かした結果は一覧に書き戻す
 *   - PNG 画像・GLB の書き出し、小さな画像（右のプレビュー・保存用）を作る
 * 画面に見えていない間・タブが裏の間は描かない。WebGL が使えない環境では、その旨を出す。
 */
import { memo, useEffect, useRef, useState } from "react";
import type * as T from "three";
import { buildAsset, buildModel, holoMaterial } from "../hologram-visuals";
import { registerWorkspace } from "@/lib/karen-controller";
import { getScene, selectObject, updateObject, useScene, type SceneObject, type Vec3 } from "@/lib/karen-scene";
import type { Shape } from "@/lib/karen-intent";

type Three = typeof import("three");
export type TransformMode = "translate" | "rotate" | "scale";

/** 作ったときの色合い（暖色）を、K.A.R.E.N. の青に寄せる（赤と青を入れ替える。もともと青いものはそのまま） */
function coolColor(c: T.Color) {
  if (c.r > c.b) {
    const r = c.r;
    c.r = c.b;
    c.b = r;
  }
}

/** 色を塗り替える（color が無ければ、作ったときの暖色を青に寄せる） */
function paint(THREE: Three, root: T.Object3D, color: string | undefined) {
  const want = color ? new THREE.Color(color) : null;
  root.traverse((o) => {
    const mats = (o as T.Mesh).material;
    for (const m of Array.isArray(mats) ? mats : mats ? [mats] : []) {
      const sm = m as T.ShaderMaterial;
      if (sm.uniforms?.uColor) {
        if (!sm.userData.base) sm.userData.base = (sm.uniforms.uColor.value as T.Color).clone();
        const c = want ? want.clone() : (sm.userData.base as T.Color).clone();
        if (!want) coolColor(c);
        sm.uniforms.uColor.value = c;
        continue;
      }
      const lm = m as T.LineBasicMaterial | T.PointsMaterial;
      if (lm.color) {
        if (!lm.userData.base) lm.userData.base = lm.color.clone();
        const c = want ? want.clone() : (lm.userData.base as T.Color).clone();
        if (!want) coolColor(c);
        lm.color.copy(c);
        const pm = m as T.PointsMaterial;
        if ((o as T.Points).isPoints) {
          // 光の粒は元の色を点ごとに持っているので、色を指定したら一色にする
          if (want && pm.vertexColors) {
            pm.userData.vc = true;
            pm.vertexColors = false;
            pm.needsUpdate = true;
          } else if (!want && pm.userData.vc) {
            pm.vertexColors = true;
            pm.needsUpdate = true;
          }
          if (pm.vertexColors && !pm.userData.cooled) {
            const attr = (o as T.Points).geometry.getAttribute("color") as T.BufferAttribute | undefined;
            if (attr) {
              for (let i = 0; i < attr.count; i++) {
                const r = attr.getX(i);
                const b = attr.getZ(i);
                if (r > b) {
                  attr.setX(i, b);
                  attr.setZ(i, r);
                }
              }
              attr.needsUpdate = true;
            }
            pm.userData.cooled = true;
          }
        }
      }
    }
  });
}

function shapeGeometry(THREE: Three, shape: Shape): T.BufferGeometry {
  switch (shape) {
    case "sphere":
      return new THREE.SphereGeometry(0.7, 40, 24);
    case "box":
      return new THREE.BoxGeometry(1.1, 1.1, 1.1);
    case "cylinder":
      return new THREE.CylinderGeometry(0.55, 0.55, 1.3, 40);
    case "cone":
      return new THREE.ConeGeometry(0.65, 1.3, 40);
    case "torus":
      return new THREE.TorusGeometry(0.6, 0.2, 20, 64);
  }
}

interface Built {
  holder: T.Group;
  dispose: () => void;
  /** 作り直しが要るかを見分ける元のデータ */
  src: SceneObject["model"] | SceneObject["asset"] | Shape | undefined;
  color: string | undefined;
}

export const KarenWorkspace = memo(function KarenWorkspace({ active, mode }: { active: boolean; mode: TransformMode }) {
  const box = useRef<HTMLDivElement>(null);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const [failed, setFailed] = useState(false);
  const scene = useScene();
  const sceneRef = useRef(scene);
  sceneRef.current = scene;
  /** シーンの一覧が変わったら 3D の中身を合わせる（three.js を読み込んだあとに入る） */
  const syncRef = useRef<(() => void) | null>(null);
  const modeApply = useRef<((m: TransformMode) => void) | null>(null);

  useEffect(() => {
    syncRef.current?.();
  }, [scene]);
  useEffect(() => {
    modeApply.current?.(mode);
  }, [mode]);

  useEffect(() => {
    const el = box.current;
    if (!el || !active) return;
    let disposed = false;
    let cleanup = () => {};
    void (async () => {
      let THREE: Three;
      let OrbitControls: typeof import("three/examples/jsm/controls/OrbitControls.js").OrbitControls;
      let TransformControls: typeof import("three/examples/jsm/controls/TransformControls.js").TransformControls;
      try {
        [THREE, { OrbitControls }, { TransformControls }] = await Promise.all([
          import("three"),
          import("three/examples/jsm/controls/OrbitControls.js"),
          import("three/examples/jsm/controls/TransformControls.js"),
        ]);
      } catch {
        if (!disposed) setFailed(true);
        return;
      }
      if (disposed) return;
      let renderer: T.WebGLRenderer;
      try {
        renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
      } catch {
        setFailed(true);
        return;
      }
      renderer.setPixelRatio(Math.min(1.5, window.devicePixelRatio || 1));
      renderer.setClearColor(0x000000, 0);
      renderer.domElement.className = "kws__canvas";
      el.appendChild(renderer.domElement);

      const scene3 = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(42, 1, 0.05, 200);
      const HOME = new THREE.Vector3(4.2, 3.0, 5.6);
      camera.position.copy(HOME);
      const orbit = new OrbitControls(camera, renderer.domElement);
      orbit.enableDamping = true;
      orbit.dampingFactor = 0.08;
      orbit.target.set(0, 0.4, 0);
      orbit.minDistance = 1.2;
      orbit.maxDistance = 40;

      // 奥行きのある床の方眼（背景の方眼と同じ青）
      const grid = new THREE.GridHelper(24, 48, 0x2ee6ff, 0x0f3d6e);
      (grid.material as T.Material).transparent = true;
      (grid.material as T.Material).opacity = 0.55;
      grid.position.y = -0.8;
      scene3.add(grid);

      const content = new THREE.Group();
      scene3.add(content);
      const time = { value: 0 };
      const built = new Map<string, Built>();
      const selBox = new THREE.BoxHelper(new THREE.Object3D(), 0x7fe9ff);
      selBox.visible = false;
      scene3.add(selBox);

      const gizmo = new TransformControls(camera, renderer.domElement);
      gizmo.setSize(0.85);
      const helper = gizmo.getHelper();
      scene3.add(helper);
      gizmo.addEventListener("dragging-changed", (e) => {
        orbit.enabled = !(e as unknown as { value: boolean }).value;
        // 離したら、動かした結果をシーンの一覧に書き戻す
        if (!(e as unknown as { value: boolean }).value) {
          const obj = gizmo.object;
          const id = obj?.userData.id as string | undefined;
          if (obj && id) {
            updateObject(id, {
              position: obj.position.toArray() as Vec3,
              rotation: [obj.rotation.x, obj.rotation.y, obj.rotation.z],
              scale: obj.scale.toArray() as Vec3,
            });
          }
        }
      });
      gizmo.addEventListener("objectChange", () => selBox.update());
      modeApply.current = (m) => gizmo.setMode(m);
      gizmo.setMode(modeRef.current);

      const place = (h: T.Group, o: SceneObject) => {
        h.position.set(...o.position);
        h.rotation.set(...o.rotation);
        h.scale.set(...o.scale);
      };

      const build = async (o: SceneObject): Promise<Built | null> => {
        const holder = new THREE.Group();
        holder.userData.id = o.id;
        let dispose = () => {};
        if (o.kind === "primitive" && o.shape) {
          const geo = shapeGeometry(THREE, o.shape);
          const face = holoMaterial(THREE, 0x2ee6ff, time, 0.9);
          const line = new THREE.LineBasicMaterial({ color: 0x2ee6ff, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false });
          holder.add(new THREE.Mesh(geo, face));
          const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 20), line);
          holder.add(edges);
          dispose = () => {
            geo.dispose();
            edges.geometry.dispose();
            face.dispose();
            line.dispose();
          };
        } else {
          try {
            const made = o.kind === "asset" && o.buffer ? await buildAsset(THREE, o.buffer, time) : o.model ? await buildModel(THREE, o.model, time) : null;
            if (!made) return null;
            // ホログラムの組み立ては直径 2.9 にそろえてあるので、ワークスペースでは扱いやすい大きさに
            made.pivot.scale.multiplyScalar(0.6);
            holder.add(made.pivot);
            dispose = () => {
              made.dispose();
              made.pivot.traverse((x) => {
                const m = x as T.Mesh;
                m.geometry?.dispose();
                for (const mat of Array.isArray(m.material) ? m.material : m.material ? [m.material] : []) mat.dispose();
              });
            };
          } catch {
            return null;
          }
        }
        paint(THREE, holder, o.color);
        place(holder, o);
        return { holder, dispose, src: o.kind === "primitive" ? o.shape : o.kind === "asset" ? o.asset : o.model, color: o.color };
      };

      const pending = new Set<string>();
      const sync = () => {
        if (disposed) return;
        const { objects, selectedId } = getScene();
        const ids = new Set(objects.map((o) => o.id));
        for (const [id, b] of built) {
          if (ids.has(id)) continue;
          if (gizmo.object === b.holder) gizmo.detach();
          content.remove(b.holder);
          b.dispose();
          built.delete(id);
        }
        for (const o of objects) {
          const b = built.get(o.id);
          const src = o.kind === "primitive" ? o.shape : o.kind === "asset" ? o.asset : o.model;
          if (b && b.src === src) {
            if (b.color !== o.color) {
              paint(THREE, b.holder, o.color);
              b.color = o.color;
            }
            // ハンドルで動かしている最中は上書きしない
            if (!(gizmo.dragging && gizmo.object === b.holder)) place(b.holder, o);
            continue;
          }
          if (pending.has(o.id)) continue;
          pending.add(o.id);
          void build(o).then((nb) => {
            pending.delete(o.id);
            if (disposed || !nb) return nb?.dispose();
            const cur = getScene().objects.find((x) => x.id === o.id);
            if (!cur) return nb.dispose();
            const old = built.get(o.id);
            if (old) {
              content.remove(old.holder);
              old.dispose();
            }
            place(nb.holder, cur);
            content.add(nb.holder);
            built.set(o.id, nb);
            sync();
          });
        }
        const sel = selectedId ? built.get(selectedId)?.holder : undefined;
        if (sel) {
          if (gizmo.object !== sel) gizmo.attach(sel);
          selBox.setFromObject(sel);
          selBox.visible = true;
        } else {
          gizmo.detach();
          selBox.visible = false;
        }
      };
      syncRef.current = sync;
      sync();

      // クリックで選ぶ（ドラッグで視点を回したときは選ばない）
      const ray = new THREE.Raycaster();
      let down: { x: number; y: number } | null = null;
      const onDown = (e: PointerEvent) => (down = { x: e.clientX, y: e.clientY });
      const onUp = (e: PointerEvent) => {
        if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5 || gizmo.dragging) return;
        down = null;
        if ((gizmo as unknown as { axis: string | null }).axis) return; // ハンドルを触った
        const r = renderer.domElement.getBoundingClientRect();
        ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
        const hits = ray.intersectObjects(content.children, true).filter((h) => (h.object as T.Mesh).isMesh);
        let o: T.Object3D | null = hits[0]?.object ?? null;
        while (o && !o.userData.id) o = o.parent;
        selectObject((o?.userData.id as string | undefined) ?? null);
      };
      renderer.domElement.addEventListener("pointerdown", onDown);
      renderer.domElement.addEventListener("pointerup", onUp);

      // 大きさ
      const fit = () => {
        const w = el.clientWidth || 1;
        const h = el.clientHeight || 1;
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
      };
      fit();
      const ro = new ResizeObserver(fit);
      ro.observe(el);

      // 視点を元に戻す
      let resets = getScene().viewResets;
      const resetCamera = () => {
        camera.position.copy(HOME);
        orbit.target.set(0, 0.4, 0);
        orbit.update();
      };

      let onScreen = true;
      const io = new IntersectionObserver(([entry]) => (onScreen = entry.isIntersecting));
      io.observe(el);
      let raf = 0;
      let last = performance.now();
      const frame = (now: number) => {
        raf = requestAnimationFrame(frame);
        if (document.hidden || !onScreen) return;
        const dt = Math.min(0.1, (now - last) / 1000);
        last = now;
        time.value += dt;
        const st = getScene();
        if (st.viewResets !== resets) {
          resets = st.viewResets;
          resetCamera();
        }
        if (st.turntable) content.rotation.y += dt * 0.5;
        orbit.update();
        if (selBox.visible) selBox.update();
        renderer.render(scene3, camera);
      };
      raf = requestAnimationFrame(frame);

      /** いまの画面を描いてすぐ、別の canvas に写す（WebGL の画面は描いたあと消えるため） */
      const snapshot = (w: number, h: number, bg = true): HTMLCanvasElement => {
        const showGizmo = helper.visible;
        helper.visible = false;
        selBox.visible = false;
        renderer.render(scene3, camera);
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        const g = c.getContext("2d")!;
        if (bg) {
          g.fillStyle = "#020a16";
          g.fillRect(0, 0, w, h);
        }
        g.drawImage(renderer.domElement, 0, 0, w, h);
        helper.visible = showGizmo;
        selBox.visible = Boolean(getScene().selectedId && built.get(getScene().selectedId!));
        return c;
      };

      registerWorkspace({
        renderPng: () =>
          new Promise((resolve) => {
            const c = snapshot(renderer.domElement.width, renderer.domElement.height);
            c.toBlob((b) => resolve(b), "image/png");
          }),
        thumbnail: () => {
          if (!built.size) return undefined;
          const w = 240;
          const h = Math.round((w * renderer.domElement.height) / Math.max(1, renderer.domElement.width));
          return snapshot(w, h).toDataURL("image/jpeg", 0.72);
        },
        exportGlb: async () => {
          const { GLTFExporter } = await import("three/examples/jsm/exporters/GLTFExporter.js");
          // 書き出し用：光る材質（専用の描き方）は他のソフトで読めないので、同じ色の標準の材質に置き換えた写しを作る
          const out = new THREE.Scene();
          for (const [id, b] of built) {
            const o = getScene().objects.find((x) => x.id === id);
            const copy = new THREE.Group();
            copy.name = o?.name ?? id;
            b.holder.updateMatrixWorld(true);
            b.holder.traverse((x) => {
              const m = x as T.Mesh;
              if (!m.isMesh) return;
              const sm = (Array.isArray(m.material) ? m.material[0] : m.material) as T.ShaderMaterial;
              const color = (sm.uniforms?.uColor?.value as T.Color | undefined) ?? new THREE.Color(o?.color ?? "#2ee6ff");
              const mesh = new THREE.Mesh(m.geometry.clone(), new THREE.MeshStandardMaterial({ color, emissive: color.clone().multiplyScalar(0.25), metalness: 0.1, roughness: 0.6 }));
              mesh.applyMatrix4(m.matrixWorld);
              copy.add(mesh);
            });
            out.add(copy);
          }
          const result = await new GLTFExporter().parseAsync(out, { binary: true });
          out.traverse((x) => {
            const m = x as T.Mesh;
            if (m.isMesh) {
              m.geometry.dispose();
              (m.material as T.Material).dispose();
            }
          });
          return result instanceof ArrayBuffer ? new Blob([result], { type: "model/gltf-binary" }) : null;
        },
      });

      cleanup = () => {
        cancelAnimationFrame(raf);
        ro.disconnect();
        io.disconnect();
        renderer.domElement.removeEventListener("pointerdown", onDown);
        renderer.domElement.removeEventListener("pointerup", onUp);
        registerWorkspace(null);
        syncRef.current = null;
        modeApply.current = null;
        gizmo.detach();
        gizmo.dispose();
        orbit.dispose();
        for (const b of built.values()) b.dispose();
        built.clear();
        grid.geometry.dispose();
        (grid.material as T.Material).dispose();
        renderer.dispose();
        renderer.domElement.remove();
      };
    })();
    return () => {
      disposed = true;
      cleanup();
    };
  }, [active]);

  return (
    <div className="kws" ref={box}>
      {failed && <p className="kws__fail">この端末では 3D ビュー（WebGL）を使えません。</p>}
    </div>
  );
});
