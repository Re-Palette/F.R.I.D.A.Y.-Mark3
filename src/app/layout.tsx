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

export const metadata: Metadata = {
  title: "F.R.I.D.A.Y. Mark3",
  description: "Personal AI Operating System — F.R.I.D.A.Y. Mark3",
};

export const viewport: Viewport = {
  themeColor: "#050608",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
