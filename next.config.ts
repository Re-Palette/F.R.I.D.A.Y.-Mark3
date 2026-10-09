import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // 画面とサーバーが同じ版か見分ける（裏で開きっぱなしの古い画面が、新しいサーバーと食い違わないように）
  env: { NEXT_PUBLIC_FRIDAY_BUILD: process.env.VERCEL_GIT_COMMIT_SHA ?? "dev" },
};

export default nextConfig;
