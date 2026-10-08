/*
 * F.R.I.D.A.Y. — Service Worker
 *   1. プッシュ通知を受け取る（アプリを閉じていても動く）
 *   2. ネットが切れていても、インストールした F.R.I.D.A.Y. の画面を開けるようにする（一度オンラインで開いた画面を端末に控える）
 *
 * 控え方:
 *   - 画面（HTML）: まずネットから取り、取れたら控えを新しくする（オンラインなら常に最新版）。取れなければ控えを出す
 *   - /_next/static（版ごとに名前が変わる JS・CSS）: 控えがあればそれを使う。古い版の分は件数の上限で順に消す
 *   - フォント・画像・音声 AI の部品など: 控えを出しつつ裏で新しくする
 *   - /api/*（会話・記憶・予定など）: 控えない（常にネット。オフライン時は画面のローカル AI が代わりに答える）
 * 仕組みを変えたら VERSION を上げる（古い控えはまとめて消える）。
 */
const VERSION = "v1";
const SHELL = `friday-shell-${VERSION}`;
const STATIC = `friday-static-${VERSION}`;
const ASSETS = `friday-assets-${VERSION}`;
const KEEP = [SHELL, STATIC, ASSETS];
const STATIC_MAX = 400;
const ASSETS_MAX = 200;
const NAV_TIMEOUT_MS = 4000;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) =>
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((n) => n.startsWith("friday-") && !KEEP.includes(n)).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
      // 初めて入ったときは、いま開いている画面をすぐ控えておく（次にオフラインで開けるように）
      .then(() => cacheShell("/"))
      .catch(() => {}),
  ),
);

/** 画面（HTML）を取り直して控える。ログイン画面に回されたときは控えない */
async function cacheShell(path) {
  const res = await fetch(path, { credentials: "same-origin", redirect: "follow" });
  if (!res.ok || res.redirected || !(res.headers.get("content-type") || "").includes("text/html")) return;
  const html = await res.clone().text();
  await (await caches.open(SHELL)).put(path, res);
  await warmFromHtml(html);
}

/** 画面から「いま読み込んだ部品」を受け取って控える（Service Worker が入る前に読み込んだ分） */
self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type !== "precache" || !Array.isArray(data.urls)) return;
  event.waitUntil(
    (async () => {
      const cache = await caches.open(STATIC);
      const assets = await caches.open(ASSETS);
      for (const u of data.urls.slice(0, 300)) {
        try {
          const url = new URL(u, self.location.origin);
          if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) continue;
          const target = url.pathname.startsWith("/_next/static/") ? cache : /\.(woff2?|ttf|otf|png|svg|ico|css|mjs|js)$/.test(url.pathname) ? assets : null;
          if (!target || (await target.match(url.pathname + url.search))) continue;
          const res = await fetch(url.pathname + url.search);
          if (res.ok) await target.put(url.pathname + url.search, res);
        } catch {
          /* 次の機会に */
        }
      }
      if (!(await (await caches.open(SHELL)).match("/"))) await cacheShell("/").catch(() => {});
    })(),
  );
});

/** 控えの件数が上限を超えたら、古く入れたものから消す */
async function trim(name, max) {
  const cache = await caches.open(name);
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
}

/** 画面の HTML が使う JS・CSS を先に控えておく（オフラインで開いたときに足りなくならないように） */
async function warmFromHtml(html) {
  const urls = [...new Set([...html.matchAll(/["'(](\/_next\/static\/[^"'()\s]+)/g)].map((m) => m[1].replace(/\\u0026/g, "&")))];
  const cache = await caches.open(STATIC);
  await Promise.all(
    urls.map(async (u) => {
      if (await cache.match(u)) return;
      try {
        const res = await fetch(u);
        if (res.ok) await cache.put(u, res);
      } catch {
        /* 次の機会に */
      }
    }),
  );
  await trim(STATIC, STATIC_MAX);
}

async function navigation(event) {
  const req = event.request;
  const url = new URL(req.url);
  try {
    const res = await Promise.race([
      fetch(req),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), NAV_TIMEOUT_MS)),
    ]);
    // ログインしていない（ログイン画面へ回された）・エラーの画面は控えない
    if (res.ok && !res.redirected && (res.headers.get("content-type") || "").includes("text/html")) {
      const copy = res.clone();
      event.waitUntil(
        (async () => {
          const html = await copy.clone().text();
          const cache = await caches.open(SHELL);
          await cache.put(url.pathname, copy);
          await warmFromHtml(html);
        })().catch(() => {}),
      );
    }
    return res;
  } catch {
    const cache = await caches.open(SHELL);
    const hit = (await cache.match(url.pathname)) || (await cache.match("/"));
    if (hit) return hit;
    return new Response(
      '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>F.R.I.D.A.Y.</title><body style="background:#040506;color:#ffb070;font-family:sans-serif;display:grid;place-items:center;height:100vh;margin:0;text-align:center"><div><h1>F.R.I.D.A.Y.</h1><p>オフラインです。一度オンラインで開くと、次からはオフラインでも開けます。</p></div>',
      { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } },
    );
  }
}

async function cacheFirst(req, name, max) {
  const cache = await caches.open(name);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok && res.type === "basic") {
    await cache.put(req, res.clone());
    void trim(name, max);
  }
  return res;
}

async function staleWhileRevalidate(event, name, max) {
  const cache = await caches.open(name);
  const hit = await cache.match(event.request);
  const fresh = fetch(event.request)
    .then(async (res) => {
      if (res.ok && res.type === "basic") {
        await cache.put(event.request, res.clone());
        await trim(name, max);
      }
      return res;
    })
    .catch(() => null);
  if (hit) {
    event.waitUntil(fresh);
    return hit;
  }
  return (await fresh) || Response.error();
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // LM Studio（localhost）や外部のサイトには触らない
  if (url.pathname.startsWith("/api/") || url.pathname === "/sw.js") return;
  if (req.mode === "navigate") return event.respondWith(navigation(event));
  if (url.pathname.startsWith("/_next/static/")) return event.respondWith(cacheFirst(req, STATIC, STATIC_MAX));
  // 大きな部品（声紋の AI・実行部品など）は版が変わらないので控えを優先
  if (/\.(onnx|wasm|task|tflite)$/.test(url.pathname)) return event.respondWith(cacheFirst(req, ASSETS, ASSETS_MAX));
  if (/\.(woff2?|ttf|otf|png|jpe?g|webp|svg|ico|gif|mjs|js|css|json|webmanifest)$/.test(url.pathname) || url.pathname === "/manifest.webmanifest") {
    return event.respondWith(staleWhileRevalidate(event, ASSETS, ASSETS_MAX));
  }
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "F.R.I.D.A.Y.", body: event.data ? event.data.text() : "" };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || "F.R.I.D.A.Y.", {
      body: data.body || "",
      tag: data.tag,
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      data: { url: data.url || "/" },
      renotify: Boolean(data.tag),
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ("focus" in c) return c.focus();
      }
      return self.clients.openWindow(url);
    }),
  );
});
