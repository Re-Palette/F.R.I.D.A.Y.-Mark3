/**
 * E.D.I.T.H. の中央の映像（edith-feed.ts）のテスト。偽のカメラ・画面共有（mediaDevices）だけで確かめる。通信はしない。
 *   npm test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { createEdithFeed, cameraError, isScreenCancel } = await import("../src/lib/edith-feed");
const camera = await import("../src/lib/camera");

/* ---------- 偽の映像 ---------- */

class FakeTrack {
  stopped = false;
  private ended: (() => void)[] = [];
  constructor(public label: string, private deviceId = "") {}
  stop() {
    this.stopped = true;
  }
  addEventListener(type: string, fn: () => void) {
    if (type === "ended") this.ended.push(fn);
  }
  getSettings() {
    return { deviceId: this.deviceId };
  }
  /** カメラが外れた・ブラウザの「共有を停止」 */
  end() {
    this.stopped = true;
    this.ended.forEach((f) => f());
  }
}
class FakeStream {
  constructor(public track: FakeTrack) {}
  getTracks() {
    return [this.track];
  }
  getVideoTracks() {
    return [this.track];
  }
}

const named = (name: string) => Object.assign(new Error(name), { name });

/** 呼ばれた回数と引数を覚え、結果を後から決められる偽の mediaDevices */
function fakeMedia(o: { userMedia?: boolean; displayMedia?: boolean; secure?: boolean } = {}) {
  const calls = { user: [] as MediaStreamConstraints[], display: 0, enumerate: 0 };
  const pending: { resolve: (s: FakeStream) => void; reject: (e: Error) => void }[] = [];
  const streams: FakeStream[] = [];
  const listeners = new Map<string, () => void>();
  let devices: { kind: string; deviceId: string; label: string }[] = [
    { kind: "videoinput", deviceId: "cam-a", label: "" },
    { kind: "audioinput", deviceId: "mic", label: "" },
  ];
  const next = () =>
    new Promise<FakeStream>((resolve, reject) => {
      pending.push({ resolve, reject });
    });
  const media = {
    ...(o.userMedia === false
      ? {}
      : {
          getUserMedia: (c: MediaStreamConstraints) => {
            calls.user.push(c);
            return next() as unknown as Promise<MediaStream>;
          },
        }),
    ...(o.displayMedia === false
      ? {}
      : {
          getDisplayMedia: () => {
            calls.display++;
            return next() as unknown as Promise<MediaStream>;
          },
        }),
    enumerateDevices: async () => {
      calls.enumerate++;
      return devices as unknown as MediaDeviceInfo[];
    },
    addEventListener: (t: string, f: () => void) => void listeners.set(t, f),
    removeEventListener: (t: string) => void listeners.delete(t),
  };
  const feed = createEdithFeed({ media: () => media, secure: () => o.secure ?? true });
  return {
    feed,
    calls,
    listeners,
    setDevices: (d: typeof devices) => (devices = d),
    /** 最も古い「開いている途中」を成功させる */
    grant(label = "FaceTime HD Camera", deviceId = "cam-a") {
      const s = new FakeStream(new FakeTrack(label, deviceId));
      streams.push(s);
      pending.shift()!.resolve(s);
      return s;
    },
    fail(name: string) {
      pending.shift()!.reject(named(name));
    },
    get pending() {
      return pending.length;
    },
  };
}

const tick = () => new Promise((r) => setImmediate(r));

/* ---------- 1. 自動では始めない ---------- */

describe("自動では始めない", () => {
  it("作る・状態を読む・購読するだけでは、カメラも画面も開かない", async () => {
    const f = fakeMedia();
    const st = f.feed.getState();
    const off = f.feed.subscribe(() => {});
    await tick();
    assert.equal(st.status, "idle");
    assert.equal(f.calls.user.length, 0);
    assert.equal(f.calls.display, 0);
    assert.equal(f.calls.enumerate, 0, "カメラの一覧も、許可の前には読まない");
    assert.equal(f.feed.stream(), null);
    off();
  });

  it("購読をやめたら、カメラの抜き差しの見張りもやめる", () => {
    const f = fakeMedia();
    const off = f.feed.subscribe(() => {});
    assert.ok(f.listeners.has("devicechange"));
    off();
    assert.equal(f.listeners.has("devicechange"), false);
  });
});

/* ---------- 2. 開く・止める ---------- */

describe("カメラを開く・止める", () => {
  it("開いている途中は connecting、許可されたら live。映像の名前とカメラが分かる。許可の後にカメラの一覧を読む", async () => {
    const f = fakeMedia();
    const p = f.feed.start("camera");
    assert.equal(f.feed.getState().status, "connecting");
    assert.equal(f.calls.user[0].audio, false, "音は取らない");
    const s = f.grant("FaceTime HD Camera", "cam-a");
    await p;
    await tick();
    const st = f.feed.getState();
    assert.equal(st.status, "live");
    assert.equal(st.kind, "camera");
    assert.equal(st.label, "FaceTime HD Camera");
    assert.equal(st.deviceId, "cam-a");
    assert.equal(f.feed.stream(), s);
    assert.deepEqual(st.cameras, [{ deviceId: "cam-a", label: "カメラ 1" }]);
  });

  it("止めたら、映像をすべて止めて待機に戻す", async () => {
    const f = fakeMedia();
    const p = f.feed.start("camera");
    const s = f.grant();
    await p;
    f.feed.stop();
    assert.equal(s.track.stopped, true);
    assert.equal(f.feed.getState().status, "idle");
    assert.equal(f.feed.stream(), null);
  });

  it("選んだカメラで開く（deviceId を exact で指定）", async () => {
    const f = fakeMedia();
    const p = f.feed.start("camera", "cam-b");
    f.grant("USB Camera", "cam-b");
    await p;
    const v = f.calls.user[0].video as MediaTrackConstraints;
    assert.deepEqual(v.deviceId, { exact: "cam-b" });
    assert.equal(f.feed.getState().deviceId, "cam-b");
  });

  it("選んだカメラが無くなっていたら（OverconstrainedError）、ほかのカメラで開き直す", async () => {
    const f = fakeMedia();
    const p = f.feed.start("camera", "gone");
    f.fail("OverconstrainedError");
    await tick();
    assert.equal(f.calls.user.length, 2);
    assert.equal((f.calls.user[1].video as MediaTrackConstraints).deviceId, undefined);
    f.grant("FaceTime HD Camera", "cam-a");
    await p;
    assert.equal(f.feed.getState().status, "live");
  });
});

/* ---------- 3. 途中で止める・切り替える ---------- */

describe("始めている途中で止める・切り替える", () => {
  it("開いている途中で止めたら、あとから届いた映像もすぐ止める（表示は待機のまま）", async () => {
    const f = fakeMedia();
    const p = f.feed.start("camera");
    f.feed.stop();
    assert.equal(f.feed.getState().status, "idle");
    const late = f.grant();
    await p;
    assert.equal(late.track.stopped, true);
    assert.equal(f.feed.getState().status, "idle");
    assert.equal(f.feed.stream(), null);
  });

  it("開いている途中で止めた後に失敗が届いても、エラーを出さない", async () => {
    const f = fakeMedia();
    const p = f.feed.start("camera");
    f.feed.stop();
    f.fail("NotAllowedError");
    await p;
    assert.equal(f.feed.getState().status, "idle");
    assert.equal(f.feed.getState().error, null);
  });

  it("カメラから画面に切り替えたら、先にカメラの映像を止めてから開く", async () => {
    const f = fakeMedia();
    const p1 = f.feed.start("camera");
    const cam = f.grant();
    await p1;
    const p2 = f.feed.start("screen");
    assert.equal(cam.track.stopped, true, "画面を選んでいる間にカメラを使い続けない");
    const scr = f.grant("screen:1", "");
    await p2;
    assert.equal(f.feed.getState().kind, "screen");
    assert.equal(f.feed.getState().status, "live");
    assert.equal(f.feed.stream(), scr);
  });

  it("開いている途中に別の映像を始めたら、先に届いた古い映像は止め、新しい映像だけ映す", async () => {
    const f = fakeMedia();
    const p1 = f.feed.start("camera", "cam-a");
    const p2 = f.feed.start("camera", "cam-b");
    const first = f.grant("A", "cam-a");
    const second = f.grant("B", "cam-b");
    await Promise.all([p1, p2]);
    assert.equal(first.track.stopped, true);
    assert.equal(second.track.stopped, false);
    assert.equal(f.feed.stream(), second);
    assert.equal(f.feed.getState().label, "B");
  });
});

/* ---------- 4. 切断 ---------- */

describe("映像が切れたとき", () => {
  it("カメラが外れた（track の ended）→ ended（SIGNAL LOST）。映像は手放す", async () => {
    const f = fakeMedia();
    const p = f.feed.start("camera");
    const s = f.grant();
    await p;
    s.track.end();
    assert.equal(f.feed.getState().status, "ended");
    assert.equal(f.feed.stream(), null);
  });

  it("画面共有をブラウザの「共有を停止」で止めた → 待機に戻す（エラーにしない）", async () => {
    const f = fakeMedia();
    const p = f.feed.start("screen");
    const s = f.grant("screen:1", "");
    await p;
    s.track.end();
    assert.equal(f.feed.getState().status, "idle");
    assert.equal(f.feed.getState().error, null);
  });

  it("切り替えた後に、古い映像の ended が来ても、新しい映像には影響しない", async () => {
    const f = fakeMedia();
    const p1 = f.feed.start("camera");
    const old = f.grant();
    await p1;
    const p2 = f.feed.start("camera", "cam-b");
    const now = f.grant("B", "cam-b");
    await p2;
    old.track.end();
    assert.equal(f.feed.getState().status, "live");
    assert.equal(f.feed.stream(), now);
  });

  it("カメラの抜き差し（devicechange）で、カメラの一覧を読み直す", async () => {
    const f = fakeMedia();
    const off = f.feed.subscribe(() => {});
    f.setDevices([
      { kind: "videoinput", deviceId: "cam-a", label: "A" },
      { kind: "videoinput", deviceId: "cam-b", label: "B" },
    ]);
    f.listeners.get("devicechange")!();
    await tick();
    assert.deepEqual(f.feed.getState().cameras.map((c) => c.label), ["A", "B"]);
    off();
  });
});

/* ---------- 5. エラー ---------- */

describe("開けなかったとき", () => {
  for (const [name, code] of [
    ["NotAllowedError", "denied"],
    ["NotFoundError", "notfound"],
    ["NotReadableError", "busy"],
    ["TypeError", "failed"],
  ] as const) {
    it(`カメラ：${name} → ${code}（画面に理由を出す）`, async () => {
      const f = fakeMedia();
      const p = f.feed.start("camera");
      f.fail(name);
      await p;
      const st = f.feed.getState();
      assert.equal(st.status, "error");
      assert.equal(st.error?.code, code);
      assert.ok(st.error?.message);
      assert.equal(f.feed.stream(), null);
    });
  }

  it("画面の共有で、選ぶ画面をキャンセル（NotAllowedError・AbortError）→ エラーにせず待機に戻す", async () => {
    for (const name of ["NotAllowedError", "AbortError"]) {
      const f = fakeMedia();
      const p = f.feed.start("screen");
      f.fail(name);
      await p;
      assert.equal(f.feed.getState().status, "idle", name);
      assert.equal(f.feed.getState().error, null, name);
    }
  });

  it("画面の共有のそのほかの失敗 → error", async () => {
    const f = fakeMedia();
    const p = f.feed.start("screen");
    f.fail("NotReadableError");
    await p;
    assert.equal(f.feed.getState().status, "error");
    assert.equal(f.feed.getState().error?.code, "failed");
  });

  it("エラーの後に止めると、待機に戻ってエラーの表示も消える", async () => {
    const f = fakeMedia();
    const p = f.feed.start("camera");
    f.fail("NotFoundError");
    await p;
    f.feed.stop();
    assert.equal(f.feed.getState().status, "idle");
    assert.equal(f.feed.getState().error, null);
  });

  it("理由の分け方（cameraError・isScreenCancel）", () => {
    assert.equal(cameraError(named("SecurityError")).code, "denied");
    assert.equal(cameraError(named("TrackStartError")).code, "busy");
    assert.equal(cameraError(null).code, "failed");
    assert.equal(isScreenCancel(named("AbortError")), true);
    assert.equal(isScreenCancel(named("NotFoundError")), false);
  });
});

/* ---------- 6. 使えない機能 ---------- */

describe("このブラウザで使えない機能", () => {
  it("画面の共有に対応していない（スマホなど）→ 理由を返し、押しても開かない", async () => {
    const f = fakeMedia({ displayMedia: false });
    assert.match(f.feed.getState().support.screen ?? "", /対応していません/);
    assert.equal(f.feed.getState().support.camera, null);
    await f.feed.start("screen");
    assert.equal(f.feed.getState().status, "error");
    assert.equal(f.feed.getState().error?.code, "unsupported");
    assert.equal(f.pending, 0);
  });

  it("HTTPS でない（mediaDevices が無い）→ どちらも理由を返す", () => {
    const feed = createEdithFeed({ media: () => undefined, secure: () => false });
    const s = feed.getState().support;
    assert.match(s.camera ?? "", /HTTPS/);
    assert.match(s.screen ?? "", /HTTPS/);
  });
});

/* ---------- 7. F.R.I.D.A.Y. のカメラ（会話に写真を添える）とは別 ---------- */

describe("F.R.I.D.A.Y. のカメラとは別（中央の映像は会話に写真を添えない）", () => {
  it("中央の映像を映しても、camera.ts の状態はオフのまま（会話の送信で写真が添えられない）", async () => {
    const f = fakeMedia();
    const p = f.feed.start("camera");
    f.grant();
    await p;
    assert.equal(f.feed.getState().status, "live");
    assert.equal(camera.getCameraState().on, false);
    assert.equal(camera.cameraStream(), null);
  });

  it("edith-feed.ts は camera.ts・screen.ts・会話の送信を読み込まない", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../src/lib/edith-feed.ts", import.meta.url), "utf8");
    const imports = src.split("\n").filter((l) => /^import /.test(l));
    assert.deepEqual(imports, ['import { useSyncExternalStore } from "react";'], "React 以外は読み込まない");
    assert.doesNotMatch(src, /fetch\(|XMLHttpRequest|WebSocket|MediaRecorder|localStorage|indexedDB/, "送らない・録画しない・保存しない");
  });
});
