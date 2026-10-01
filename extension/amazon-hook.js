// Amazon Music の Web プレーヤー（music.amazon.co.jp / .com）の中で、ページより先に動く。
// Amazon Music はキーボードのメディアキー用に「再生・一時停止・次の曲・前の曲」の処理を登録する（Media Session）。
// その処理を F.R.I.D.A.Y. からも呼べるよう、登録された処理を控えておく。
// 音量を変えられるよう、再生に使われた音の要素（ページに置かれていないものも）も控えておく。
// どちらも控えるだけで、ページの動きは変えない。
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
  const els = new Set();
  window.__fridayEls = els;
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (...args) {
    els.add(this);
    return play.apply(this, args);
  };
})();
