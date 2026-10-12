"use client";

/**
 * E.D.I.T.H. の GOD'S EYE VIEW（中央のビューポート）に映すリアルタイム映像（Web カメラ・画面共有）。状態は lib/edith-feed.ts。
 *   EdithFeedView … GOD'S EYE VIEW の映像を入れる場所（.eview__slot）の中身：映像・待機画面（映像未接続）・接続中・エラー・切断
 *   EdithFeedBar  … 映像の下の操作：停止・カメラの選択・カメラ／画面の切り替え・枠の形（横長／円）・FOCUS
 * 映像はこの端末の中で映すだけ（送らない・録画しない・保存しない。会話に写真を添えることもない）。
 * カメラも画面も、ボタンを押したときにだけ開く。この画面を離れる・ページを閉じると止める。
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { edithFeed, useEdithFeed, type FeedKind, type FeedState } from "@/lib/edith-feed";
import type { FeedShape } from "@/lib/edith-display";

const PATHS: Record<string, ReactNode> = {
  camera: <><path d="M3 8h3l2-3h8l2 3h3v11H3z" /><circle cx="12" cy="13" r="3.6" /></>,
  screen: <><rect x="3" y="4" width="18" height="12" /><path d="M8 20h8M12 16v4" /></>,
  stop: <rect x="7" y="7" width="10" height="10" />,
  wide: <rect x="3" y="7" width="18" height="10" />,
  circle: <circle cx="12" cy="12" r="8" />,
  focus: <path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" />,
  retry: <path d="M4 12a8 8 0 1 0 3-6.2M4 4v4h4" />,
};
function Ic({ n, s = 14 }: { n: keyof typeof PATHS; s?: number }) {
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[n]}
    </svg>
  );
}

const KIND_LABEL: Record<FeedKind, string> = { camera: "CAMERA", screen: "SCREEN" };

/** HUD の文字（LIVE > GOD'S EYE VIEW : …・FEED: …）に使う、映像の元と状態（例：「CAMERA · FaceTime HD Camera」「未接続」） */
export function feedSummary(st: FeedState): { src: string; status: string } {
  const src = st.kind ? KIND_LABEL[st.kind] : "—";
  switch (st.status) {
    case "live":
      return { src, status: st.label ? `${src} · ${st.label}` : src };
    case "connecting":
      return { src, status: "接続中" };
    case "ended":
      return { src, status: "切断（SIGNAL LOST）" };
    case "error":
      return { src, status: "エラー" };
    default:
      return { src: "—", status: "未接続" };
  }
}

/** 映像の実際の解像度と、1 秒あたりのコマ数（測れないブラウザでは null） */
function useVideoStats(ref: React.RefObject<HTMLVideoElement | null>, live: boolean) {
  const [stats, setStats] = useState<{ w: number; h: number; fps: number | null } | null>(null);
  useEffect(() => {
    const v = ref.current;
    if (!v || !live) {
      setStats(null);
      return;
    }
    let frames = 0;
    let handle = 0;
    let stopped = false;
    // 映像の 1 コマごとに呼ばれる仕組み（無いブラウザでは FPS を「測れない」とする）
    const canCount = typeof (v as Partial<HTMLVideoElement>).requestVideoFrameCallback === "function";
    const onFrame = () => {
      frames++;
      if (!stopped) handle = v.requestVideoFrameCallback(onFrame);
    };
    if (canCount) handle = v.requestVideoFrameCallback(onFrame);
    const timer = window.setInterval(() => {
      setStats(v.videoWidth ? { w: v.videoWidth, h: v.videoHeight, fps: canCount ? frames : null } : null);
      frames = 0;
    }, 1000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      if (canCount && handle) v.cancelVideoFrameCallback(handle);
    };
  }, [ref, live]);
  return stats;
}

/** 映像を入れる場所の中身 */
export function EdithFeedView({ shape }: { shape: FeedShape }) {
  const st = useEdithFeed();
  const ref = useRef<HTMLVideoElement>(null);
  const live = st.status === "live";
  const stats = useVideoStats(ref, live);

  // 映像をつなぐ（映っていないときは外す）
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    const s = live ? edithFeed.stream() : null;
    if (v.srcObject !== s) v.srcObject = s;
    if (s) void v.play().catch(() => {});
  }, [live, st.label, st.deviceId, st.kind]);

  // この画面を離れる（E.D.I.T.H. を閉じる・設定を開く）・ページを閉じるときは、映像を止める
  useEffect(() => {
    const stop = () => edithFeed.stop();
    window.addEventListener("pagehide", stop);
    return () => {
      window.removeEventListener("pagehide", stop);
      stop();
    };
  }, []);

  const retry = () => void edithFeed.start(st.kind ?? "camera", st.kind === "camera" ? st.deviceId : null);

  return (
    <>
      {/* 映像は箱で包む：表示の効果（filter）を箱にかけ、箱ごと枠の形で切り抜く（映像に直接かけると、枠の外にはみ出して描かれることがある） */}
      <div className="efeed__media">
        <video ref={ref} className="efeed__video" data-on={live || undefined} data-fit={shape === "wide" ? "contain" : "cover"} muted playsInline aria-hidden={!live} />
      </div>
      {live && (
        <span className="efeed__badge" aria-hidden="true">
          <i className="efeed__rec" />
          {KIND_LABEL[st.kind!]}
          {stats && <b>{`${stats.w}×${stats.h}${stats.fps !== null ? `  ${stats.fps} FPS` : ""}`}</b>}
        </span>
      )}
      {st.status === "idle" && <Standby st={st} />}
      {st.status === "connecting" && (
        <div className="efeed__state" role="status">
          <span className="efeed__scan" aria-hidden="true" />
          <b>CONNECTING…</b>
          <small>{st.kind === "screen" ? "共有する画面を選んでください" : "カメラの許可を待っています"}</small>
          <button type="button" className="efeed__btn" onClick={() => edithFeed.stop()}>
            キャンセル
          </button>
        </div>
      )}
      {st.status === "ended" && (
        <div className="efeed__state" role="alert" data-tone="warn">
          <b>SIGNAL LOST</b>
          <small>映像が切れました（カメラが外れた・ほかのアプリに切り替わったなど）。</small>
          <span className="efeed__row">
            <button type="button" className="efeed__btn" onClick={retry}>
              <Ic n="retry" /> 再接続
            </button>
            <button type="button" className="efeed__btn" onClick={() => edithFeed.stop()}>
              閉じる
            </button>
          </span>
        </div>
      )}
      {st.status === "error" && st.error && (
        <div className="efeed__state" role="alert" data-tone="error">
          <b>{st.error.code === "denied" ? "ACCESS DENIED" : st.error.code === "notfound" ? "NO DEVICE" : st.error.code === "busy" ? "DEVICE BUSY" : st.error.code === "unsupported" ? "UNSUPPORTED" : "FEED ERROR"}</b>
          <small>{st.error.message}</small>
          <span className="efeed__row">
            {st.error.code !== "unsupported" && (
              <button type="button" className="efeed__btn" onClick={retry}>
                <Ic n="retry" /> もう一度
              </button>
            )}
            <button type="button" className="efeed__btn" onClick={() => edithFeed.stop()}>
              閉じる
            </button>
          </span>
        </div>
      )}
    </>
  );
}

/** 待機画面：映像の元を選んで始める（押したときにだけ開く） */
function Standby({ st }: { st: FeedState }) {
  return (
    <div className="efeed__state efeed__standby">
      <span className="eview__cross" aria-hidden="true" />
      <b>GOD&apos;S EYE VIEW</b>
      <small>映像未接続 — 映す元を選んでください</small>
      <span className="efeed__row">
        <button type="button" className="efeed__btn efeed__btn--main" disabled={Boolean(st.support.camera)} title={st.support.camera ?? "Web カメラの映像を映す（この端末の中だけ）"} onClick={() => void edithFeed.start("camera")}>
          <Ic n="camera" s={16} /> CAMERA
        </button>
        <button type="button" className="efeed__btn efeed__btn--main" disabled={Boolean(st.support.screen)} title={st.support.screen ?? "画面・ウィンドウ・タブを映す（この端末の中だけ）"} onClick={() => void edithFeed.start("screen")}>
          <Ic n="screen" s={16} /> SCREEN
        </button>
      </span>
      {(st.support.camera || st.support.screen) && <small className="efeed__note">{st.support.camera ?? st.support.screen}</small>}
      <small className="efeed__note">映像はこの端末の画面に映すだけで、送信・録画・保存はしません</small>
    </div>
  );
}

/** 映像の下の操作（映像を始めた後に出す） */
export function EdithFeedBar({ shape, onShape, focus, onFocus }: { shape: FeedShape; onShape: (s: FeedShape) => void; focus: boolean; onFocus: (v: boolean) => void }) {
  const st = useEdithFeed();
  if (st.status === "idle") return null;
  const busy = st.status === "connecting";
  return (
    <div className="efeed__bar" role="toolbar" aria-label="映像の操作">
      <button type="button" className="efeed__tool" onClick={() => edithFeed.stop()} title="映像を止める" aria-label="映像を止める">
        <Ic n="stop" />
        <span>STOP</span>
      </button>
      <button
        type="button"
        className="efeed__tool"
        data-on={st.kind === "camera" || undefined}
        aria-pressed={st.kind === "camera"}
        disabled={busy || Boolean(st.support.camera)}
        onClick={() => st.kind !== "camera" && void edithFeed.start("camera")}
        title={st.support.camera ?? "Web カメラに切り替える"}
      >
        <Ic n="camera" />
        <span>CAMERA</span>
      </button>
      {st.kind === "camera" && st.cameras.length > 1 && (
        <select
          className="efeed__select"
          value={st.deviceId ?? ""}
          disabled={busy}
          onChange={(e) => void edithFeed.start("camera", e.target.value)}
          aria-label="使うカメラ"
          title="使うカメラ"
        >
          {!st.deviceId && <option value="">—</option>}
          {st.cameras.map((c) => (
            <option key={c.deviceId} value={c.deviceId}>
              {c.label}
            </option>
          ))}
        </select>
      )}
      <button
        type="button"
        className="efeed__tool"
        data-on={st.kind === "screen" || undefined}
        aria-pressed={st.kind === "screen"}
        disabled={busy || Boolean(st.support.screen)}
        onClick={() => st.kind !== "screen" && void edithFeed.start("screen")}
        title={st.support.screen ?? "画面の共有に切り替える"}
      >
        <Ic n="screen" />
        <span>SCREEN</span>
      </button>
      <span className="efeed__sep" aria-hidden="true" />
      <span className="efeed__seg" role="radiogroup" aria-label="枠の形">
        {(["wide", "circle"] as const).map((s) => (
          <button key={s} type="button" role="radio" aria-checked={shape === s} data-on={shape === s || undefined} onClick={() => onShape(s)} title={s === "wide" ? "横長（16:9）で映す" : "円で映す"}>
            <Ic n={s} />
            <span>{s === "wide" ? "16:9" : "CIRCLE"}</span>
          </button>
        ))}
      </span>
      <button type="button" className="efeed__tool" data-on={focus || undefined} aria-pressed={focus} onClick={() => onFocus(!focus)} title={focus ? "左右のパネルを戻す（Esc）" : "左右のパネルを隠して、映像を大きく見る"}>
        <Ic n="focus" />
        <span>FOCUS</span>
      </button>
    </div>
  );
}
