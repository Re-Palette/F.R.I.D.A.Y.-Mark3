/**
 * Google カレンダーの予定が、会話のたびに確実に使えることのテスト（模擬の Google。本物の Google は使わない）。
 *   - 最新を取りに行き、間に合わなければ前回の予定・失敗しても前回の予定（古い予定を黙って使い続けない）
 *   - Google の一時的なエラー・つながらないときは 1 回やり直す
 *   - 画面から届く予定の控えを確かめ、今日から 7 日分だけ使う
 *   npm test
 */
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

const { latest, invalidate } = await import("../src/lib/swr");
const { parseCalendarSnapshot, snapshotEvents } = await import("../src/integrations/calendar-snapshot");
const { asksForSchedule } = await import("../src/agents/chat/schedule");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("最新を取りに行くキャッシュ", () => {
  beforeEach(() => invalidate("t:"));
  it("前回が無ければ、取れるまで待つ", async () => {
    const r = await latest("t:a", 1000, 10, async () => {
      await sleep(40);
      return 1;
    });
    assert.equal(r.value, 1);
  });
  it("少し前に取ったものは、そのまま返す（取り直さない）", async () => {
    let calls = 0;
    const load = async () => ++calls;
    await latest("t:b", 1000, 10, load);
    assert.equal((await latest("t:b", 1000, 10, load)).value, 1);
    assert.equal(calls, 1);
  });
  it("古ければ取り直し、間に合えば最新を返す", async () => {
    let n = 0;
    await latest("t:c", 0, 200, async () => ++n);
    const r = await latest("t:c", 0, 200, async () => {
      await sleep(20);
      return ++n;
    });
    assert.equal(r.value, 2);
  });
  it("間に合わなければ前回の値を返し、取り直しは裏で続けて次に使う", async () => {
    await latest("t:d", 0, 10, async () => "old");
    const r = await latest("t:d", 0, 20, async () => {
      await sleep(80);
      return "new";
    });
    assert.equal(r.value, "old");
    await sleep(100);
    assert.equal((await latest("t:d", 10_000, 20, async () => "x")).value, "new");
  });
  it("取り直しに失敗しても前回の値で続ける。前回が無ければ失敗を伝える", async () => {
    await latest("t:e", 0, 50, async () => "ok");
    assert.equal((await latest("t:e", 0, 50, async () => Promise.reject(new Error("down")))).value, "ok");
    await assert.rejects(latest("t:f", 0, 50, async () => Promise.reject(new Error("down"))));
  });
});

describe("Google カレンダーへの問い合わせ", () => {
  let server: http.Server;
  let hits = { token: 0, events: 0 };
  let failNext = 0;
  const keep = { ...process.env };

  before(async () => {
    server = http.createServer((req, res) => {
      if (req.url?.startsWith("/token")) {
        hits.token++;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ access_token: "at", expires_in: 3600 }));
        return;
      }
      hits.events++;
      if (failNext > 0) {
        failNext--;
        res.writeHead(503);
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          items: [{ id: "e1", summary: "ゼミ", start: { dateTime: new Date(Date.now() + 3600_000).toISOString() }, end: { dateTime: new Date(Date.now() + 7200_000).toISOString() } }],
        }),
      );
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    process.env = { ...keep, GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret", GOOGLE_OAUTH_TOKEN_URL: `${base}/token`, GOOGLE_CALENDAR_API_BASE: base };
  });
  after(() => {
    process.env = keep;
    server.closeAllConnections();
    server.close();
  });
  beforeEach(() => {
    hits = { token: 0, events: 0 };
    failNext = 0;
  });

  it("Google が一時的にエラーを返しても、1 回やり直して予定を取る", async () => {
    const { CalendarAccess } = await import("../src/integrations/google-calendar");
    failNext = 1;
    const events = await new CalendarAccess("refresh-a", "Asia/Tokyo").upcoming(7);
    assert.equal(events.length, 1);
    assert.equal(events[0].title, "ゼミ");
    assert.equal(hits.events, 2);
  });
  it("30 秒より前に取った予定は、次の会話で Google に確かめ直す（すぐ前なら確かめない）", async () => {
    const { CalendarAccess } = await import("../src/integrations/google-calendar");
    const cal = new CalendarAccess("refresh-b", "Asia/Tokyo");
    const first = await cal.upcomingAt(7);
    await cal.upcomingAt(7);
    assert.equal(hits.events, 1);
    assert.ok(Date.now() - first.at < 1000);
  });
});

describe("画面から届く予定の控え", () => {
  const now = new Date("2026-10-09T03:00:00Z"); // 東京 12:00
  const ev = (over: Record<string, unknown>) => ({
    id: "x",
    title: "予定",
    start: "2026-10-09T15:00:00+09:00",
    end: "2026-10-09T16:00:00+09:00",
    allDay: false,
    dayLabel: "10/9(金)",
    timeLabel: "15:00",
    rangeLabel: "15:00–16:00",
    ...over,
  });

  it("正しい形なら受け取る", () => {
    const s = parseCalendarSnapshot({ events: [ev({})], at: now.getTime() - 60_000 }, now.getTime());
    assert.equal(s?.events.length, 1);
  });
  it("古すぎる・未来の時刻・形がおかしい・多すぎるものは使わない", () => {
    const t = now.getTime();
    assert.equal(parseCalendarSnapshot({ events: [ev({})], at: t - 7 * 3600_000 }, t), undefined);
    assert.equal(parseCalendarSnapshot({ events: [ev({})], at: t + 3600_000 }, t), undefined);
    assert.equal(parseCalendarSnapshot({ events: [ev({ allDay: "no" })], at: t }, t), undefined);
    assert.equal(parseCalendarSnapshot({ events: [ev({ start: "明日" })], at: t }, t), undefined);
    assert.equal(parseCalendarSnapshot({ events: [ev({ title: "a".repeat(400) })], at: t }, t), undefined);
    assert.equal(parseCalendarSnapshot({ events: Array.from({ length: 61 }, () => ev({})), at: t }, t), undefined);
    assert.equal(parseCalendarSnapshot("x", t), undefined);
  });
  it("今日から 7 日分だけ使う（終わった日の予定・終日の予定の終わりの日は除く）", () => {
    const s = parseCalendarSnapshot(
      {
        at: now.getTime(),
        events: [
          ev({ id: "yesterday", start: "2026-10-08T10:00:00+09:00", end: "2026-10-08T11:00:00+09:00" }),
          ev({ id: "today" }),
          ev({ id: "allday-yesterday", allDay: true, start: "2026-10-08", end: "2026-10-09" }),
          ev({ id: "allday-today", allDay: true, start: "2026-10-09", end: "2026-10-10" }),
          ev({ id: "next-week", start: "2026-10-16T10:00:00+09:00", end: "2026-10-16T11:00:00+09:00" }),
          ev({ id: "in-6-days", start: "2026-10-15T10:00:00+09:00", end: "2026-10-15T11:00:00+09:00" }),
        ],
      },
      now.getTime(),
    )!;
    assert.deepEqual(
      snapshotEvents(s, now, "Asia/Tokyo").map((e) => e.id),
      ["today", "allday-today", "in-6-days"],
    );
  });
});

describe("予定のことを聞かれたか（最新の予定を少し長めに待つ）", () => {
  for (const t of ["今日の予定は？", "明日空いてる？", "来週の月曜って何がある", "ゼミいつだっけ", "スケジュール教えて"]) {
    it(`「${t}」は予定の質問`, () => assert.equal(asksForSchedule(t), true));
  }
  for (const t of ["ありがとう", "この曲いいね", "線形代数の資料作って"]) {
    it(`「${t}」は予定の質問ではない`, () => assert.equal(asksForSchedule(t), false));
  }
});
