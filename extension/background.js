// F.R.I.D.A.Y. が開いたタブを覚えておき、「閉じて」で閉じる。覚えるのは自分で開いたタブだけ。
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

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  const run = msg.type === "open" ? open(msg.url) : msg.type === "close" ? close(msg.target) : Promise.resolve({ ok: true, version: 1 });
  run.then(reply, (err) => reply({ ok: false, error: String(err && err.message ? err.message : err) }));
  return true; // 非同期で返す
});

chrome.tabs.onRemoved.addListener(async (id) => {
  const ids = await load();
  if (ids.includes(id)) await save(ids.filter((x) => x !== id));
});
