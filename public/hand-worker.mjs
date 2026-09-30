// 手の認識（MediaPipe Hand Landmarker）を画面とは別の作業場所で動かす。
// 画面（HandControl）からカメラの 1 コマ（ImageBitmap）を受け取り、手の 21 点を返す。
// これで認識に時間がかかっても、ホログラムの描画が止まらない。
import { FilesetResolver, HandLandmarker } from "/mediapipe/vision_bundle.mjs";

let landmarker = null;

self.onmessage = async (e) => {
  const d = e.data;
  if (d.type === "init") {
    try {
      const files = await FilesetResolver.forVisionTasks("/mediapipe", true);
      const make = (delegate) =>
        HandLandmarker.createFromOptions(files, {
          baseOptions: { modelAssetPath: d.model, delegate },
          runningMode: "VIDEO",
          numHands: 2,
        });
      landmarker = await make("GPU").catch(() => make("CPU"));
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
