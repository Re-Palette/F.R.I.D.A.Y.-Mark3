// F.R.I.D.A.Y. が開いたタブを覚えておき、「閉じて」で閉じる。覚えるのは自分で開いたタブだけ。
// 開くページが、Chrome にインストールしたアプリ（会社のダッシュボードなど）の入口なら、タブではなくそのアプリで開く。
// Amazon Music の Web プレーヤー（music.amazon.co.jp）を、再生・一時停止・次の曲・音量などで操作する。
const KEY = "fridayTabs";

async function load() {
  return (await chrome.storage.session.get(KEY))[KEY] || [];
}
async function save(ids) {
  await chrome.storage.session.set({ [KEY]: ids.slice(-30) });
}

/**
 * インストールしたアプリ（Chrome の「アプリとしてインストール」）の入口なら、そのアプリのウィンドウで開く。
 * アプリには開くページを渡せないので、入口（サイトのトップかアプリの開始ページ）のときだけ。開けたら true
 */
async function launchInstalledApp(url) {
  if (!chrome.management?.getAll || !chrome.management.launchApp) return false;
  const trim = (u) => u.replace(/\/+$/, "");
  const apps = (await chrome.management.getAll()).filter((e) => e.isApp && e.enabled && e.appLaunchUrl);
  const app = apps.find((a) => {
    try {
      const start = new URL(a.appLaunchUrl);
      return start.origin === url.origin && (url.pathname === "/" || trim(start.href) === trim(url.href));
    } catch {
      return false;
    }
  });
  if (!app) return false;
  await chrome.management.launchApp(app.id);
  return true;
}

async function open(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: "URL が正しくありません。" };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return { ok: false, error: "開けない URL です。" };
  // アプリで開けなければ、ふつうにタブで開く
  if (await launchInstalledApp(parsed).catch(() => false)) return { ok: true, app: true };
  const tab = await chrome.tabs.create({ url: parsed.toString(), active: true });
  await save([...(await load()), tab.id]);
  return { ok: true };
}

async function close(target) {
  const ids = await load();
  let closed = 0;
  while (ids.length) {
    const id = ids.pop();
    try {
      await chrome.tabs.remove(id);
      closed++;
    } catch {
      continue; // もう閉じられていた
    }
    if (target !== "all") break;
  }
  await save(ids);
  return { ok: true, closed };
}

/* ---------- Amazon Music（Web プレーヤー）の操作 ---------- */

const MUSIC_URLS = ["https://music.amazon.co.jp/*", "https://music.amazon.com/*"];
const MUSIC_HOME = "https://music.amazon.co.jp";

/** 開いている Amazon Music のタブ（音が出ているものを優先） */
/**
 * そのサイトをアプリとしてインストールしていれば、アプリで開いて、そのウィンドウのタブを返す（無ければ null）。
 * アプリには開くページを渡せないので、起動してから目的のページに移る。
 */
async function openInApp(url, match) {
  const target = new URL(url);
  if (!(await launchInstalledApp(new URL(`${target.origin}/`)).catch(() => false))) return null;
  for (let i = 0; i < 40; i++) {
    const tabs = await chrome.tabs.query({ url: match });
    const tab = tabs.sort((a, b) => b.id - a.id)[0];
    if (tab) {
      if (tab.url !== target.href) await chrome.tabs.update(tab.id, { url: target.href });
      return tab;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

async function musicTab() {
  const tabs = await chrome.tabs.query({ url: MUSIC_URLS });
  return tabs.find((t) => t.audible) ?? tabs[0] ?? null;
}

/** タブの読み込みが終わるまで待つ（最大 15 秒） */
function loaded(tabId) {
  return new Promise((resolve) => {
    const done = () => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      clearTimeout(timer);
      resolve();
    };
    const onUpdated = (id, info) => id === tabId && info.status === "complete" && done();
    const timer = setTimeout(done, 15000);
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

/** Amazon Music のページの中で動かす（ページ側の「控えておいた再生の処理」を呼ぶため MAIN で動かす） */
async function inPage(tabId, func, args = []) {
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func, args });
    return res?.result;
  } catch {
    // ページを読み込めなかった・まだ準備中など（呼び出し元で「操作できませんでした」と伝える）
    return undefined;
  }
}

/**
 * 本物のクリックで再生ボタンを押す。
 * Chrome は「人が操作していないタブ」で勝手に音を出すことを止める（自動再生の制限）ので、
 * ページの中からのクリックで鳴らないときだけ、Chrome のデバッグ機能でマウスのクリックを送る。
 * （使っている間だけ、Chrome の上に「デバッグを開始しました」の帯が一瞬出ます）
 */
async function trustedClick(tabId, point) {
  const target = { tabId };
  try {
    await chrome.debugger.attach(target, "1.3");
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
      await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
        type,
        x: point.x,
        y: point.y,
        button: type === "mouseMoved" ? "none" : "left",
        clickCount: type === "mouseMoved" ? 0 : 1,
      });
    }
    return true;
  } catch {
    return false;
  } finally {
    await chrome.debugger.detach(target).catch(() => {});
  }
}

/** ページの中：操作をする。メディアキー用の処理 → 画面のボタン → 音の要素、の順に試す */
function pageControl(action, value) {
  // 影の DOM（Web Components）の中まで探す
  const all = (root = document, out = []) => {
    for (const el of root.querySelectorAll("*")) {
      out.push(el);
      if (el.shadowRoot) all(el.shadowRoot, out);
    }
    return out;
  };
  // ページに置かれていない音の要素も、再生したときに控えてある（amazon-hook.js）
  const media = () => [...new Set([...(window.__fridayEls || []), ...all().filter((el) => el instanceof HTMLMediaElement)])];
  const click = (re) => {
    const btn = all().find((el) => re.test(el.getAttribute?.("aria-label") || "") || re.test(el.getAttribute?.("icon-name") || ""));
    if (!btn) return false;
    btn.click();
    return true;
  };
  const h = window.__fridayMedia || {};
  const call = (name) => {
    if (typeof h[name] !== "function") return false;
    try {
      h[name]({ action: name });
      return true;
    } catch {
      return false;
    }
  };
  const ms = navigator.mediaSession;
  // 話している間は音を小さくしている（その間の音量は、元の音量で考える）
  const ducked = window.__fridayDuck;
  const volumeOf = (el) => (ducked && ducked.has(el) ? ducked.get(el) : el.volume);
  const now = () => {
    const md = ms?.metadata;
    const els = media();
    const el = els.find((x) => !x.paused) || els[0];
    return {
      title: md?.title || undefined,
      artist: md?.artist || undefined,
      playing: ms?.playbackState === "playing" || els.some((x) => !x.paused),
      volume: el ? Math.round(volumeOf(el) * 100) : undefined,
    };
  };
  if (action === "now") return { ok: true, now: now() };
  if (action === "duck") {
    if (value) {
      if (ducked) return { ok: true };
      const map = new Map();
      for (const el of media()) {
        map.set(el, el.volume);
        el.volume = el.volume * 0.2;
      }
      window.__fridayDuck = map;
    } else if (ducked) {
      for (const [el, v] of ducked) el.volume = v;
      window.__fridayDuck = null;
    }
    return { ok: true };
  }
  if (action === "pause") return { ok: call("pause") || click(/^(一時停止|pause)/i) || media().some((el) => (el.pause(), true)) };
  if (action === "resume") return { ok: call("play") || click(/^(再生|play)$/i) || media().some((el) => (void el.play(), true)) };
  if (action === "next") return { ok: call("nexttrack") || click(/次の曲|次へ|^next/i) };
  if (action === "previous") return { ok: call("previoustrack") || click(/前の曲|前へ|^previous/i) };
  if (action === "shuffle") return { ok: click(/シャッフル|shuffle/i) };
  if (action === "volume") {
    const els = media();
    if (!els.length) return { ok: false, error: "音量を変えられませんでした（再生中の曲がありません）。" };
    const cur = Math.round(volumeOf(els[0]) * 100);
    const target = value === "up" ? cur + 15 : value === "down" ? cur - 15 : Number(value);
    const v = Math.min(100, Math.max(0, Number.isFinite(target) ? target : cur));
    for (const el of els) {
      if (ducked) {
        ducked.set(el, v / 100);
        el.volume = (v / 100) * 0.2;
      } else el.volume = v / 100;
    }
    return { ok: true, volume: v };
  }
  return { ok: false, error: "その操作はできません。" };
}

/**
 * ページの中：検索結果から、流すもの（プレイリスト・アルバム・曲・アーティスト）のページの URL を探す。
 * 頼まれた種類があればそれを優先し、無ければいちばん上の結果。
 */
async function pageFindResult(kind) {
  const all = (root = document, out = []) => {
    for (const el of root.querySelectorAll("*")) {
      out.push(el);
      if (el.shadowRoot) all(el.shadowRoot, out);
    }
    return out;
  };
  const PAGE = /^\/(playlists|user-playlists|albums|artists|stations)\/[A-Za-z0-9_-]{6,}/;
  const WANT = {
    track: (u) => u.pathname.startsWith("/albums/") && u.searchParams.has("trackAsin"),
    playlist: (u) => /^\/(playlists|user-playlists|stations)\//.test(u.pathname),
    album: (u) => u.pathname.startsWith("/albums/") && !u.searchParams.has("trackAsin"),
    artist: (u) => u.pathname.startsWith("/artists/"),
  };
  const collect = () => {
    const found = [];
    for (const el of all()) {
      const raw = el.getAttribute?.("primary-href") || el.getAttribute?.("href");
      if (!raw) continue;
      let u;
      try {
        u = new URL(raw, location.href);
      } catch {
        continue;
      }
      if (u.origin !== location.origin || !PAGE.test(u.pathname)) continue;
      // 画面下の再生バー（いま流れている曲へのリンク）は除く
      const r = el.getBoundingClientRect?.();
      if (r && r.height > 0 && r.top > window.innerHeight - 130 && window.scrollY === 0 && r.bottom <= window.innerHeight) continue;
      found.push(u);
    }
    return found;
  };
  let list = [];
  for (let i = 0; i < 24 && !list.length; i++) {
    list = collect();
    if (!list.length) await new Promise((r) => setTimeout(r, 500));
  }
  if (!list.length) return { href: null };
  // 結果が出そろうのを少し待つ
  await new Promise((r) => setTimeout(r, 700));
  list = collect();
  const pick = (kind && WANT[kind] && list.find(WANT[kind])) || list[0];
  return { href: pick ? pick.href : null };
}

/**
 * ページの中：音が出ているか確かめる。出ていなければ、いちばん上の「再生」ボタンを押してみる。
 * それでも鳴らなければ（自動再生の制限）、本物のクリックで押せるよう、ボタンの位置を返す。
 */
async function pageEnsurePlaying(waitMs) {
  const all = (root = document, out = []) => {
    for (const el of root.querySelectorAll("*")) {
      out.push(el);
      if (el.shadowRoot) all(el.shadowRoot, out);
    }
    return out;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const playing = () => {
    const els = [...(window.__fridayEls || []), ...all().filter((el) => el instanceof HTMLMediaElement)];
    return navigator.mediaSession?.playbackState === "playing" || els.some((el) => !el.paused);
  };
  const result = () => ({ playing: true, title: navigator.mediaSession?.metadata?.title || undefined });
  const waitPlaying = async (ms) => {
    for (let t = 0; t < ms; t += 300) {
      if (playing()) return true;
      await sleep(300);
    }
    return playing();
  };
  if (await waitPlaying(waitMs)) return result();
  // 画面下の再生バー以外にある、最初の「再生」ボタン（詳しいページなら、上の大きな再生ボタン）
  let btn = null;
  for (let i = 0; i < 16 && !btn; i++) {
    btn = all().find((el) => {
      const label = `${el.getAttribute?.("aria-label") || ""} ${el.getAttribute?.("icon-name") || ""} ${el.getAttribute?.("title") || ""}`.trim();
      if (!/(^|\s)(play|再生)(\s|$|する|すべて)/i.test(label) || /pause|一時停止|再生中/i.test(label)) return false;
      const r = el.getBoundingClientRect?.();
      return Boolean(r && r.width > 0 && r.height > 0 && r.top < window.innerHeight - 130);
    });
    if (!btn) await sleep(500);
  }
  if (!btn) return { playing: false };
  btn.scrollIntoView?.({ block: "center" });
  await sleep(150);
  // 作り物の部品（Web Components）なら、中の本物のボタンを押す
  const inner = btn.shadowRoot?.querySelector("button") || btn;
  inner.click();
  if (await waitPlaying(2000)) return result();
  const r = inner.getBoundingClientRect();
  return { playing: false, point: { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } };
}

/** 「〇〇かけて」：検索 → いちばん合う結果のページを「再生」付きで開く → 音が出るまで確かめる */
async function playQuery(tab, query, kind) {
  const search = `${MUSIC_HOME}/search/${encodeURIComponent(query)}`;
  if (tab) await chrome.tabs.update(tab.id, { url: search });
  // 開いていなければ、インストールした Amazon Music のアプリで開く（入れていなければタブで）
  else tab = (await openInApp(search, MUSIC_URLS)) ?? (await chrome.tabs.create({ url: search, active: false }));
  await loaded(tab.id);
  const found = await inPage(tab.id, pageFindResult, [kind || null]);
  if (found?.href) {
    // ?do=play を付けて開くと、Amazon Music はそのページの曲を流し始める
    const url = new URL(found.href);
    url.searchParams.set("do", "play");
    await chrome.tabs.update(tab.id, { url: url.href });
    await loaded(tab.id);
  }
  let r = await inPage(tab.id, pageEnsurePlaying, [found?.href ? 4000 : 0]);
  if (!r?.playing && r?.point && (await trustedClick(tab.id, r.point))) {
    r = await inPage(tab.id, pageEnsurePlaying, [4000]);
  }
  if (r?.playing) return { ok: true, label: `再生：${r.title || query}` };
  return {
    ok: false,
    opened: true,
    error: `Amazon Music で「${query}」を開きましたが、再生を始められませんでした。Amazon Music のタブで再生ボタンを押してください。`,
  };
}

async function music(msg) {
  const action = msg.action;
  const tab = await musicTab();
  if (action === "play" && msg.query) return playQuery(tab, msg.query, msg.kind);
  if (!tab) {
    if (action === "now") return { ok: true, now: null };
    if (action === "duck") return { ok: true };
    if (action === "play" || action === "resume") {
      if (!(await openInApp(MUSIC_HOME, MUSIC_URLS))) await chrome.tabs.create({ url: MUSIC_HOME, active: true });
      return { ok: false, opened: true, error: "Amazon Music を開きました。聴きたい曲を選んで再生してください。" };
    }
    return { ok: false, error: "Amazon Music のタブが開いていません。「〇〇かけて」と頼むと開きます。" };
  }
  const r = await inPage(tab.id, pageControl, [action === "play" ? "resume" : action, msg.value ?? null]);
  return r ?? { ok: false, error: "Amazon Music を操作できませんでした。" };
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  const run =
    msg.type === "open"
      ? open(msg.url)
      : msg.type === "close"
        ? close(msg.target)
        : msg.type === "music"
          ? music(msg)
          : Promise.resolve({ ok: true, version: 2 });
  run.then(reply, (err) => reply({ ok: false, error: String(err && err.message ? err.message : err) }));
  return true; // 非同期で返す
});

chrome.tabs.onRemoved.addListener(async (id) => {
  const ids = await load();
  if (ids.includes(id)) await save(ids.filter((x) => x !== id));
});
