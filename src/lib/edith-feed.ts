/**
 * E.D.I.T.H. の中央に映すリアルタイム映像（Web カメラ・画面共有）。
 *   - 映すだけ：この端末の中で表示するだけで、送らない・録画しない・保存しない。
 *     F.R.I.D.A.Y. の「カメラで見せて聞く」（camera.ts）とは別の映像で、会話に写真を添えることもない
 *   - ボタンを押したときにだけ始める（読み込んだだけ・購読しただけでは、カメラにも画面にも触れない）
 *   - 始めている途中で止められたら、あとから届いた映像もすぐ止める。切り替えるときは、前の映像を先に止める
 *   - カメラが外れたら「切断」（ended）。画面共有をブラウザの「共有を停止」で止めたら、待機に戻る
 * テストでは、mediaDevices などを差し替えた createEdithFeed を使う。
 */
import { useSyncExternalStore } from "react";

export type FeedKind = "camera" | "screen";
/** idle：待機 ／ connecting：開いている途中 ／ live：映っている ／ ended：映像が切れた（カメラが外れたなど） ／ error：開けなかった */
export type FeedStatus = "idle" | "connecting" | "live" | "ended" | "error";
export type FeedErrorCode = "denied" | "notfound" | "busy" | "unsupported" | "failed";

export interface FeedCamera {
  deviceId: string;
  label: string;
}

export interface FeedState {
  status: FeedStatus;
  /** いま（または最後に）映していた・開こうとした映像の種類 */
  kind: FeedKind | null;
  /** 使っているカメラ（カメラのときだけ。分からなければ null） */
  deviceId: string | null;
  /** 映像の名前（カメラの名前・共有した画面の名前。分からなければ null） */
  label: string | null;
  error: { code: FeedErrorCode; message: string } | null;
  /** 選べるカメラ（名前は、カメラを一度許可するまで「カメラ 1」などになる） */
  cameras: FeedCamera[];
  /** このブラウザで使えるか。使えないときは、理由（画面に出す文） */
  support: { camera: string | null; screen: string | null };
}

/** 差し替えられる部分（テスト用）。既定はブラウザの navigator.mediaDevices */
export interface FeedMedia {
  getUserMedia?: (c: MediaStreamConstraints) => Promise<MediaStream>;
  getDisplayMedia?: (c?: DisplayMediaStreamOptions) => Promise<MediaStream>;
  enumerateDevices?: () => Promise<MediaDeviceInfo[]>;
  addEventListener?: (type: "devicechange", fn: () => void) => void;
  removeEventListener?: (type: "devicechange", fn: () => void) => void;
}
export interface FeedEnv {
  media: () => FeedMedia | undefined;
  /** HTTPS（または localhost）で開いているか */
  secure: () => boolean;
}

const browserEnv: FeedEnv = {
  // getUserMedia などは mediaDevices から呼ぶ（取り出して呼ぶと失敗するブラウザがあるので bind する）
  media: () => {
    const m = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
    if (!m) return undefined;
    return {
      getUserMedia: m.getUserMedia ? (c) => m.getUserMedia(c) : undefined,
      getDisplayMedia: m.getDisplayMedia ? (c) => m.getDisplayMedia(c) : undefined,
      enumerateDevices: m.enumerateDevices ? () => m.enumerateDevices() : undefined,
      addEventListener: (t, fn) => m.addEventListener(t, fn),
      removeEventListener: (t, fn) => m.removeEventListener(t, fn),
    };
  },
  secure: () => typeof window === "undefined" || window.isSecureContext !== false,
};

const MSG = {
  denied: "カメラの使用が許可されていません。アドレスバーのカメラのマークから許可して、もう一度押してください。",
  notfound: "カメラが見つかりませんでした。カメラをつないでから、もう一度押してください。",
  busy: "カメラを開けませんでした。ほかのアプリ（または F.R.I.D.A.Y. のカメラ・手の操作）が使っていないか確かめてください。",
  screenFailed: "画面を共有できませんでした。",
  failed: "映像を開けませんでした。",
  insecure: "安全な接続（HTTPS）で開いたときだけ使えます。",
  noCamera: "このブラウザはカメラに対応していません。",
  noScreen: "このブラウザは画面の共有に対応していません（パソコンの Chrome / Edge などで使えます）。",
} as const;

const errName = (err: unknown) => (err && typeof err === "object" && "name" in err ? String((err as { name: unknown }).name) : "");

/** カメラを開けなかった理由を分ける */
export function cameraError(err: unknown): { code: FeedErrorCode; message: string } {
  const n = errName(err);
  if (n === "NotAllowedError" || n === "PermissionDeniedError" || n === "SecurityError") return { code: "denied", message: MSG.denied };
  if (n === "NotFoundError" || n === "DevicesNotFoundError" || n === "OverconstrainedError") return { code: "notfound", message: MSG.notfound };
  if (n === "NotReadableError" || n === "TrackStartError" || n === "AbortError") return { code: "busy", message: MSG.busy };
  return { code: "failed", message: MSG.failed };
}

/** 画面の共有で、選ぶ画面でのキャンセル（エラーにしない）か */
export function isScreenCancel(err: unknown): boolean {
  const n = errName(err);
  return n === "NotAllowedError" || n === "AbortError" || n === "PermissionDeniedError";
}

const stopAll = (s: MediaStream | null) => s?.getTracks().forEach((t) => t.stop());

export function createEdithFeed(env: FeedEnv = browserEnv) {
  const support = (): FeedState["support"] => {
    const m = env.media();
    const insecure = !env.secure();
    return {
      camera: m?.getUserMedia ? null : insecure ? MSG.insecure : MSG.noCamera,
      screen: m?.getDisplayMedia ? null : insecure ? MSG.insecure : MSG.noScreen,
    };
  };
  let state: FeedState = { status: "idle", kind: null, deviceId: null, label: null, error: null, cameras: [], support: { camera: null, screen: null } };
  let supportChecked = false;
  let stream: MediaStream | null = null;
  /** 開くたびに増やす番号（止めた・別の映像を開いた後に届いた映像を見分ける） */
  let seq = 0;
  const listeners = new Set<() => void>();
  let watching = false;

  const set = (next: Partial<FeedState>) => {
    state = { ...state, ...next };
    listeners.forEach((l) => l());
  };

  function getState(): FeedState {
    if (!supportChecked) {
      // 使えるかは、ブラウザで初めて読まれたときに調べる（カメラは開かない）
      supportChecked = true;
      state = { ...state, support: support() };
    }
    return state;
  }

  /** 選べるカメラを読み直す（名前を読むだけで、カメラは開かない） */
  async function refreshCameras(): Promise<void> {
    const m = env.media();
    if (!m?.enumerateDevices) return;
    try {
      const list = await m.enumerateDevices();
      const cams = list.filter((d) => d.kind === "videoinput").map((d, i) => ({ deviceId: d.deviceId, label: d.label || `カメラ ${i + 1}` }));
      set({ cameras: cams });
    } catch {
      /* 読めなければ、前の一覧のまま */
    }
  }

  const onDeviceChange = () => void refreshCameras();

  function subscribe(fn: () => void): () => void {
    listeners.add(fn);
    if (!watching) {
      const m = env.media();
      if (m?.addEventListener) {
        m.addEventListener("devicechange", onDeviceChange);
        watching = true;
      }
    }
    return () => {
      listeners.delete(fn);
      if (!listeners.size && watching) {
        env.media()?.removeEventListener?.("devicechange", onDeviceChange);
        watching = false;
      }
    };
  }

  /** いまの映像を止めて手放す（状態は変えない） */
  function release() {
    stopAll(stream);
    stream = null;
  }

  /** 映像を止めて待機に戻す（始めている途中なら、あとから届いた映像も止める） */
  function stop(): void {
    seq++;
    release();
    if (state.status !== "idle" || state.error) set({ status: "idle", error: null });
  }

  /**
   * 映像を始める（ボタンを押したときに呼ぶ）。いま映している映像は、先に止めてから開く
   * （同じカメラを別の設定で開き直すと失敗する機種があるため）。
   */
  async function start(kind: FeedKind, deviceId?: string | null): Promise<void> {
    const sup = getState().support;
    const my = ++seq;
    release();
    const reason = kind === "camera" ? sup.camera : sup.screen;
    if (reason) {
      set({ status: "error", kind, deviceId: null, label: null, error: { code: "unsupported", message: reason } });
      return;
    }
    set({ status: "connecting", kind, deviceId: kind === "camera" ? (deviceId ?? null) : null, label: null, error: null });
    const m = env.media()!;
    let s: MediaStream;
    try {
      if (kind === "camera") {
        const video: MediaTrackConstraints = { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } };
        try {
          s = await m.getUserMedia!({ video: deviceId ? { ...video, deviceId: { exact: deviceId } } : { ...video, facingMode: { ideal: "user" } }, audio: false });
        } catch (err) {
          // 選んだカメラが無くなっていたら、ほかのカメラで開き直す
          if (!deviceId || errName(err) !== "OverconstrainedError" || my !== seq) throw err;
          s = await m.getUserMedia!({ video, audio: false });
        }
      } else {
        s = await m.getDisplayMedia!({ video: { frameRate: { ideal: 30 } }, audio: false });
      }
    } catch (err) {
      if (my !== seq) return; // 止められた・別の映像を開いた：何も表示を変えない
      if (kind === "screen" && isScreenCancel(err)) {
        set({ status: "idle", error: null });
        return;
      }
      set({ status: "error", error: kind === "camera" ? cameraError(err) : { code: "failed", message: MSG.screenFailed } });
      return;
    }
    if (my !== seq) {
      // 開いている間に止められた・別の映像に切り替えられた：遅れて届いた映像はすぐ止める
      stopAll(s);
      return;
    }
    stream = s;
    const track = s.getVideoTracks()[0];
    track?.addEventListener("ended", () => {
      if (stream !== s || my !== seq) return;
      release();
      // 画面共有をブラウザの「共有を停止」で止めた：待機に戻す。カメラが外れた：切断として知らせる
      set(kind === "screen" ? { status: "idle", error: null } : { status: "ended", error: null });
    });
    set({ status: "live", deviceId: kind === "camera" ? (track?.getSettings?.().deviceId ?? deviceId ?? null) : null, label: track?.label || null });
    // 許可された後は、カメラの名前が読めるようになる
    if (kind === "camera") void refreshCameras();
  }

  return {
    getState,
    subscribe,
    start,
    stop,
    refreshCameras,
    /** いま映している映像（映していなければ null） */
    stream: () => stream,
  };
}

export type EdithFeed = ReturnType<typeof createEdithFeed>;

/** 画面で使う 1 つだけの映像 */
export const edithFeed = createEdithFeed();

/** サーバーで描くときの状態（ブラウザの機能は調べない） */
const SERVER_STATE: FeedState = { status: "idle", kind: null, deviceId: null, label: null, error: null, cameras: [], support: { camera: null, screen: null } };
const serverState = () => SERVER_STATE;

export function useEdithFeed(feed: EdithFeed = edithFeed): FeedState {
  return useSyncExternalStore(feed.subscribe, feed.getState, serverState);
}
