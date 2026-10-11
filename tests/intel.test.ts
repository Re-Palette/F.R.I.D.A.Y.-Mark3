/**
 * E.D.I.T.H. の情報収集（フェーズ 1：型・保存・設定・状態・排他制御）のテスト。
 *   - 2 つの実行が同時に始まっても、動くのは 1 つだけ（GitHub の sha 比較を再現した偽物で確かめる）
 *   - 印の期限切れ・自分の印でないときは書かない
 *   - 設定ノートは無いときだけ作り、あるノートは上書きしない
 *   - 外から来た文字・リンクをきれいにし、保存期間・件数・大きさを守る
 *   npm test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { acquireRun, finishRun, stillOwner, recordSuccess, recordFailure, isDue, isStale, emptyState, parseState, LOCK_TTL_MS } = await import("../src/integrations/intel/state");
const { parseSettingsNote, renderSettingsNote, ensureSettingsNote, readIntelSettings, activeSources, inactiveReason, inQuietHours, defaultSettings, intelAllowedByEnv } = await import(
  "../src/integrations/intel/settings"
);
const { normalizeItem, mergeItems, serializeItems, parseItems, saveItems, readItems, MAX_ITEMS, MAX_BYTES, RETENTION_MS } = await import("../src/integrations/intel/store");
const { INTEL_STATE_PATH, INTEL_SETTINGS_PATH, INTEL_ITEMS_PATH } = await import("../src/integrations/intel/brain-io");
const { INTEL_SOURCES } = await import("../src/integrations/intel/sources");

type IO = import("../src/integrations/intel/brain-io").IntelBrainIO;

/** GitHub の Contents API と同じく、読んだときの版（sha）と違えば書き込みを拒否する偽物 */
function fakeBrain(initial: Record<string, string> = {}) {
  const files = new Map<string, { text: string; sha: number }>(Object.entries(initial).map(([p, t]) => [p, { text: t, sha: 1 }]));
  let writes = 0;
  /** 次の書き込みの直前に割り込ませる処理（同時実行の再現） */
  let beforePut: (() => void) | null = null;
  const put = (path: string, text: string, sha: number | null): boolean => {
    const cur = files.get(path);
    if ((cur?.sha ?? null) !== sha) return false; // 409
    files.set(path, { text, sha: (cur?.sha ?? 0) + 1 });
    writes++;
    return true;
  };
  const io: IO = {
    configured: () => true,
    read: async (path) => files.get(path)?.text ?? null,
    update: async (path, update) => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const cur = files.get(path) ?? null;
        const next = update(cur?.text ?? null);
        if (cur && next === cur.text) return;
        const hook = beforePut;
        beforePut = null;
        hook?.();
        if (put(path, next, cur?.sha ?? null)) return;
      }
      throw new Error("conflict");
    },
  };
  return {
    io,
    files,
    get writes() {
      return writes;
    },
    interrupt(fn: () => void) {
      beforePut = fn;
    },
    /** 別の実行がこっそり書く（偽物の外から） */
    rawWrite(path: string, text: string) {
      const cur = files.get(path);
      files.set(path, { text, sha: (cur?.sha ?? 0) + 1 });
    },
  };
}

const NOW = Date.UTC(2026, 9, 11, 3, 0, 0);

describe("排他制御（二重実行の防止）", () => {
  it("印が無ければ取れ、取っている間はほかの実行は動かない", async () => {
    const b = fakeBrain();
    const a = await acquireRun(b.io, NOW, "run-a");
    assert.ok(a);
    const second = await acquireRun(b.io, NOW + 1000, "run-b");
    assert.equal(second, null);
  });

  it("同時に始まっても（書く直前に割り込まれても）、動くのは 1 つだけ", async () => {
    const b = fakeBrain();
    // run-a が書く直前に、run-b が先に印を書いてしまう
    b.interrupt(() => b.rawWrite(INTEL_STATE_PATH, JSON.stringify({ ...emptyState(), lock: { owner: "run-b", until: new Date(NOW + LOCK_TTL_MS).toISOString() } })));
    const a = await acquireRun(b.io, NOW, "run-a");
    assert.equal(a, null);
    assert.equal(parseState(b.files.get(INTEL_STATE_PATH)!.text).lock?.owner, "run-b");
  });

  it("印の期限が切れていれば（途中で止まった実行）、次の実行が取り直せる", async () => {
    const b = fakeBrain();
    await acquireRun(b.io, NOW, "stuck");
    const next = await acquireRun(b.io, NOW + LOCK_TTL_MS + 1, "next");
    assert.equal(next?.owner, "next");
  });

  it("終わるときに印を外し、結果を書く。自分の印でなければ何も書かない", async () => {
    const b = fakeBrain();
    const run = (await acquireRun(b.io, NOW, "run-a"))!;
    assert.equal(await stillOwner(b.io, run, NOW + 1000), true);
    assert.equal(await finishRun(b.io, run, (s) => recordSuccess(s, "usgs", 3, NOW), NOW + 2000), true);
    const s = parseState(b.files.get(INTEL_STATE_PATH)!.text);
    assert.equal(s.lock, null);
    assert.equal(s.sources.usgs?.lastCount, 3);
    assert.ok(s.lastRunAt);

    // 期限切れで別の実行が印を取ったあと、古い実行は書かない
    const old = (await acquireRun(b.io, NOW + 10_000, "old"))!;
    const fresh = (await acquireRun(b.io, NOW + 10_000 + LOCK_TTL_MS + 1, "fresh"))!;
    assert.ok(fresh);
    assert.equal(await stillOwner(b.io, old, NOW + 10_000 + LOCK_TTL_MS + 2), false);
    assert.equal(await finishRun(b.io, old, (s) => recordSuccess(s, "nhc", 9, NOW)), false);
    assert.equal(parseState(b.files.get(INTEL_STATE_PATH)!.text).lock?.owner, "fresh");
  });

  it("壊れた状態ファイルでも止まらない", () => {
    assert.deepEqual(parseState("{壊れている"), emptyState());
  });
});

describe("情報源の状態（間隔・失敗・制限・古さ）", () => {
  it("取れたら次は最短の間隔まで待つ", () => {
    const s = recordSuccess(emptyState(), "usgs", 5, NOW);
    assert.equal(isDue(s, "usgs", NOW + 60_000), false);
    assert.equal(isDue(s, "usgs", NOW + 10 * 60_000 + 1), true);
  });

  it("失敗が続くほど長く待ち、429・403 は 1 時間以上、Retry-After も守る", () => {
    let s = recordFailure(emptyState(), "usgs", { message: "timeout" }, NOW);
    const first = Date.parse(s.sources.usgs!.nextAllowedAt!) - NOW;
    s = recordFailure(s, "usgs", { message: "timeout" }, NOW);
    const second = Date.parse(s.sources.usgs!.nextAllowedAt!) - NOW;
    assert.ok(second > first);
    assert.equal(s.sources.usgs!.failures, 2);
    const limited = recordFailure(emptyState(), "usgs", { message: "rate", status: 429 }, NOW);
    assert.ok(Date.parse(limited.sources.usgs!.nextAllowedAt!) - NOW >= 60 * 60_000);
    const after = recordFailure(emptyState(), "usgs", { message: "rate", status: 503, retryAfterMs: 2 * 60 * 60_000 }, NOW);
    assert.ok(Date.parse(after.sources.usgs!.nextAllowedAt!) - NOW >= 2 * 60 * 60_000);
    // 成功すれば失敗の数は戻る
    assert.equal(recordSuccess(s, "usgs", 1, NOW).sources.usgs!.failures, 0);
  });

  it("最後に取れてから時間がたちすぎたら「古い」", () => {
    const s = recordSuccess(emptyState(), "usgs", 1, NOW);
    assert.equal(isStale(s, "usgs", NOW + 60 * 60_000), false);
    assert.equal(isStale(s, "usgs", NOW + 3 * 60 * 60_000), true);
    assert.equal(isStale(emptyState(), "usgs", NOW), false);
  });
});

describe("設定ノート", () => {
  it("既定の内容を書いて読み直すと同じ設定になる", () => {
    const s = parseSettingsNote(renderSettingsNote());
    const d = defaultSettings();
    assert.deepEqual({ ...s, fromBrain: false }, d);
  });

  it("ON/OFF・静かな時間帯・上限・キーワードを読む（全角・日本語の書き方も）", () => {
    const s = parseSettingsNote(`## 全体
ON
## 情報源
- USGS 地震（usgs）: OFF
- GDELT（gdelt）：オン
- 不明（xxx）: ON
## 通知
オフ
## 静かな時間帯
２２：３０〜６：００
## 1日の通知の上限
99
## 注目キーワード
- 半導体
- F.R.I.D.A.Y.
`);
    assert.equal(s.sources.usgs, false);
    assert.equal(s.sources.gdelt, true);
    assert.equal(s.notify, false);
    assert.deepEqual(s.quiet, { from: "22:30", to: "06:00" });
    assert.equal(s.dailyLimit, 20);
    assert.deepEqual(s.keywords, ["半導体", "F.R.I.D.A.Y."]);
  });

  it("静かな時間帯（日付をまたぐ・またがない・なし）", () => {
    const q = { quiet: { from: "23:00", to: "07:00" } };
    assert.equal(inQuietHours(q, "23:30"), true);
    assert.equal(inQuietHours(q, "06:59"), true);
    assert.equal(inQuietHours(q, "07:00"), false);
    assert.equal(inQuietHours({ quiet: { from: "12:00", to: "13:00" } }, "12:30"), true);
    assert.equal(inQuietHours({ quiet: null }, "03:00"), false);
    assert.equal(parseSettingsNote("## 静かな時間帯\nなし\n").quiet, null);
  });

  it("ノートが無いときだけ作り、あるノートは上書きしない", async () => {
    const b = fakeBrain();
    assert.deepEqual(await ensureSettingsNote(b.io), { created: true });
    const mine = "## 全体\nOFF\n## 注目キーワード\n- 自分で書いた\n";
    b.rawWrite(INTEL_SETTINGS_PATH, mine);
    const writes = b.writes;
    assert.deepEqual(await ensureSettingsNote(b.io), { created: false });
    assert.equal(b.files.get(INTEL_SETTINGS_PATH)!.text, mine);
    assert.equal(b.writes, writes);
    const s = await readIntelSettings(b.io);
    assert.equal(s.enabled, false);
    assert.deepEqual(s.keywords, ["自分で書いた"]);
  });

  it("EDITH_INTEL=on のときだけ動く。鍵が必要な情報源は鍵が無ければ動かない", () => {
    const s = defaultSettings();
    for (const id of Object.keys(s.sources) as (keyof typeof s.sources)[]) s.sources[id] = true;
    assert.equal(intelAllowedByEnv({}), false);
    assert.deepEqual(activeSources(s, {}), []);
    assert.equal(inactiveReason("usgs", s, {}), "情報収集が止まっています（EDITH_INTEL）");
    assert.equal(inactiveReason("firms", s, { EDITH_INTEL: "on" }), INTEL_SOURCES.find((d) => d.id === "firms")!.ready ? "鍵（FIRMS_MAP_KEY）が未登録" : "準備中");
    // 準備中の情報源は、ON でも動かない（いま動くのは実装済みのものだけ）
    const ready = INTEL_SOURCES.filter((d) => d.ready).map((d) => d.id);
    assert.deepEqual(activeSources(s, { EDITH_INTEL: "on", FIRMS_MAP_KEY: "x", OPENALEX_API_KEY: "y" }), ready);
    assert.equal(inactiveReason("gdelt", s, { EDITH_INTEL: "on" }), "準備中");
    s.enabled = false;
    assert.equal(inactiveReason("usgs", s, { EDITH_INTEL: "on" }), "設定ノートで全体が OFF");
  });
});

const item = (over: Record<string, unknown> = {}) => ({
  id: "usgs:us7000abcd",
  source: "usgs",
  kind: "official",
  category: "disaster",
  title: "M6.1 - 東北沖",
  summary: "地震",
  url: "https://earthquake.usgs.gov/earthquakes/eventpage/us7000abcd",
  publishedAt: new Date(NOW - 60_000).toISOString(),
  updatedAt: null,
  fetchedAt: new Date(NOW).toISOString(),
  firstSeenAt: new Date(NOW).toISOString(),
  place: { name: "東北沖", lat: 38.3, lon: 142.4 },
  level: "high",
  confidence: "high",
  reasons: ["M6 以上"],
  corroboration: [],
  clusterId: null,
  conflicts: [],
  facts: { mag: 6.1, tsunami: false },
  ...over,
});

describe("集めた情報の保存", () => {
  it("外から来た文字・リンクをきれいにする（制御文字・javascript: リンク・範囲外の座標）", () => {
    const n = normalizeItem(item({ title: "見出し\u0000‮abc", url: "javascript:alert(1)", place: { name: "x", lat: 200, lon: 0 }, kind: "???" }))!;
    assert.equal(n.title, "見出し abc");
    assert.equal(n.url, null);
    assert.equal(n.place, null);
    assert.equal(n.kind, "report");
    assert.equal(normalizeItem(item({ source: "unknown" })), null);
    assert.equal(normalizeItem(item({ title: "" })), null);
  });

  it("同じ ID は 1 件にまとめ、初めて見た時刻は残す", () => {
    const a = normalizeItem(item())!;
    const b = normalizeItem(item({ title: "M6.3 - 東北沖（更新）", firstSeenAt: new Date(NOW + 60_000).toISOString(), fetchedAt: new Date(NOW + 60_000).toISOString() }))!;
    const merged = mergeItems([a], [b], NOW + 60_000);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].title, "M6.3 - 東北沖（更新）");
    assert.equal(merged[0].firstSeenAt, a.firstSeenAt);
  });

  it("14 日より古いもの・多すぎる分は捨て、新しい順に並べる", () => {
    const old = normalizeItem(item({ id: "usgs:old", publishedAt: new Date(NOW - RETENTION_MS - 1).toISOString() }))!;
    const many = Array.from({ length: MAX_ITEMS + 50 }, (_, i) => normalizeItem(item({ id: `usgs:${i}`, publishedAt: new Date(NOW - i * 1000).toISOString() }))!);
    const merged = mergeItems([old], many, NOW);
    assert.equal(merged.length, MAX_ITEMS);
    assert.equal(merged[0].id, "usgs:0");
    assert.ok(!merged.some((i) => i.id === "usgs:old"));
  });

  it("保存する大きさを GitHub で読める範囲に収める", () => {
    const big = Array.from({ length: MAX_ITEMS }, (_, i) => normalizeItem(item({ id: `usgs:${i}`, summary: "あ".repeat(400), reasons: ["理由".repeat(50)] }))!);
    const text = serializeItems(big);
    assert.ok(Buffer.byteLength(text, "utf8") <= MAX_BYTES);
    assert.ok(parseItems(text).length > 0);
  });

  it("保存して読み直せる。壊れたファイルは空として扱う", async () => {
    const b = fakeBrain({ [INTEL_ITEMS_PATH]: "壊れている" });
    assert.deepEqual(await readItems(b.io), []);
    await saveItems(b.io, [normalizeItem(item())!], NOW);
    const back = await readItems(b.io);
    assert.equal(back.length, 1);
    assert.equal(back[0].kind, "official");
    assert.equal(back[0].facts.mag, 6.1);
  });
});
