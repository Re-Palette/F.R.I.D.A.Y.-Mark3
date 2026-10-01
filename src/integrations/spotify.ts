/**
 * Spotify の操作（サーバー専用）。会話で「〇〇かけて」「次の曲」「音量下げて」と頼まれたときに使う。
 *
 *   ブラウザ →「接続」→ Spotify のログイン・許可 → /api/spotify/callback
 *   → 更新用トークンを暗号化して Cookie に保存（その端末で有効）
 *
 * - 再生の操作は Spotify Premium が必要（Spotify の決まり）。音は、開いている Spotify アプリ（パソコン・スマホ）から出る。
 * - クライアント ID / シークレット・トークンはブラウザに渡さない。
 */
import { readCookie, seal, unseal } from "@/lib/secure-cookie";

export const SPOTIFY_COOKIE = "friday_spotify";
export const SPOTIFY_STATE_COOKIE = "friday_spotify_state";
export const SPOTIFY_COOKIE_MAX_AGE = 60 * 60 * 24 * 400;
const SCOPE = "user-read-playback-state user-modify-playback-state user-read-currently-playing";

function config() {
  const env = (k: string) => process.env[k]?.trim() || undefined;
  return {
    clientId: env("SPOTIFY_CLIENT_ID"),
    clientSecret: env("SPOTIFY_CLIENT_SECRET"),
    // テスト用に差し替え可能
    accounts: (env("SPOTIFY_ACCOUNTS_BASE") ?? "https://accounts.spotify.com").replace(/\/+$/, ""),
    api: (env("SPOTIFY_API_BASE") ?? "https://api.spotify.com/v1").replace(/\/+$/, ""),
  };
}

export function isSpotifyConfigured(): boolean {
  const c = config();
  return Boolean(c.clientId && c.clientSecret);
}

export class SpotifyError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/* ---------- 接続（OAuth） ---------- */

export function spotifyRedirectUri(req: Request): string {
  const url = new URL(req.url);
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? url.host;
  const proto = req.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
  return `${proto}://${host}/api/spotify/callback`;
}

export function spotifyAuthUrl(redirect: string, state: string): string {
  const c = config();
  const params = new URLSearchParams({ client_id: c.clientId ?? "", response_type: "code", redirect_uri: redirect, scope: SCOPE, state });
  return `${c.accounts}/authorize?${params}`;
}

async function tokenRequest(params: Record<string, string>): Promise<{ access_token?: string; refresh_token?: string; expires_in?: number }> {
  const c = config();
  let res: Response;
  try {
    res = await fetch(`${c.accounts}/api/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(`${c.clientId}:${c.clientSecret}`).toString("base64")}`,
      },
      body: new URLSearchParams(params),
      signal: AbortSignal.timeout(8000),
      cache: "no-store",
    });
  } catch {
    throw new SpotifyError("SPOTIFY_NETWORK", "Spotify に接続できませんでした。");
  }
  const json = (await res.json().catch(() => ({}))) as { error?: string; access_token?: string; refresh_token?: string; expires_in?: number };
  if (res.ok) return json;
  if (json.error === "invalid_grant") throw new SpotifyError("SPOTIFY_EXPIRED", "Spotify の接続が切れました。SETTINGS の SPOTIFY からもう一度接続してください。");
  if (json.error === "invalid_client") throw new SpotifyError("SPOTIFY_CLIENT", "Spotify のクライアント ID / シークレットが正しくありません。");
  throw new SpotifyError("SPOTIFY_UPSTREAM", `Spotify でエラーが発生しました（${res.status}）。`);
}

export async function exchangeSpotifyCode(code: string, redirect: string): Promise<string> {
  const json = await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: redirect });
  if (!json.refresh_token) throw new SpotifyError("SPOTIFY_NO_REFRESH", "Spotify から更新用トークンを受け取れませんでした。");
  return json.refresh_token;
}

export const sealSpotifyToken = (token: string) => seal(token, config().clientSecret ?? "");

/** Cookie から更新用トークンを取り出す（未接続なら undefined） */
export function spotifyTokenFrom(req: Request): string | undefined {
  if (!isSpotifyConfigured()) return undefined;
  return unseal(readCookie(req, SPOTIFY_COOKIE), config().clientSecret ?? "");
}

const accessCache = new Map<string, { token: string; until: number }>();

async function accessToken(refresh: string): Promise<string> {
  const hit = accessCache.get(refresh);
  if (hit && hit.until > Date.now()) return hit.token;
  const json = await tokenRequest({ grant_type: "refresh_token", refresh_token: refresh });
  if (!json.access_token) throw new SpotifyError("SPOTIFY_UPSTREAM", "Spotify からアクセス用トークンを受け取れませんでした。");
  if (accessCache.size > 20) accessCache.clear();
  accessCache.set(refresh, { token: json.access_token, until: Date.now() + Math.max(60, (json.expires_in ?? 3600) - 120) * 1000 });
  return json.access_token;
}

/* ---------- 操作 ---------- */

export interface NowPlaying {
  playing: boolean;
  title?: string;
  artist?: string;
  device?: string;
  volume?: number;
  shuffle?: boolean;
}

export type MusicKind = "track" | "playlist" | "album" | "artist";

export interface MusicCommand {
  action: "play" | "pause" | "resume" | "next" | "previous" | "volume" | "shuffle";
  /** play: 探す言葉（無ければ、止めた所から再開） */
  query?: string;
  kind?: MusicKind;
  /** volume: 0〜100、または "up" / "down" */
  value?: number | "up" | "down";
  /** shuffle: オン / オフ */
  on?: boolean;
}

interface Device {
  id: string;
  name: string;
  is_active: boolean;
  is_restricted: boolean;
  volume_percent?: number | null;
}

export class SpotifyAccess {
  constructor(private readonly refresh: string) {}

  private async call(method: string, path: string, body?: unknown): Promise<Response> {
    const token = await accessToken(this.refresh);
    try {
      return await fetch(`${config().api}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(8000),
        cache: "no-store",
      });
    } catch {
      throw new SpotifyError("SPOTIFY_NETWORK", "Spotify に接続できませんでした。");
    }
  }

  private async fail(res: Response): Promise<never> {
    const json = (await res.json().catch(() => ({}))) as { error?: { reason?: string; message?: string } };
    const reason = json.error?.reason ?? "";
    if (res.status === 401) throw new SpotifyError("SPOTIFY_EXPIRED", "Spotify の接続が切れました。SETTINGS の SPOTIFY からもう一度接続してください。");
    if (reason === "PREMIUM_REQUIRED" || (res.status === 403 && /premium/i.test(json.error?.message ?? "")))
      throw new SpotifyError("SPOTIFY_PREMIUM", "再生の操作には Spotify Premium が必要です。");
    if (reason === "NO_ACTIVE_DEVICE" || res.status === 404)
      throw new SpotifyError("SPOTIFY_NO_DEVICE", "音を出す Spotify が見つかりません。パソコンかスマホで Spotify アプリを開いてから、もう一度頼んでください。");
    if (res.status === 429) throw new SpotifyError("SPOTIFY_RATE", "Spotify への操作が多すぎます。少し待ってからもう一度どうぞ。");
    throw new SpotifyError("SPOTIFY_UPSTREAM", `Spotify でエラーが発生しました（${res.status}）。`);
  }

  /** いま流れている曲 */
  async nowPlaying(): Promise<NowPlaying> {
    const res = await this.call("GET", "/me/player");
    if (res.status === 204) return { playing: false };
    if (!res.ok) return this.fail(res);
    const j = (await res.json()) as {
      is_playing?: boolean;
      shuffle_state?: boolean;
      device?: { name?: string; volume_percent?: number | null };
      item?: { name?: string; artists?: { name: string }[]; show?: { name?: string } } | null;
    };
    return {
      playing: Boolean(j.is_playing),
      title: j.item?.name,
      artist: j.item?.artists?.map((a) => a.name).join(", ") || j.item?.show?.name,
      device: j.device?.name,
      volume: j.device?.volume_percent ?? undefined,
      shuffle: j.shuffle_state,
    };
  }

  /** 音を出す端末。再生中のものが無ければ、開いている Spotify に切り替える */
  private async device(): Promise<Device> {
    const res = await this.call("GET", "/me/player/devices");
    if (!res.ok) return this.fail(res);
    const list = ((await res.json()) as { devices?: Device[] }).devices?.filter((d) => !d.is_restricted) ?? [];
    const active = list.find((d) => d.is_active);
    if (active) return active;
    const first = list[0];
    if (!first)
      throw new SpotifyError("SPOTIFY_NO_DEVICE", "音を出す Spotify が見つかりません。パソコンかスマホで Spotify アプリを開いてから、もう一度頼んでください。");
    const moved = await this.call("PUT", "/me/player", { device_ids: [first.id], play: false });
    if (!moved.ok && moved.status !== 204) return this.fail(moved);
    return first;
  }

  /** 曲・プレイリスト・アルバム・アーティストを探す */
  private async find(query: string, kind: MusicKind): Promise<{ uri: string; label: string } | null> {
    const res = await this.call("GET", `/search?${new URLSearchParams({ q: query, type: kind, limit: "5", market: "from_token" })}`);
    if (!res.ok) return this.fail(res);
    const j = (await res.json()) as Record<string, { items?: ({ uri?: string; name?: string; artists?: { name: string }[]; owner?: { display_name?: string } } | null)[] }>;
    const item = (j[`${kind}s`]?.items ?? []).find((x) => x?.uri);
    if (!item?.uri) return null;
    const by = item.artists?.[0]?.name ?? (kind === "playlist" ? item.owner?.display_name : undefined);
    return { uri: item.uri, label: by ? `${item.name}（${by}）` : (item.name ?? query) };
  }

  /** 頼まれた操作をして、画面に出す短い説明を返す */
  async run(cmd: MusicCommand): Promise<string> {
    const ok = async (res: Response) => {
      if (!res.ok && res.status !== 204 && res.status !== 202) await this.fail(res);
    };
    if (cmd.action === "play" && cmd.query?.trim()) {
      const kind: MusicKind = cmd.kind && ["track", "playlist", "album", "artist"].includes(cmd.kind) ? cmd.kind : "playlist";
      const hit = (await this.find(cmd.query.trim(), kind)) ?? (kind !== "track" ? await this.find(cmd.query.trim(), "track") : null);
      if (!hit) throw new SpotifyError("SPOTIFY_NOT_FOUND", `「${cmd.query}」は Spotify で見つかりませんでした。`);
      const dev = await this.device();
      const body = hit.uri.startsWith("spotify:track:") ? { uris: [hit.uri] } : { context_uri: hit.uri };
      await ok(await this.call("PUT", `/me/player/play?device_id=${encodeURIComponent(dev.id)}`, body));
      return `再生：${hit.label}`;
    }
    if (cmd.action === "play" || cmd.action === "resume") {
      const dev = await this.device();
      await ok(await this.call("PUT", `/me/player/play?device_id=${encodeURIComponent(dev.id)}`));
      return "再生を再開";
    }
    if (cmd.action === "pause") {
      await ok(await this.call("PUT", "/me/player/pause"));
      return "一時停止";
    }
    if (cmd.action === "next") {
      await ok(await this.call("POST", "/me/player/next"));
      return "次の曲";
    }
    if (cmd.action === "previous") {
      await ok(await this.call("POST", "/me/player/previous"));
      return "前の曲";
    }
    if (cmd.action === "shuffle") {
      const on = cmd.on !== false;
      await ok(await this.call("PUT", `/me/player/shuffle?state=${on}`));
      return on ? "シャッフル：オン" : "シャッフル：オフ";
    }
    // 音量
    const now = cmd.value === "up" || cmd.value === "down" ? ((await this.nowPlaying()).volume ?? 50) : 0;
    const target =
      cmd.value === "up" ? now + 15 : cmd.value === "down" ? now - 15 : typeof cmd.value === "number" ? cmd.value : NaN;
    if (!Number.isFinite(target)) throw new SpotifyError("SPOTIFY_BAD", "音量の指定を読み取れませんでした。");
    const v = Math.round(Math.min(100, Math.max(0, target)));
    await ok(await this.call("PUT", `/me/player/volume?volume_percent=${v}`));
    return `音量：${v}%`;
  }
}

/** 音楽について話しているか（「〇〇かけて」「次の曲」「音量」「Spotify」など） */
export function asksForMusic(text: string): boolean {
  return /spotify|スポティファイ|音楽|曲|BGM|ＢＧＭ|プレイリスト|アルバム|かけて|流して|再生|一時停止|止めて|音量|ボリューム|シャッフル|スキップ|聴きたい|聞きたい/i.test(text);
}
