// Amazon Music の Web プレーヤー（music.amazon.co.jp / .com）の中で、ページより先に動く。
// Amazon Music はキーボードのメディアキー用に「再生・一時停止・次の曲・前の曲」の処理を登録する（Media Session）。
// その処理を F.R.I.D.A.Y. からも呼べるよう、登録された処理を控えておくだけ（ページの動きは変えない）。
(() => {
  const ms = navigator.mediaSession;
  if (!ms || window.__fridayMedia) return;
  const handlers = {};
  window.__fridayMedia = handlers;
  const original = ms.setActionHandler.bind(ms);
  ms.setActionHandler = (action, handler) => {
    handlers[action] = handler;
    return original(action, handler);
  };
})();
