// F.R.I.D.A.Y. の画面と拡張機能の橋渡し。画面からの依頼（window.postMessage）を受けて、裏方（background.js）に渡す。
// 入っていることを F.R.I.D.A.Y. の画面に知らせる印
document.documentElement.dataset.fridayTabs = chrome.runtime.getManifest().version;

window.addEventListener("message", (event) => {
  if (event.source !== window || event.origin !== location.origin) return;
  const msg = event.data;
  if (!msg || msg.source !== "friday" || typeof msg.id !== "string") return;
  // 渡すのは決まった項目だけ（開く・閉じる・音楽の操作）
  const { type, url, target, action, query, value } = msg;
  chrome.runtime.sendMessage({ type, url, target, action, query, value }, (res) => {
    const error = chrome.runtime.lastError?.message;
    window.postMessage({ source: "friday-ext", id: msg.id, ...(res || {}), ...(error ? { ok: false, error } : {}) }, location.origin);
  });
});
