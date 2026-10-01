"use client";

/**
 * カメラの小窓（オンの間だけ）。写っているものを見せながら話しかけると、その瞬間の 1 枚が会話に添えられる。
 */
import { useEffect, useRef } from "react";
import { cameraStream, closeCamera, dismissCameraError, useCameraState } from "@/lib/camera";
import { Icon } from "./icons";

export function CameraView() {
  const cam = useCameraState();
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    v.srcObject = cam.ready ? cameraStream() : null;
    if (cam.ready) void v.play().catch(() => {});
  }, [cam.ready, cam.on]);

  // 画面を閉じるときはカメラも止める
  useEffect(() => {
    const stop = () => closeCamera();
    window.addEventListener("pagehide", stop);
    return () => window.removeEventListener("pagehide", stop);
  }, []);

  if (cam.error) {
    return (
      <div className="camview camview--error" role="alert">
        <Icon name="camera" size={14} />
        <span>{cam.error}</span>
        <button type="button" onClick={dismissCameraError} aria-label="閉じる">
          ×
        </button>
      </div>
    );
  }
  if (!cam.on) return null;
  return (
    <section className="camview" aria-label="カメラ">
      <header className="camview__head">
        <i className="camview__led" data-live={cam.ready || undefined} />
        CAMERA <b>{cam.ready ? "LIVE" : "STARTING"}</b>
        <button type="button" onClick={closeCamera} aria-label="カメラを閉じる" title="カメラを閉じる">
          ×
        </button>
      </header>
      <video ref={ref} className="camview__video" muted playsInline />
      <p className="camview__hint">見せながら話しかけると、その瞬間の 1 枚を F.R.I.D.A.Y. に見せます</p>
    </section>
  );
}
