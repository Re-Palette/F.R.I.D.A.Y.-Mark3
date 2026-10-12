import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // 画面とサーバーが同じ版か見分ける（裏で開きっぱなしの古い画面が、新しいサーバーと食い違わないように）
  env: { NEXT_PUBLIC_FRIDAY_BUILD: process.env.VERCEL_GIT_COMMIT_SHA ?? "dev" },
  // satellite.js の WASM（複数スレッド版）は自分自身を Worker として読み込むため、Turbopack のビルドが止まる。
  // 地球儀は通常の計算（JS 版）だけを使うので、空の部品に置き換える
  turbopack: { resolveAlias: { "#wasm-multi-thread": "./src/lib/earth/no-wasm.ts" } },
};

export default nextConfig;
