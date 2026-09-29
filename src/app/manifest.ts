/**
 * /manifest.webmanifest — スマホの「ホーム画面に追加」で、アプリのように全画面で開けるようにする。
 */
import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "F.R.I.D.A.Y. Mark3",
    short_name: "FRIDAY",
    description: "Personal AI Operating System — F.R.I.D.A.Y. Mark3",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "any",
    background_color: "#040506",
    theme_color: "#050608",
    lang: "ja",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
