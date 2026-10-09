/**
 * Google カレンダー連携（サーバー専用）。
 *
 *   ブラウザ →「接続」→ Google のログイン・許可 → /api/calendar/callback
 *   → 更新用トークンを暗号化して Cookie に保存（その端末で有効）
 *
 * - 読む: 今日から数日分の予定（会話・右パネル用）
 * - 書く: 会話の中で頼まれた予定を追加
 * クライアント ID / シークレット・トークンはブラウザに渡さない。
 */
import { settingsHint } from "@/lib/config";
import { createHash } from "node:crypto";
import { readCookie, seal, unseal } from "@/lib/secure-cookie";
import { invalidate, latest } from "@/lib/swr";

export const CALENDAR_COOKIE = "friday_gcal";
export const STATE_COOKIE = "friday_gcal_state";
export const CALENDAR_COOKIE_MAX_AGE = 60 * 60 * 24 * 400; // ブラウザの上限（約 400 日）
/** 予定の読み書きと、Gmail を読む権限・下書きを作る権限（送信は F.R.I.D.A.Y. からはしない） */
export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
export const GMAIL_COMPOSE_SCOPE = "https://www.googleapis.com/auth/gmail.compose";
const SCOPE = `https://www.googleapis.com/auth/calendar.events ${GMAIL_SCOPE} ${GMAIL_COMPOSE_SCOPE}`;

export interface CalendarConfig {
  clientId: string | undefined;
  clientSecret: string | undefined;
  /** 全端末共通で使う更新用トークン（任意。設定すると接続ボタン不要） */
  refreshToken: string | undefined;
  calendarId: string;
  authUrl: string;
  tokenUrl: string;
  apiBase: string;
}

export function getCalendarConfig(): CalendarConfig {
  const env = (k: string) => process.env[k]?.trim() || undefined;
  return {
    clientId: env("GOOGLE_CLIENT_ID"),
    clientSecret: env("GOOGLE_CLIENT_SECRET"),
    refreshToken: env("GOOGLE_REFRESH_TOKEN"),
    calendarId: env("GOOGLE_CALENDAR_ID") ?? "primary",
    // テスト用に差し替え可能
    authUrl: env("GOOGLE_OAUTH_AUTH_URL") ?? "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: env("GOOGLE_OAUTH_TOKEN_URL") ?? "https://oauth2.googleapis.com/token",
    apiBase: (env("GOOGLE_CALENDAR_API_BASE") ?? "https://www.googleapis.com/calendar/v3").replace(/\/+$/, ""),
  };
}

export function isCalendarConfigured(c: CalendarConfig = getCalendarConfig()): boolean {
  return Boolean(c.clientId && c.clientSecret);
}

export class CalendarError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    /** true: 接続し直しが必要 */
    public readonly reconnect = false,
  ) {
    super(message);
  }
}

/* ---------- 接続（OAuth） ---------- */

/** このサイトの URL から、Google に登録するリダイレクト URI を作る */
export function redirectUri(req: Request): string {
  const url = new URL(req.url);
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? url.host;
  const proto = req.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
  return `${proto}://${host}/api/calendar/callback`;
}

export function buildAuthUrl(redirect: string, state: string): string {
  const c = getCalendarConfig();
  const params = new URLSearchParams({
    client_id: c.clientId ?? "",
    redirect_uri: redirect,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent", // 毎回、更新用トークンを発行させる
    include_granted_scopes: "true",
    state,
  });
  return `${c.authUrl}?${params}`;
}

async function tokenRequest(
  params: Record<string, string>,
): Promise<{ access_token?: string; refresh_token?: string; expires_in?: number; scope?: string }> {
  const c = getCalendarConfig();
  let res: Response;
  try {
    res = await fetch(c.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: c.clientId ?? "", client_secret: c.clientSecret ?? "", ...params }),
      signal: AbortSignal.timeout(8000),
      cache: "no-store",
    });
  } catch {
    throw new CalendarError("CALENDAR_NETWORK", "Google に接続できませんでした。");
  }
  const json = (await res.json().catch(() => ({}))) as {
    error?: string;
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };
  if (res.ok) return json;
  if (json.error === "invalid_grant")
    throw new CalendarError("CALENDAR_EXPIRED", "Google カレンダーの接続が切れました。もう一度「接続」してください。", true);
  if (json.error === "invalid_client" || json.error === "unauthorized_client")
    throw new CalendarError(
      "CALENDAR_CLIENT",
      `Google のクライアント ID / シークレットが正しくありません。${settingsHint("GOOGLE_CLIENT_SECRET")}`,
    );
  throw new CalendarError("CALENDAR_UPSTREAM", `Google でエラーが発生しました（${res.status}）。`);
}

/** 許可後に返ってきたコードを、更新用トークンに交換する */
export async function exchangeCode(code: string, redirect: string): Promise<string> {
  const json = await tokenRequest({ code, redirect_uri: redirect, grant_type: "authorization_code" });
  if (!json.refresh_token) throw new CalendarError("CALENDAR_NO_REFRESH", "Google から更新用トークンを受け取れませんでした。もう一度接続してください。");
  return json.refresh_token;
}

export function sealRefreshToken(token: string): string {
  return seal(token, getCalendarConfig().clientSecret ?? "");
}

/** リクエストの Cookie（なければ環境変数）から更新用トークンを取り出す */
export function refreshTokenFrom(req: Request): string | undefined {
  const c = getCalendarConfig();
  if (!isCalendarConfigured(c)) return undefined;
  return unseal(readCookie(req, CALENDAR_COOKIE), c.clientSecret ?? "") ?? c.refreshToken;
}

const accessCache = new Map<string, { token: string; until: number; scopes: string[] }>();

async function accessGrant(refresh: string): Promise<{ token: string; scopes: string[] }> {
  const hit = accessCache.get(refresh);
  if (hit && hit.until > Date.now()) return hit;
  const json = await tokenRequest({ refresh_token: refresh, grant_type: "refresh_token" });
  if (!json.access_token) throw new CalendarError("CALENDAR_UPSTREAM", "Google からアクセス用トークンを受け取れませんでした。");
  if (accessCache.size > 50) accessCache.clear();
  const grant = {
    token: json.access_token,
    until: Date.now() + Math.max(60, (json.expires_in ?? 3600) - 120) * 1000,
    // scope が返らない場合は、少なくともカレンダーは許可されているとみなす
    scopes: (json.scope ?? "https://www.googleapis.com/auth/calendar.events").split(/\s+/),
  };
  accessCache.set(refresh, grant);
  return grant;
}

/** Google API 用のアクセストークン（1 時間ほど使い回す） */
export async function accessToken(refresh: string): Promise<string> {
  return (await accessGrant(refresh)).token;
}

/** この接続で Gmail を読む許可があるか（以前の接続は予定の権限だけのことがある） */
export async function hasGmailScope(refresh: string): Promise<boolean> {
  return (await accessGrant(refresh)).scopes.includes(GMAIL_SCOPE);
}

/** この接続で Gmail の下書きを作る許可があるか（以前の接続は読むだけのことがある） */
export async function hasComposeScope(refresh: string): Promise<boolean> {
  return (await accessGrant(refresh)).scopes.includes(GMAIL_COMPOSE_SCOPE);
}

/* ---------- 日付（タイムゾーン付き） ---------- */

/** 例: "+09:00" */
function tzOffset(date: Date, tz: string): string {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" })
    .formatToParts(date)
    .find((p) => p.type === "timeZoneName")?.value;
  const m = /GMT([+-]\d{2}):?(\d{2})?/.exec(name ?? "");
  return m ? `${m[1]}:${m[2] ?? "00"}` : "+00:00";
}

const ymd = (date: Date, tz: string) => new Intl.DateTimeFormat("sv-SE", { timeZone: tz }).format(date);

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** 今日から days 日分の範囲（その地域の 0 時区切り） */
/** 今日から offset 日ずらした日の 0 時から days 日分（offset が負なら過去） */
function dayRange(tz: string, days: number, now = new Date(), offset = 0): { timeMin: string; timeMax: string } {
  const start = addDays(ymd(now, tz), offset);
  const end = addDays(start, days);
  const at = (day: string) => `${day}T00:00:00${tzOffset(new Date(`${day}T12:00:00Z`), tz)}`;
  return { timeMin: at(start), timeMax: at(end) };
}

/* ---------- 予定の読み書き ---------- */

export interface CalendarEvent {
  id: string;
  title: string;
  /** "2026-09-29T15:00:00+09:00" または終日なら "2026-09-29" */
  start: string;
  end: string;
  allDay: boolean;
  location?: string;
  /** 表示用（その地域の時刻）: "9/29(火)" */
  dayLabel: string;
  /** 表示用: "15:00" / "終日" */
  timeLabel: string;
  /** 表示用: "15:00–16:00" / "終日" */
  rangeLabel: string;
}

/** 日時を読む。時差の書かれていない日時は、その地域の時刻として読む */
function parseDateTime(iso: string, tz: string): Date {
  if (/(Z|[+-]\d{2}:?\d{2})$/.test(iso)) return new Date(iso);
  const noon = new Date(`${iso.slice(0, 10)}T12:00:00Z`);
  return new Date(`${iso}${tzOffset(noon, tz)}`);
}

/** Date → その地域の "2026-09-29T15:00" */
function localDateTime(date: Date, tz: string): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })
    .format(date)
    .replace(" ", "T");
}

interface GoogleEvent {
  id: string;
  summary?: string;
  location?: string;
  status?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
}

function toEvent(e: GoogleEvent, tz: string): CalendarEvent {
  const allDay = !e.start?.dateTime;
  const start = e.start?.dateTime ?? e.start?.date ?? "";
  const end = e.end?.dateTime ?? e.end?.date ?? start;
  const parse = (iso: string) => parseDateTime(iso, tz);
  const startDate = allDay ? new Date(`${start}T12:00:00Z`) : parse(start);
  const time = (iso: string) =>
    new Intl.DateTimeFormat("ja-JP", { timeZone: tz, hour: "2-digit", minute: "2-digit" }).format(parse(iso));
  return {
    id: e.id,
    title: e.summary?.trim() || "（タイトルなし）",
    start,
    end,
    allDay,
    location: e.location || undefined,
    dayLabel: new Intl.DateTimeFormat("ja-JP", { timeZone: allDay ? "UTC" : tz, month: "numeric", day: "numeric", weekday: "short" })
      .format(startDate)
      .replace(/\s/g, ""),
    timeLabel: allDay ? "終日" : time(start),
    rangeLabel: allDay ? "終日" : `${time(start)}–${time(end)}`,
  };
}

/** Google カレンダーに問い合わせる。読むときは、つながらない・Google 側の一時的なエラーなら 1 回だけやり直す */
async function api(refresh: string, path: string, init: RequestInit = {}): Promise<Response> {
  const c = getCalendarConfig();
  const retry = !init.method || init.method === "GET";
  for (let attempt = 0; ; attempt++) {
    const token = await accessToken(refresh);
    let res: Response;
    try {
      res = await fetch(`${c.apiBase}/calendars/${encodeURIComponent(c.calendarId)}${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${token}`, ...(init.body ? { "Content-Type": "application/json" } : {}) },
        signal: AbortSignal.timeout(6000),
        cache: "no-store",
      });
    } catch {
      if (retry && attempt === 0) continue;
      throw new CalendarError("CALENDAR_NETWORK", "Google カレンダーに接続できませんでした。");
    }
    if (retry && attempt === 0 && (res.status >= 500 || res.status === 429)) continue;
    // アクセス用トークンが先に無効になっていたら、取り直してもう 1 回
    if (res.status === 401 && attempt === 0) {
      accessCache.delete(refresh);
      continue;
    }
    return res;
  }
}

function apiError(status: number): CalendarError {
  if (status === 401) {
    return new CalendarError("CALENDAR_EXPIRED", "Google カレンダーの接続が切れました。もう一度「接続」してください。", true);
  }
  if (status === 403)
    return new CalendarError(
      "CALENDAR_FORBIDDEN",
      "Google カレンダーを使う許可がありません。Google Cloud で Google Calendar API を有効にし、接続し直してください。",
      true,
    );
  if (status === 404) return new CalendarError("CALENDAR_NOT_FOUND", `カレンダーが見つかりません。${settingsHint("GOOGLE_CALENDAR_ID")}`);
  return new CalendarError("CALENDAR_UPSTREAM", `Google カレンダーでエラーが発生しました（${status}）。`);
}

export interface NewEventInput {
  title: string;
  /** "2026-09-29T15:00"（その地域の時刻）または終日なら "2026-09-29" */
  start: string;
  end?: string;
  location?: string;
  allDay?: boolean;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::\d{2})?$/;

/** "2026-09-29T15:00" に分を足す（タイムゾーンに依存しない単純な計算） */
function addMinutes(local: string, minutes: number): string {
  const m = DATETIME.exec(local)!;
  const d = new Date(`${m[1]}T${m[2]}:${m[3]}:00Z`);
  d.setUTCMinutes(d.getUTCMinutes() + minutes);
  return d.toISOString().slice(0, 16);
}

/** 予定の内容を確かめて Google の形式にする。おかしければ理由を投げる */
export function normalizeNewEvent(input: NewEventInput, tz: string): Record<string, unknown> {
  const title = String(input.title ?? "").trim().slice(0, 200);
  if (!title) throw new CalendarError("CALENDAR_BAD_EVENT", "予定の名前が分かりませんでした。");
  const start = String(input.start ?? "").trim();
  const end = input.end ? String(input.end).trim() : "";
  const location = input.location ? String(input.location).trim().slice(0, 200) : undefined;

  if (input.allDay || DATE.test(start)) {
    const day = start.slice(0, 10);
    if (!DATE.test(day)) throw new CalendarError("CALENDAR_BAD_EVENT", "予定の日付が分かりませんでした。");
    const last = DATE.test(end.slice(0, 10)) && end.slice(0, 10) >= day ? end.slice(0, 10) : day;
    return { summary: title, location, start: { date: day }, end: { date: addDays(last, 1) } };
  }
  if (!DATETIME.test(start)) throw new CalendarError("CALENDAR_BAD_EVENT", "予定の日時が分かりませんでした。");
  const s = start.slice(0, 16);
  const e = DATETIME.test(end) && end.slice(0, 16) > s ? end.slice(0, 16) : addMinutes(s, 60);
  return {
    summary: title,
    location,
    start: { dateTime: `${s}:00`, timeZone: tz },
    end: { dateTime: `${e}:00`, timeZone: tz },
  };
}

/** この時間内に取った予定は、そのまま使う */
const CALENDAR_FRESH_MS = 30_000;
/** 最新の予定を待つ時間（過ぎたら前回取った予定で答える） */
const CALENDAR_WAIT_MS = 2500;

/** 1 つの端末（または全端末共通のトークン）から見たカレンダー */
export class CalendarAccess {
  /** キャッシュの鍵（トークンそのものは使わない） */
  private readonly cacheKey: string;

  constructor(
    private readonly refresh: string,
    private readonly tz: string,
  ) {
    this.cacheKey = `cal:${createHash("sha256").update(refresh).digest("hex").slice(0, 16)}:`;
  }

  /** 今日から offset 日ずらした日から days 日分（振り返り用に過去も読める） */
  async between(offset: number, days: number, max = 60): Promise<CalendarEvent[]> {
    const key = `${this.cacheKey}${ymd(new Date(), this.tz)}:range:${offset}:${days}:${max}`;
    return (await latest(key, CALENDAR_FRESH_MS, CALENDAR_WAIT_MS, () => this.fetchUpcoming(days, max, offset))).value;
  }

  /** 今日から days 日分の予定 */
  async upcoming(days = 7, max = 40, wait = CALENDAR_WAIT_MS): Promise<CalendarEvent[]> {
    return (await this.upcomingAt(days, max, wait)).events;
  }

  /**
   * 今日から days 日分の予定と、それをいつ Google から取ったか。
   * 古いままの予定を出さないよう、30 秒より前に取ったものは毎回 Google に確かめに行く。
   * wait までに返事が無ければ、前回取った予定を返す（前回が無ければ取れるまで待つ）。予定を書き換えたら捨てる。
   */
  async upcomingAt(days = 7, max = 40, wait = CALENDAR_WAIT_MS): Promise<{ events: CalendarEvent[]; at: number }> {
    const key = `${this.cacheKey}${ymd(new Date(), this.tz)}:${days}:${max}`;
    const { value, at } = await latest(key, CALENDAR_FRESH_MS, wait, () => this.fetchUpcoming(days, max));
    return { events: value, at };
  }

  private async fetchUpcoming(days: number, max: number, offset = 0): Promise<CalendarEvent[]> {
    const { timeMin, timeMax } = dayRange(this.tz, days, new Date(), offset);
    const params = new URLSearchParams({
      timeMin,
      timeMax,
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: String(max),
      timeZone: this.tz,
    });
    const res = await api(this.refresh, `/events?${params}`);
    if (!res.ok) throw apiError(res.status);
    const json = (await res.json()) as { items?: GoogleEvent[] };
    const from = Date.parse(timeMin);
    const to = Date.parse(timeMax);
    const edge = (iso: string, allDay: boolean) =>
      allDay ? Date.parse(`${iso}T00:00:00${timeMin.slice(19)}`) : parseDateTime(iso, this.tz).getTime();
    return (json.items ?? [])
      .filter((e) => e.status !== "cancelled")
      .map((e) => toEvent(e, this.tz))
      .filter((e) => edge(e.start, e.allDay) < to && (e.end === e.start ? edge(e.start, e.allDay) >= from : edge(e.end, e.allDay) > from));
  }

  async add(input: NewEventInput): Promise<CalendarEvent> {
    const body = normalizeNewEvent(input, this.tz);
    const res = await api(this.refresh, "/events", { method: "POST", body: JSON.stringify(body) });
    if (!res.ok) throw apiError(res.status);
    invalidate(this.cacheKey);
    return toEvent((await res.json()) as GoogleEvent, this.tz);
  }

  private async get(id: string): Promise<CalendarEvent> {
    if (!id) throw new CalendarError("CALENDAR_BAD_EVENT", "どの予定か分かりませんでした。");
    const res = await api(this.refresh, `/events/${encodeURIComponent(id)}`);
    if (res.status === 404 || res.status === 410) throw new CalendarError("CALENDAR_EVENT_GONE", "その予定が見つかりませんでした。");
    if (!res.ok) throw apiError(res.status);
    const event = (await res.json()) as GoogleEvent;
    if (event.status === "cancelled") throw new CalendarError("CALENDAR_EVENT_GONE", "その予定は既に削除されています。");
    return toEvent(event, this.tz);
  }

  /** 予定を変更する。時刻だけ変えたときは元の長さを保つ */
  async update(input: EventChangeInput): Promise<{ before: CalendarEvent; after: CalendarEvent }> {
    const before = await this.get(String(input.id ?? "").trim());
    const patch: Record<string, unknown> = {};
    if (input.title?.trim()) patch.summary = input.title.trim().slice(0, 200);
    if (typeof input.location === "string") patch.location = input.location.trim().slice(0, 200);

    const start = input.start?.trim();
    const end = input.end?.trim();
    if (start || end) {
      let range: Record<string, unknown>;
      if (input.allDay || (start && DATE.test(start)) || (!start && before.allDay)) {
        // 終日の予定: 日数を保つ
        const days = before.allDay ? Math.max(1, Math.round((Date.parse(before.end) - Date.parse(before.start)) / 86_400_000)) : 1;
        const first = (start ?? before.start).slice(0, 10);
        range = normalizeNewEvent({ title: before.title, start: first, end: end ?? addDays(first, days - 1), allDay: true }, this.tz);
      } else {
        const oldStart = before.allDay ? undefined : parseDateTime(before.start, this.tz);
        const oldEnd = before.allDay ? undefined : parseDateTime(before.end, this.tz);
        const minutes = oldStart && oldEnd ? Math.max(5, Math.round((oldEnd.getTime() - oldStart.getTime()) / 60_000)) : 60;
        const s = start ?? (oldStart ? localDateTime(oldStart, this.tz) : "");
        if (!DATETIME.test(s)) throw new CalendarError("CALENDAR_BAD_EVENT", "変更後の日時が分かりませんでした。");
        range = normalizeNewEvent({ title: before.title, start: s, end: end ?? addMinutes(s.slice(0, 16), minutes) }, this.tz);
      }
      patch.start = range.start;
      patch.end = range.end;
    }
    if (!Object.keys(patch).length) throw new CalendarError("CALENDAR_BAD_EVENT", "何を変えるのか分かりませんでした。");

    const res = await api(this.refresh, `/events/${encodeURIComponent(before.id)}`, { method: "PATCH", body: JSON.stringify(patch) });
    if (!res.ok) throw apiError(res.status);
    invalidate(this.cacheKey);
    return { before, after: toEvent((await res.json()) as GoogleEvent, this.tz) };
  }

  /** 予定を削除する */
  async remove(id: string): Promise<CalendarEvent> {
    const before = await this.get(String(id ?? "").trim());
    const res = await api(this.refresh, `/events/${encodeURIComponent(before.id)}`, { method: "DELETE" });
    if (!res.ok && res.status !== 410) throw apiError(res.status);
    invalidate(this.cacheKey);
    return before;
  }
}

export interface EventChangeInput {
  id: string;
  title?: string;
  start?: string;
  end?: string;
  location?: string;
  allDay?: boolean;
}
