import type { Metadata, Viewport } from "next";
// フォントはローカル同梱（外部CDNに依存しない）
import "@fontsource/michroma/latin-400.css";
import "@fontsource/share-tech-mono/latin-400.css";
import "@fontsource/orbitron/latin-400.css";
import "@fontsource/orbitron/latin-500.css";
import "@fontsource/orbitron/latin-700.css";
import "@fontsource/rajdhani/latin-400.css";
import "@fontsource/rajdhani/latin-500.css";
import "@fontsource/rajdhani/latin-600.css";
import "@fontsource/rajdhani/latin-700.css";
import "./globals.css";
import "./home.css";
import "./karen.css";

export const metadata: Metadata = {
  title: "F.R.I.D.A.Y. Mark3",
  description: "Personal AI Operating System — F.R.I.D.A.Y. Mark3",
  // スマホのホーム画面に追加したとき、アプリのように全画面で開く
  appleWebApp: { capable: true, title: "FRIDAY", statusBarStyle: "black-translucent" },
  icons: {
    icon: [{ url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180" }],
  },
};

export const viewport: Viewport = {
  themeColor: "#050608",
  width: "device-width",
  initialScale: 1,
  // 入力欄にフォーカスしたときに勝手に拡大しない・ノッチの裏まで使う
  maximumScale: 1,
  viewportFit: "cover",
};

/**
 * 画面に合わせた全体の縮小率。ノート PC でもモニターと同じ配置のまま、比率を保って縮める。
 * 基準サイズ（1600×880）より小さい画面だけ縮小し、幅 1000px 未満（タブレット・スマホ）は縮めずに並べ替える。
 * 描画前に実行して、ちらつきを防ぐ。
 */
const UI_SCALE_SCRIPT = `(function(){
  function fit(){
    var w = window.innerWidth, h = window.innerHeight;
    var z = w < 1000 ? 1 : Math.max(0.6, Math.min(1, w / 1600, h / 880));
    document.documentElement.style.setProperty("--ui-zoom", String(z));
  }
  fit();
  window.addEventListener("resize", fit);
})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: UI_SCALE_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
