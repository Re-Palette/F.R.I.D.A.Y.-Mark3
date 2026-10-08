/**
 * Service Worker（public/sw.js）を登録する。オンラインで一度開いた F.R.I.D.A.Y. の画面を端末に控え、
 * ネットが切れていてもインストールしたアプリから開けるようにする（プッシュ通知と同じ sw.js）。
 * 開発中（next dev）は控えが邪魔になるので登録しない。
 */
export function registerOfflineShell(): void {
  if (process.env.NODE_ENV !== "production" || typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  // sw.js 自体はブラウザの HTTP キャッシュを使わず毎回確かめる（新しい版にすぐ切り替わるように）
  void navigator.serviceWorker
    .register("/sw.js", { updateViaCache: "none" })
    .then(() => navigator.serviceWorker.ready)
    .then((reg) => {
      // Service Worker が入る前に読み込んだ JS・CSS・フォントも控えてもらう
      const urls = performance
        .getEntriesByType("resource")
        .map((e) => e.name)
        .filter((u) => u.startsWith(location.origin) && !u.includes("/api/"));
      reg.active?.postMessage({ type: "precache", urls });
    })
    .catch(() => {});
}
