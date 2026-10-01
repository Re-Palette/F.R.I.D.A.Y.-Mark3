// 手の認識（MediaPipe Hand Landmarker）を画面とは別の作業場所で動かす。
// 画面（HandControl）からカメラの 1 コマ（ImageBitmap）を受け取り、手の 21 点を返す。
// これで認識に時間がかかっても、ホログラムの描画が止まらない。
//
// 速く・軽くするために：
//   - 認識は CPU で行う（GPU はホログラムの描画に使っているので、取り合ってカクつかないように）。
//     CPU で準備できないときだけ GPU を使う。
//   - モデル（約 8MB）はブラウザの保存領域（Cache Storage）に入れておき、2 回目からは読み込まない。
import { FilesetResolver, HandLandmarker } from "/mediapipe/vision_bundle.mjs";

const CACHE = "friday-hand-v1";
let landmarker = null;

/** モデルを保存領域から（無ければ取りに行って保存してから）読み込む */
async function loadModel(url) {
  try {
    const cache = await caches.open(CACHE);
    let res = await cache.match(url);
    if (!res) {
      res = await fetch(url);
      if (!res.ok) throw new Error(`model ${res.status}`);
      await cache.put(url, res.clone()).catch(() => {});
    }
    return new Uint8Array(await res.arrayBuffer());
  } catch {
    // 保存領域が使えない環境では、毎回取りに行く
    const res = await fetch(url);
    return new Uint8Array(await res.arrayBuffer());
  }
}

self.onmessage = async (e) => {
  const d = e.data;
  if (d.type === "init") {
    try {
      const [files, model] = await Promise.all([FilesetResolver.forVisionTasks("/mediapipe", true), loadModel(d.model)]);
      const make = (delegate) =>
        HandLandmarker.createFromOptions(files, {
          baseOptions: { modelAssetBuffer: model, delegate },
          runningMode: "VIDEO",
          numHands: 2,
        });
      landmarker = await make("CPU").catch(() => make("GPU"));
      self.postMessage({ type: "ready" });
    } catch (err) {
      self.postMessage({ type: "error", message: String(err && err.message ? err.message : err) });
    }
  } else if (d.type === "frame") {
    const bitmap = d.bitmap;
    if (!landmarker) {
      bitmap.close();
      self.postMessage({ type: "result", landmarks: [] });
      return;
    }
    let landmarks = [];
    try {
      landmarks = landmarker.detectForVideo(bitmap, d.time).landmarks.map((h) => h.map((p) => ({ x: p.x, y: p.y })));
    } catch {
      /* 1 コマ失敗しても続ける */
    }
    bitmap.close();
    self.postMessage({ type: "result", landmarks });
  } else if (d.type === "close") {
    landmarker?.close();
    landmarker = null;
    self.close();
  }
};
