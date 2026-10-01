// F.R.I.D.A.Y. が開いたタブを覚えておき、「閉じて」で閉じる。覚えるのは自分で開いたタブだけ。
// Amazon Music の Web プレーヤー（music.amazon.co.jp）を、再生・一時停止・次の曲・音量などで操作する。
const KEY = "fridayTabs";

async function load() {
  return (await chrome.storage.session.get(KEY))[KEY] || [];
}
async function save(ids) {
  await chrome.storage.session.set({ [KEY]: ids.slice(-30) });
}

async function open(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: "URL が正しくありません。" };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return { ok: false, error: "開けない URL です。" };
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
  const media = () => all().filter((el) => el instanceof HTMLMediaElement);
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
  const now = () => {
    const md = ms?.metadata;
    const el = media()[0];
    return {
      title: md?.title || undefined,
      artist: md?.artist || undefined,
      playing: ms?.playbackState === "playing" || Boolean(el && !el.paused),
      volume: el ? Math.round(el.volume * 100) : undefined,
    };
  };
  if (action === "now") return { ok: true, now: now() };
  if (action === "pause") return { ok: call("pause") || click(/^(一時停止|pause)/i) || media().some((el) => (el.pause(), true)) };
  if (action === "resume") return { ok: call("play") || click(/^(再生|play)$/i) || media().some((el) => (void el.play(), true)) };
  if (action === "next") return { ok: call("nexttrack") || click(/次の曲|次へ|^next/i) };
  if (action === "previous") return { ok: call("previoustrack") || click(/前の曲|前へ|^previous/i) };
  if (action === "shuffle") return { ok: click(/シャッフル|shuffle/i) };
  if (action === "volume") {
    const els = media();
    if (!els.length) return { ok: false, error: "音量を変えられませんでした（再生中の曲がありません）。" };
    const cur = Math.round(els[0].volume * 100);
    const target = value === "up" ? cur + 15 : value === "down" ? cur - 15 : Number(value);
    const v = Math.min(100, Math.max(0, Number.isFinite(target) ? target : cur));
    for (const el of els) el.volume = v / 100;
    return { ok: true, volume: v };
  }
  return { ok: false, error: "その操作はできません。" };
}

/** ページの中：検索結果の最初の「再生」を押す（ページの作りが変わると押せないことがある） */
async function pagePlayFirst() {
  const all = (root = document, out = []) => {
    for (const el of root.querySelectorAll("*")) {
      out.push(el);
      if (el.shadowRoot) all(el.shadowRoot, out);
    }
    return out;
  };
  for (let i = 0; i < 24; i++) {
    // 画面下の再生バー以外にある、最初の再生ボタン
    const btn = all().find((el) => {
      const label = `${el.getAttribute?.("aria-label") || ""} ${el.getAttribute?.("icon-name") || ""}`;
      if (!/(^|\s)(play|再生)/i.test(label)) return false;
      // 画面下の再生バー（下 20%）にあるボタン・見えていないボタンは除く
      const r = el.getBoundingClientRect?.();
      return Boolean(r && r.width > 0 && r.height > 0 && r.top < window.innerHeight * 0.8);
    });
    if (btn) {
      btn.click();
      return { ok: true };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return { ok: false };
}

async function music(msg) {
  const action = msg.action;
  let tab = await musicTab();
  if (action === "play" && msg.query) {
    const url = `${MUSIC_HOME}/search/${encodeURIComponent(msg.query)}`;
    if (tab) await chrome.tabs.update(tab.id, { url });
    else tab = await chrome.tabs.create({ url, active: false });
    await loaded(tab.id);
    const r = await inPage(tab.id, pagePlayFirst);
    return r?.ok
      ? { ok: true, label: `再生：${msg.query}` }
      : { ok: false, opened: true, error: `Amazon Music で「${msg.query}」を開きました。再生ボタンを押してください（自動で押せませんでした）。` };
  }
  if (!tab) {
    if (action === "now") return { ok: true, now: null };
    if (action === "play" || action === "resume") {
      await chrome.tabs.create({ url: MUSIC_HOME, active: true });
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
