"use client";

/**
 * SETTINGS 画面。声の速さ・返答・天気の場所・ニュースを変え、各接続の状態を一覧で見る。
 * 変えた設定は脳（Obsidian）に保存されるので、パソコンでもスマホでも同じになる。
 */
import { memo, useCallback, useEffect, useState } from "react";
import type { StatusResponse } from "@/core/types";
import { useBargeIn } from "@/hooks/useBargeIn";
import { withReadings } from "@/lib/reading";
import { extensionVersion, hasExtension, LATEST_EXTENSION_VERSION, versionAtLeast } from "@/lib/tabs";
import { NUDGES_KEY, nudgesEnabled } from "@/hooks/useNudges";
import { HudFrame } from "./HudFrame";
import { Icon } from "./icons";

interface SettingsData {
  canSave: boolean;
  effective: {
    voiceSpeed: number;
    weatherCity: string;
    search: "auto" | "always" | "off";
    replyLength: "short" | "normal" | "long";
    newsTime: string;
    newsTopics: string[];
  };
}

export interface SettingsStatus {
  chatStatus: string;
  model?: string;
  brain: StatusResponse["brain"];
  calendar: StatusResponse["calendar"];
  tts: StatusResponse["tts"];
  automation: StatusResponse["automation"];
  /** ホログラムに既存の 3D モデル集（Poly Pizza）を使えるか */
  hologramLibrary?: boolean;
  /** Spotify の設定・接続の状態 */
  spotify?: { configured: boolean; connected: boolean };
}

function Section({ title, sub, children }: { title: string; sub?: string; children: React.ReactNode }) {
  return (
    <section className="settings__section hud">
      <HudFrame cut={14} small={6} ticks={false} />
      <h2>
        {title}
        {sub && <span>{sub}</span>}
      </h2>
      {children}
    </section>
  );
}

function Choice<T extends string>({
  value,
  options,
  onChange,
  disabled,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <div className="settings__choice" role="radiogroup">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          data-on={value === o.value || undefined}
          disabled={disabled}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Row({ label, state, detail, children }: { label: string; state: "ok" | "warn" | "off"; detail: string; children?: React.ReactNode }) {
  return (
    <li className="settings__row" data-state={state}>
      <i />
      <b>{label}</b>
      <span>{detail}</span>
      {children}
    </li>
  );
}

/** 公開鍵（base64url）→ ブラウザに渡す形 */
function keyBytes(base64: string): Uint8Array {
  const pad = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/** この端末の名前（通知の宛先一覧の表示用） */
function deviceLabel(): string {
  const ua = navigator.userAgent;
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Mac/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : "端末";
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : /Firefox\//.test(ua) ? "Firefox" : "";
  return `${os}${browser ? ` / ${browser}` : ""}`;
}

interface PushConfig {
  configured: boolean;
  brain: boolean;
  publicKey: string | null;
  cron: boolean;
  devices: { label: string; endpoint: string }[];
}

/** プッシュ通知の登録・テスト・解除 */
function PushControls({ hidden }: { hidden: boolean }) {
  const [config, setConfig] = useState<PushConfig | null>(null);
  const [endpoint, setEndpoint] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  // ブラウザの対応状況は表示後に調べる（サーバーの HTML と食い違わないように）
  const [env, setEnv] = useState<{ supported: boolean; iosBrowser: boolean } | null>(null);
  useEffect(() => {
    setEnv({
      supported: "serviceWorker" in navigator && "PushManager" in window,
      iosBrowser: /iPhone|iPad/.test(navigator.userAgent) && !window.matchMedia("(display-mode: standalone)").matches,
    });
  }, []);
  const supported = env?.supported ?? false;
  const iosBrowser = env?.iosBrowser ?? false;

  const load = useCallback(async () => {
    try {
      setConfig((await (await fetch("/api/push/config", { cache: "no-store" })).json()) as PushConfig);
      const reg = await navigator.serviceWorker?.getRegistration("/sw.js");
      setEndpoint((await reg?.pushManager.getSubscription())?.endpoint ?? null);
    } catch {
      /* 表示は未登録のまま */
    }
  }, []);

  useEffect(() => {
    if (!hidden && supported) void load();
  }, [hidden, load, supported]);

  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    setNote(null);
    try {
      setNote({ ok: true, text: await fn() });
    } catch (err) {
      setNote({ ok: false, text: err instanceof Error ? err.message : "うまくいきませんでした。" });
    } finally {
      setBusy(false);
      void load();
    }
  };

  const subscribe = () =>
    run(async () => {
      if (!config?.publicKey) throw new Error("鍵が設定されていません。");
      if ((await Notification.requestPermission()) !== "granted") throw new Error("通知が許可されませんでした。ブラウザの設定で許可してください。");
      const reg = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
      const sub =
        (await reg.pushManager.getSubscription()) ??
        (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(config.publicKey) as BufferSource }));
      const res = await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscription: sub.toJSON(), label: deviceLabel() }),
      });
      if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error ?? "登録できませんでした。");
      return "この端末で通知を受け取るようにしました。「テスト」で確かめてください。";
    });

  const test = () =>
    run(async () => {
      const res = await fetch("/api/push/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ endpoint }) });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) throw new Error(json.error ?? "送れませんでした。もう一度「受け取る」を押してください。");
      return "テストの通知を送りました。";
    });

  const unsubscribe = () =>
    run(async () => {
      const reg = await navigator.serviceWorker.getRegistration("/sw.js");
      const sub = await reg?.pushManager.getSubscription();
      if (sub) {
        await fetch("/api/push/subscribe", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ endpoint: sub.endpoint }) });
        await sub.unsubscribe();
      }
      return "この端末では通知を受け取らないようにしました。";
    });

  if (!env) return <p className="settings__note">読み込み中…</p>;
  if (!supported) return <p className="settings__note">このブラウザはプッシュ通知に対応していません。</p>;
  if (iosBrowser)
    return <p className="settings__note">iPhone では、Safari の共有ボタン →「ホーム画面に追加」で開いた F.R.I.D.A.Y. から設定できます。</p>;
  if (!config) return <p className="settings__note">読み込み中…</p>;
  if (!config.configured)
    return (
      <>
        <p className="settings__note">通知の鍵がまだ設定されていません。下のボタンで鍵を作り、Vercel の環境変数に入れてください。</p>
        <a className="ghost-btn" href="/api/push/keys" target="_blank" rel="noreferrer">
          鍵を作る
        </a>
      </>
    );

  return (
    <>
      <div className="settings__actions">
        {endpoint ? (
          <>
            <button type="button" className="ghost-btn" disabled={busy} onClick={() => void test()}>
              テスト
            </button>
            <button type="button" className="ghost-btn" disabled={busy} onClick={() => void unsubscribe()}>
              この端末で受け取らない
            </button>
          </>
        ) : (
          <button type="button" className="ghost-btn" disabled={busy || !config.brain} onClick={() => void subscribe()}>
            <Icon name="bell" size={13} /> この端末で受け取る
          </button>
        )}
      </div>
      {note && (
        <p className="settings__note" style={{ color: note.ok ? "var(--cyan)" : "var(--red)" }}>
          {note.text}
        </p>
      )}
      <p className="settings__note">
        受け取る端末：{config.devices.length ? config.devices.map((d) => d.label).join("、") : "なし"}
        {!config.cron && "（自動で送るには GitHub の設定が必要です）"}
      </p>
    </>
  );
}

/** Web ページを開く・閉じるための Chrome 拡張機能 */
function BrowserControls({ hidden }: { hidden: boolean }) {
  const [installed, setInstalled] = useState<boolean | null>(null);
  const [version, setVersion] = useState<string | undefined>();
  useEffect(() => {
    if (hidden) return;
    void hasExtension().then((ok) => {
      setInstalled(ok);
      setVersion(extensionVersion());
    });
  }, [hidden]);
  // 古い版は一部の機能が使えない（Amazon Music の操作・インストールしたアプリで開く）。入れ直しが要る
  const old = installed === true && !versionAtLeast(version, LATEST_EXTENSION_VERSION);

  return (
    <>
      <p className="settings__note">
        拡張機能：
        {installed === null ? (
          "確認中…"
        ) : installed && !old ? (
          <b style={{ color: "var(--cyan)" }}>接続済み（開く・閉じる・Amazon Music の操作・インストールしたアプリで開くが使えます）</b>
        ) : installed ? (
          <b style={{ color: "var(--cyan)" }}>古い版（{version ?? "?"}）。入れ直すと、インストールしたアプリ（会社のダッシュボードなど）をアプリのまま開けます</b>
        ) : (
          "未導入"
        )}
      </p>
      {(installed === false || old) && (
        <>
          <p className="settings__note">
            入れると「〇〇開いて」でポップアップが止められずに開き、YouTube や Google のページも「閉じて」で閉じられます。
            さらに、Chrome で開いた Amazon Music（music.amazon.co.jp）を「作業用の音楽かけて」「次の曲」「止めて」「音量下げて」で操作できます（パソコンの Chrome / Edge 用）。
            Chrome にアプリとしてインストールしたサイト（会社のダッシュボードなど）は、「〇〇開いて」でタブではなくアプリで開きます（入れるときに「アプリ、拡張機能、テーマの管理」の許可を求められます）。
          </p>
          <div className="settings__actions">
            <a className="ghost-btn" href="/friday-extension.zip" download>
              拡張機能をダウンロード
            </a>
          </div>
          <ol className="settings__note">
            <li>ダウンロードした ZIP を右クリック →「すべて展開」</li>
            <li>アドレスバーに chrome://extensions（Edge は edge://extensions）と入れて開く</li>
            {old && <li>前に入れた「F.R.I.D.A.Y. Tabs」を「削除」する</li>}
            <li>右上（Edge は左下）の「デベロッパー モード」をオン</li>
            <li>「パッケージ化されていない拡張機能を読み込む」→ 展開した「friday-extension」フォルダを選ぶ</li>
            <li>この画面と、開いている Amazon Music のタブを再読み込み</li>
          </ol>
        </>
      )}
    </>
  );
}

export const SettingsView = memo(function SettingsView({
  hidden,
  status,
  onChanged,
}: {
  hidden: boolean;
  status: SettingsStatus;
  onChanged: () => void;
}) {
  const [data, setData] = useState<SettingsData | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [city, setCity] = useState("");
  const [newsTime, setNewsTime] = useState("");
  const [topics, setTopics] = useState("");
  const [speed, setSpeed] = useState(0.95);
  const [notify, setNotify] = useState<string>("default");
  const [bargeIn, setBargeIn] = useBargeIn();
  const [nudgesOn, setNudgesOn] = useState(true);
  useEffect(() => setNudgesOn(nudgesEnabled()), []);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/settings", { cache: "no-store" });
      const json = (await res.json()) as SettingsData;
      setData(json);
      setCity(json.effective.weatherCity);
      setNewsTime(json.effective.newsTime);
      setTopics(json.effective.newsTopics.join("、"));
      setSpeed(json.effective.voiceSpeed);
    } catch {
      setMessage({ ok: false, text: "設定を読み込めませんでした。" });
    }
  }, []);

  useEffect(() => {
    if (hidden) return;
    void load();
    if ("Notification" in window) setNotify(Notification.permission);
  }, [hidden, load]);

  const save = useCallback(
    async (change: Record<string, unknown>, done: string) => {
      setBusy(true);
      setMessage(null);
      try {
        const res = await fetch("/api/settings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(change),
        });
        const json = (await res.json()) as SettingsData & { error?: string };
        if (!res.ok) throw new Error(json.error ?? "保存できませんでした。");
        setData(json);
        setCity(json.effective.weatherCity);
        setMessage({ ok: true, text: done });
        onChanged();
      } catch (err) {
        setMessage({ ok: false, text: err instanceof Error ? err.message : "保存できませんでした。" });
      } finally {
        setBusy(false);
      }
    },
    [onChanged],
  );

  const testVoice = () => {
    const text = "こんにちは。この速さで話します。";
    if (status.tts.provider === "elevenlabs") void new Audio(`/api/tts?text=${encodeURIComponent(text)}`).play().catch(() => {});
    else if ("speechSynthesis" in window) {
      const u = new SpeechSynthesisUtterance(withReadings(text));
      u.lang = "ja-JP";
      u.rate = Math.min(1.8, Math.max(0.8, (speed / 1.15) * 1.25));
      u.pitch = 0.85;
      window.speechSynthesis.speak(u);
    }
  };

  const disconnectSpotify = async () => {
    await fetch("/api/spotify/disconnect", { method: "POST" }).catch(() => {});
    setMessage({ ok: true, text: "この端末の Spotify 接続を解除しました。" });
    onChanged();
  };

  const disconnectGoogle = async () => {
    await fetch("/api/calendar/disconnect", { method: "POST" }).catch(() => {});
    setMessage({ ok: true, text: "この端末の Google 接続を解除しました。" });
    onChanged();
  };

  const e = data?.effective;
  const locked = !data?.canSave || busy;

  return (
    <section className="settings" data-active={!hidden || undefined} aria-hidden={hidden} inert={hidden} aria-label="設定">
      <header className="settings__bar">
        <div>
          <div className="settings__title">SETTINGS</div>
          <div className="settings__sub">
            {data && !data.canSave ? "設定の保存には脳（Obsidian）の接続が必要です" : "変えた設定は脳に保存され、どの端末でも同じになります"}
          </div>
        </div>
        {message && (
          <p className="settings__msg" data-ok={message.ok || undefined} role="status">
            {message.text}
          </p>
        )}
      </header>

      <div className="settings__grid">
        <Section title="VOICE" sub="声">
          <label className="settings__field">
            <span>
              読み上げの速さ <b>{speed.toFixed(2)}</b>
            </span>
            <input
              type="range"
              min={0.7}
              max={1.2}
              step={0.05}
              value={speed}
              disabled={locked}
              onChange={(ev) => setSpeed(Number(ev.target.value))}
            />
          </label>
          <div className="settings__actions">
            <button type="button" className="ghost-btn" onClick={testVoice}>
              <Icon name="mic" size={13} /> 試しに聞く
            </button>
            <button type="button" className="ghost-btn" disabled={locked} onClick={() => void save({ voiceSpeed: speed }, "読み上げの速さを保存しました。")}>
              保存
            </button>
          </div>
          <p className="settings__note">声：{status.tts.provider === "elevenlabs" ? "ElevenLabs" : "ブラウザの声"}（ElevenLabs は保存後の次の返答から）</p>
          <span className="settings__label">話している間も聞く（割り込み）— この端末だけの設定</span>
          <Choice
            value={bargeIn ? "on" : "off"}
            options={[
              { value: "on", label: "聞く（ヘッドホン向け）" },
              { value: "off", label: "聞かない（スピーカー向け）" },
            ]}
            onChange={(v) => {
              setBargeIn(v === "on");
              setMessage({ ok: true, text: v === "on" ? "話している間も聞きます（割り込みできます）。" : "話している間はマイクを止めます。" });
            }}
          />
          <p className="settings__note">F.R.I.D.A.Y. が自分の声を聞き取ってしまうときは「聞かない」にしてください。</p>
          <span className="settings__label">先回りの声かけ — この端末だけの設定</span>
          <Choice
            value={nudgesOn ? "on" : "off"}
            options={[
              { value: "on", label: "話しかける" },
              { value: "off", label: "話しかけない" },
            ]}
            onChange={(v) => {
              setNudgesOn(v === "on");
              try {
                localStorage.setItem(NUDGES_KEY, v);
              } catch {
                /* noop */
              }
              setMessage({ ok: true, text: v === "on" ? "予定の前・締め切り・雨の日に、F.R.I.D.A.Y. から声をかけます。" : "F.R.I.D.A.Y. から話しかけるのをやめます。" });
            }}
          />
          <p className="settings__note">予定の 20 分前・今日 / 明日が締め切りの ToDo・雨の日の朝に、F.R.I.D.A.Y. のほうから一言話します（画面を開いている間だけ）。</p>
        </Section>

        <Section title="REPLY" sub="返答">
          <span className="settings__label">返答の長さ</span>
          <Choice
            value={e?.replyLength ?? "normal"}
            disabled={locked}
            options={[
              { value: "short", label: "短め" },
              { value: "normal", label: "普通" },
              { value: "long", label: "詳しめ" },
            ]}
            onChange={(v) => void save({ replyLength: v }, "返答の長さを保存しました。")}
          />
          <span className="settings__label">Web 検索</span>
          <Choice
            value={e?.search ?? "auto"}
            disabled={locked}
            options={[
              { value: "auto", label: "必要なときだけ" },
              { value: "always", label: "いつも" },
              { value: "off", label: "使わない" },
            ]}
            onChange={(v) => void save({ search: v }, "Web 検索の設定を保存しました。")}
          />
          <p className="settings__note">「いつも」は無料枠の検索回数を早く使い切ることがあります。</p>
        </Section>

        <Section title="WEATHER" sub="天気の場所">
          <form
            className="settings__inline"
            onSubmit={(ev) => {
              ev.preventDefault();
              void save({ weatherCity: city }, `天気の場所を「${city}」にしました。`);
            }}
          >
            <input value={city} onChange={(ev) => setCity(ev.target.value)} placeholder="例：渋谷区、大阪市、札幌" disabled={locked} />
            <button type="submit" className="ghost-btn" disabled={locked || !city.trim()}>
              保存
            </button>
          </form>
          <p className="settings__note">市区町村名で探します。</p>
        </Section>

        <Section title="NEWS" sub="毎日のニュース">
          <form
            className="settings__stack"
            onSubmit={(ev) => {
              ev.preventDefault();
              void save(
                { newsTime, newsTopics: topics.split(/[,、，\n]/).map((t) => t.trim()).filter(Boolean) },
                "ニュースの設定を保存しました。",
              );
            }}
          >
            <label className="settings__field">
              <span>時間（この時刻以降の最初の会話で伝える。off で自動なし）</span>
              <input value={newsTime} onChange={(ev) => setNewsTime(ev.target.value)} placeholder="07:00" disabled={locked} />
            </label>
            <label className="settings__field">
              <span>興味のある分野（「、」区切り）</span>
              <input value={topics} onChange={(ev) => setTopics(ev.target.value)} placeholder="AI、ファッション、サッカー" disabled={locked} />
            </label>
            <button type="submit" className="ghost-btn" disabled={locked}>
              保存
            </button>
          </form>
        </Section>

        <Section title="PUSH" sub="アプリを閉じていても通知">
          <PushControls hidden={hidden} />
        </Section>

        <Section title="BROWSER" sub="Web ページを開く・閉じる">
          <BrowserControls hidden={hidden} />
        </Section>

        <Section title="LINKS" sub="接続の状態">
          <ul className="settings__rows">
            <Row label="Gemini" state={status.chatStatus === "online" ? "ok" : "warn"} detail={status.model ?? "—"} />
            <Row
              label="脳（Obsidian）"
              state={status.brain.connected ? "ok" : status.brain.configured ? "warn" : "off"}
              detail={status.brain.connected ? `${status.brain.notes ?? 0} ノート` : status.brain.configured ? (status.brain.reason ?? "接続できません") : "未設定"}
            />
            <Row
              label="Google カレンダー"
              state={status.calendar.connected ? "ok" : status.calendar.configured ? "warn" : "off"}
              detail={status.calendar.connected ? "この端末で接続中" : status.calendar.configured ? "未接続" : "未設定"}
            >
              {status.calendar.configured &&
                (status.calendar.connected ? (
                  <button type="button" className="ghost-btn" onClick={() => void disconnectGoogle()}>
                    解除
                  </button>
                ) : (
                  <a className="ghost-btn" href="/api/calendar/connect">
                    接続
                  </a>
                ))}
            </Row>
            <Row
              label="Gmail"
              state={status.calendar.gmail && status.calendar.gmailDraft ? "ok" : status.calendar.connected ? "warn" : "off"}
              detail={
                !status.calendar.connected
                  ? "Google 未接続"
                  : status.calendar.gmail && status.calendar.gmailDraft
                    ? "読める・下書きを作れる（送信はしない）"
                    : status.calendar.gmail
                      ? "読める（下書きは再接続が必要）"
                      : "許可が必要"
              }
            >
              {status.calendar.connected && !(status.calendar.gmail && status.calendar.gmailDraft) && (
                <a className="ghost-btn" href="/api/calendar/connect">
                  再接続
                </a>
              )}
            </Row>
            <Row
              label="ElevenLabs"
              state={status.tts.provider === "elevenlabs" ? "ok" : status.tts.reason ? "warn" : "off"}
              detail={status.tts.provider === "elevenlabs" ? "使用中" : (status.tts.reason ?? "未設定（ブラウザの声）")}
            />
            <Row
              label="Spotify"
              state={status.spotify?.connected ? "ok" : status.spotify?.configured ? "warn" : "off"}
              detail={
                status.spotify?.connected
                  ? "この端末で接続中（再生の操作は Premium が必要）"
                  : status.spotify?.configured
                    ? "未接続"
                    : "SPOTIFY_CLIENT_ID / SECRET 未設定"
              }
            >
              {status.spotify?.configured &&
                (status.spotify.connected ? (
                  <button type="button" className="ghost-btn" onClick={() => void disconnectSpotify()}>
                    解除
                  </button>
                ) : (
                  <a className="ghost-btn" href="/api/spotify/connect">
                    接続
                  </a>
                ))}
            </Row>
            <Row
              label="3D モデル"
              state={status.hologramLibrary ? "ok" : "off"}
              detail={status.hologramLibrary ? "Poly Pizza から探す" : "POLY_PIZZA_API_KEY 未設定（部品で組み立て）"}
            />
            <Row label="自動日記" state={status.automation.diary ? "ok" : "off"} detail={status.automation.diary ? "毎晩 23 時ごろ" : "CRON_SECRET 未設定"} />
            <Row label="通知" state={notify === "granted" ? "ok" : notify === "denied" ? "warn" : "off"} detail={notify === "granted" ? "許可済み" : notify === "denied" ? "ブロック中（ブラウザの設定で許可）" : "未許可"}>
              {notify === "default" && (
                <button type="button" className="ghost-btn" onClick={() => void Notification.requestPermission().then(setNotify)}>
                  許可
                </button>
              )}
            </Row>
          </ul>
        </Section>
      </div>
    </section>
  );
});
