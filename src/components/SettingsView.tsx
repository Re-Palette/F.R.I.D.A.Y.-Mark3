"use client";

/**
 * SETTINGS 画面。声の速さ・返答・天気の場所・ニュースを変え、各接続の状態を一覧で見る。
 * 変えた設定は脳（Obsidian）に保存されるので、パソコンでもスマホでも同じになる。
 */
import { memo, useCallback, useEffect, useState } from "react";
import type { StatusResponse } from "@/core/types";
import { useBargeIn } from "@/hooks/useBargeIn";
import { useClapWake } from "@/hooks/useClapWake";
import { withReadings } from "@/lib/reading";
import { extensionVersion, hasExtension, KEEP_OPEN_EXTENSION_VERSION, keepOpenWanted, LATEST_EXTENSION_VERSION, syncKeepOpen, versionAtLeast } from "@/lib/tabs";
import { NUDGES_KEY, nudgesEnabled } from "@/hooks/useNudges";
import { useVoiceprint } from "@/hooks/useVoiceprint";
import { checkLocalStatus, probeRoute, useAiRoute, useLocalStatus } from "@/lib/ai-router";
import { DEFAULT_PREFS as DEFAULT_LOCAL_PREFS, describeLocalAiError, diagnoseLocalAi, localAiConfig, localAiHelp, localAiModels, localAiPrefs, saveLocalAiPrefs, streamLocal, type LocalAiPrefs } from "@/lib/local-ai";
import { installOnDeviceSpeech, lastOnDeviceStatus, onDeviceSpeechStatus, type OnDeviceSpeech } from "@/lib/speech";
import { recordVoice } from "@/lib/voice-record";
import { cosine, embedVoice, loadVoiceprintModel, normalize, saveVoiceprint, STRICTNESS, type Strictness, type Voiceprint } from "@/lib/voiceprint";
import { setVoiceInputMode, useVoiceInput, type VoiceInputMode } from "@/lib/voice-input";
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

/** 登録のときに読んでもらう文（いろいろな音が入るように） */
const ENROLL_PHRASES = ["フライデー、今日の予定を教えて", "明日の天気と、やることを確認して", "青学の課題の締め切りはいつだっけ"];
const ENROLL_SECONDS = 4;
/** 3 回の声どうしがこれより似ていなければ、録り直してもらう（雑音・別の人の声が混ざったとき） */
const ENROLL_CONSISTENCY = 0.45;

/** 声紋認証（登録・オン/オフ・厳しさ・確かめる・消す） */
function VoiceprintControls() {
  const print = useVoiceprint();
  const [busy, setBusy] = useState<null | "enroll" | "test">(null);
  const [step, setStep] = useState(0);
  const [progress, setProgress] = useState(0);
  const [level, setLevel] = useState(0);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  const record = useCallback(async () => {
    setProgress(0);
    const audio = await recordVoice(ENROLL_SECONDS, (l, p) => {
      setLevel(l);
      setProgress(p);
    });
    setLevel(0);
    return embedVoice(audio);
  }, []);

  const enroll = useCallback(async () => {
    setNote(null);
    setBusy("enroll");
    try {
      setStep(0);
      setNote({ ok: true, text: "準備しています…（初回だけ声紋の AI を読み込みます）" });
      await loadVoiceprintModel();
      const list: Float32Array[] = [];
      for (let i = 0; i < ENROLL_PHRASES.length; i++) {
        setStep(i + 1);
        setNote(null);
        const e = await record();
        if (!e) {
          setNote({ ok: false, text: "声がうまく録れませんでした。マイクに向かって、はっきり読んでもう一度登録してください。" });
          return;
        }
        list.push(e);
      }
      let worst = 1;
      for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) worst = Math.min(worst, cosine(list[i], list[j]));
      if (worst < ENROLL_CONSISTENCY) {
        setNote({ ok: false, text: "3 回の声のばらつきが大きいです。静かな場所で、いつもの声でもう一度登録してください。" });
        return;
      }
      const sum = new Float32Array(list[0].length);
      for (const e of list) e.forEach((v, k) => (sum[k] += v));
      const v: Voiceprint = {
        embedding: Array.from(normalize(sum), (x) => Math.round(x * 1e6) / 1e6),
        strictness: print?.strictness ?? "normal",
        enabled: true,
        samples: list.length,
        createdAt: new Date().toISOString(),
      };
      await saveVoiceprint(v);
      setNote({ ok: true, text: "登録しました。これからは陽大の声にだけ反応します。" });
    } catch {
      setNote({ ok: false, text: "マイクを使えないか、声紋の AI を読み込めませんでした。マイクの許可と通信を確認してください。" });
    } finally {
      setBusy(null);
      setStep(0);
    }
  }, [print?.strictness, record]);

  const test = useCallback(async () => {
    if (!print) return;
    setNote(null);
    setBusy("test");
    try {
      await loadVoiceprintModel();
      setStep(-1);
      const e = await record();
      if (!e) {
        setNote({ ok: false, text: "声がうまく録れませんでした。もう一度どうぞ。" });
        return;
      }
      const score = cosine(e, print.embedding);
      const ok = score >= STRICTNESS[print.strictness];
      setNote({ ok, text: `${ok ? "本人の声です" : "別の人の声と判定しました"}（近さ ${Math.round(score * 100)} ／ 基準 ${Math.round(STRICTNESS[print.strictness] * 100)}）` });
    } catch {
      setNote({ ok: false, text: "マイクを使えないか、声紋の AI を読み込めませんでした。" });
    } finally {
      setBusy(null);
      setStep(0);
    }
  }, [print, record]);

  const update = (patch: Partial<Voiceprint>) => print && void saveVoiceprint({ ...print, ...patch });

  return (
    <>
      <p className="settings__note">
        状態：
        <b style={{ color: "var(--cyan)" }}>{!print ? "未登録（誰の声にも反応します）" : print.enabled ? "オン（陽大の声にだけ反応）" : "オフ（誰の声にも反応します）"}</b>
      </p>
      {busy && (
        <div className="voiceprint__rec" role="status">
          <b>{step > 0 ? `${step} / ${ENROLL_PHRASES.length}　次の文を読んでください` : step < 0 ? "何か話してください" : "準備中…"}</b>
          {step > 0 && <q>{ENROLL_PHRASES[step - 1]}</q>}
          {step !== 0 && (
            <span className="voiceprint__bar" aria-hidden>
              <i style={{ width: `${Math.round(progress * 100)}%`, opacity: 0.4 + level * 0.6 }} />
            </span>
          )}
        </div>
      )}
      {print && (
        <>
          <span className="settings__label">声紋認証</span>
          <Choice
            value={print.enabled ? "on" : "off"}
            options={[
              { value: "on", label: "陽大の声にだけ反応" },
              { value: "off", label: "誰の声にも反応" },
            ]}
            disabled={Boolean(busy)}
            onChange={(v) => update({ enabled: v === "on" })}
          />
          <span className="settings__label">厳しさ</span>
          <Choice<Strictness>
            value={print.strictness}
            options={[
              { value: "loose", label: "ゆるい" },
              { value: "normal", label: "標準" },
              { value: "strict", label: "厳しい" },
            ]}
            disabled={Boolean(busy)}
            onChange={(v) => update({ strictness: v })}
          />
        </>
      )}
      <div className="settings__actions">
        <button type="button" className="ghost-btn" disabled={Boolean(busy)} onClick={() => void enroll()}>
          <Icon name="mic" size={13} /> {print ? "登録し直す" : "声を登録する"}
        </button>
        {print && (
          <>
            <button type="button" className="ghost-btn" disabled={Boolean(busy)} onClick={() => void test()}>
              確かめる
            </button>
            <button
              type="button"
              className="ghost-btn"
              disabled={Boolean(busy)}
              onClick={() => {
                if (!window.confirm("登録した声紋を消しますか？（誰の声にも反応するようになります）")) return;
                void saveVoiceprint(null);
                setNote({ ok: true, text: "声紋を消しました。" });
              }}
            >
              消す
            </button>
          </>
        )}
      </div>
      {note && (
        <p className="settings__note" data-ok={note.ok || undefined} role="status">
          {note.text}
        </p>
      )}
      <p className="settings__note">
        短い文を 3 回読んで、陽大の声の特徴を登録します。オンの間は、呼びかけ・音声での指示・話の途中の割り込みに、登録した声のときだけ反応します（文字での入力はこれまでどおり）。
        保存するのは声の特徴を表す数字だけで、声そのものは保存も送信もしません。登録はスマホとパソコンで共有します。うまく反応しないときは「ゆるい」にするか、使う端末で登録し直してください。
      </p>
    </>
  );
}

/** オフラインの聞き取り（Chrome の PC の中だけで動く日本語の音声認識）を入れる */
function OfflineSpeechControls({ hidden }: { hidden: boolean }) {
  const [status, setStatus] = useState<OnDeviceSpeech | null>(null);
  const [busy, setBusy] = useState(false);
  // 自動では Chrome に聞かない（環境によってはページが落ちるため）。前に確かめた結果だけ出す
  useEffect(() => {
    if (!hidden) setStatus(lastOnDeviceStatus());
  }, [hidden]);
  const check = async () => {
    setBusy(true);
    setStatus(await onDeviceSpeechStatus());
    setBusy(false);
  };
  const install = async () => {
    setBusy(true);
    await installOnDeviceSpeech();
    setStatus(await onDeviceSpeechStatus());
    setBusy(false);
  };
  const label: Record<OnDeviceSpeech, string> = {
    available: "使えます（ネットが切れていても声で話しかけられます）",
    downloadable: "未導入（下のボタンで入れられます。オンラインのときに 1 回だけ）",
    downloading: "ダウンロード中…",
    unavailable: "この Chrome では日本語のオフライン聞き取りに対応していません",
    unsupported: "このブラウザは非対応です（Chrome を最新にすると使える場合があります）",
  };
  return (
    <>
      <span className="settings__label">オフラインの聞き取り — この端末だけ</span>
      <p className="settings__note">
        状態：<b style={{ color: "var(--cyan)" }}>{status ? label[status] : "まだ確かめていません"}</b>
      </p>
      {status !== "available" && status !== "downloadable" && status !== "downloading" && (
        <div className="settings__actions">
          <button type="button" className="ghost-btn" disabled={busy} onClick={() => void check()}>
            {busy ? "確かめています…" : "オフラインで聞き取れるか確かめる"}
          </button>
        </div>
      )}
      {(status === "downloadable" || status === "downloading") && (
        <div className="settings__actions">
          <button type="button" className="ghost-btn" disabled={busy || status === "downloading"} onClick={() => void install()}>
            <Icon name="mic" size={13} /> {busy ? "入れています…" : "オフラインの聞き取りを入れる"}
          </button>
        </div>
      )}
      <p className="settings__note">ふだんの聞き取りはインターネットを使います。これを入れておくと、ネットが切れたときは PC の中だけで聞き取ります（声はどこにも送りません）。</p>
    </>
  );
}

/** ローカル AI（Ollama）の設定。この端末だけ・オフラインでも変えられる */
function LocalAiControls({ hidden }: { hidden: boolean }) {
  const route = useAiRoute();
  const status = useLocalStatus();
  const [prefs, setPrefs] = useState<LocalAiPrefs>(DEFAULT_LOCAL_PREFS);
  const [models, setModels] = useState<string[] | null | undefined>(undefined);
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [origin, setOrigin] = useState("");
  useEffect(() => {
    setPrefs(localAiPrefs());
    setOrigin(location.origin);
  }, []);
  const refreshModels = useCallback(() => {
    setModels(undefined);
    void localAiModels(AbortSignal.timeout(3000)).then((list) => setModels(list?.filter((m) => !/embed/i.test(m)) ?? null));
    void checkLocalStatus();
  }, []);
  useEffect(() => {
    if (!hidden) refreshModels();
  }, [hidden, refreshModels]);
  const update = (patch: Partial<LocalAiPrefs>) => {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    saveLocalAiPrefs(next);
    setTest(null);
    if (patch.ollamaModel !== undefined) void checkLocalStatus();
  };
  const [elapsed, setElapsed] = useState(0);
  const [phase, setPhase] = useState("");
  /** 接続テスト：Ollama に届くか → 選んだモデルが入っているか → 実際に 1 文答えてもらう */
  const runTest = async () => {
    setTesting(true);
    setTest(null);
    setPhase("Ollama に接続しています…");
    const started = performance.now();
    const tick = window.setInterval(() => setElapsed(Math.round((performance.now() - started) / 1000)), 500);
    setElapsed(0);
    try {
      const check = await diagnoseLocalAi();
      if (!check.ok) {
        setTest({ ok: false, text: check.message });
        void checkLocalStatus();
        return;
      }
      setModels(check.models.filter((m) => !/embed/i.test(m)));
      setPhase(`${localAiConfig().model} で返事を作っています…（初回はモデルの読み込みで時間がかかることがあります）`);
      let text = "";
      let model = "";
      for await (const c of streamLocal({
        system: "あなたは F.R.I.D.A.Y.。必ず日本語で 1 文だけ答える。",
        messages: [{ role: "user", content: "こんにちは。調子はどう？" }],
        signal: AbortSignal.timeout(300_000),
      })) {
        text += c.text;
        if (c.model) model = c.model;
        if (text) setPhase(`返事が届いています：${text.trim().slice(0, 40)}`);
      }
      setTest({ ok: true, text: `${((performance.now() - started) / 1000).toFixed(1)} 秒で返事がありました（${model}）：${text.trim().slice(0, 60)}` });
      void checkLocalStatus();
      void probeRoute();
    } catch (err) {
      const timeout = err instanceof DOMException && err.name === "TimeoutError";
      setTest({
        ok: false,
        text: timeout ? "5 分待っても返事がありませんでした。より小さいモデル（qwen3:0.6b）を選ぶか、Ollama を再起動してもう一度試してください。" : describeLocalAiError(err),
      });
      void checkLocalStatus();
    } finally {
      window.clearInterval(tick);
      setTesting(false);
      setPhase("");
    }
  };
  const statusText = !status
    ? "確かめています…"
    : status.ok
      ? `接続できています（${status.model ?? prefs.ollamaModel}）`
      : status.problem === "no-model"
        ? `接続できますが、モデル「${prefs.ollamaModel}」が入っていません`
        : status.problem === "timeout"
          ? "返事が時間内に届きませんでした（モデルの読み込み中の可能性があります）"
          : "接続できません（Ollama が起動していない、または接続が許可されていません）";
  return (
    <>
      <p className="settings__note">
        いまの答え方：
        <b style={{ color: "var(--cyan)" }}>
          {route.route === "online"
            ? `オンライン（Gemini${prefs.quickLocal ? "。短い会話は Ollama" : ""}）`
            : route.route === "offline"
              ? `オフライン（Ollama${route.localModel ? `・${route.localModel}` : ""} で答えています）`
              : route.route === "unavailable"
                ? "Gemini にも Ollama にも接続できません"
                : "確かめています…"}
        </b>
      </p>
      <p className="settings__note" data-ok={status?.ok || undefined} role="status">
        Ollama：{statusText}
        {status && !status.ok && <> — {localAiHelp(status.problem === "no-model" ? "no-model" : "unavailable")}</>}
      </p>
      <span className="settings__label">使うモデル — この端末だけの設定</span>
      <select className="settings__select" value={prefs.ollamaModel} onChange={(e) => update({ ollamaModel: e.target.value })}>
        {[...new Set([prefs.ollamaModel, ...(models ?? [])])].map((m) => (
          <option key={m} value={m}>
            {m}
            {models && !models.some((x) => x === m || x === `${m}:latest`) ? "（未導入）" : ""}
            {/^friday-fast/.test(m) ? "（モデル自身の指示を使う）" : ""}
          </option>
        ))}
      </select>
      <span className="settings__label">短い会話の返事の長さ</span>
      <Choice<"60" | "120">
        value={String(prefs.replyLength) as "60" | "120"}
        options={[
          { value: "60", label: "短い（60）" },
          { value: "120", label: "普通（120）" },
        ]}
        onChange={(v) => update({ replyLength: v === "120" ? 120 : 60 })}
      />
      <span className="settings__label">短い日常会話（あいさつ・お礼・相づち）</span>
      <Choice
        value={prefs.quickLocal ? "on" : "off"}
        options={[
          { value: "on", label: "Ollama で答える" },
          { value: "off", label: "いつもどおり Gemini" },
        ]}
        onChange={(v) => update({ quickLocal: v === "on" })}
      />
      <span className="settings__label">答える前に考える（THINKING）</span>
      <Choice
        value={prefs.thinking ? "on" : "off"}
        options={[
          { value: "off", label: "考えない（速い）" },
          { value: "on", label: "考える（遅いが丁寧）" },
        ]}
        onChange={(v) => update({ thinking: v === "on" })}
      />
      <div className="settings__actions">
        <button type="button" className="ghost-btn" disabled={testing} onClick={() => void runTest()}>
          {testing ? `テストしています… ${elapsed} 秒` : "接続テスト"}
        </button>
        <button type="button" className="ghost-btn" disabled={testing} onClick={refreshModels}>
          状態とモデルを読み直す
        </button>
      </div>
      {testing && phase && (
        <p className="settings__note" role="status">
          {phase}
        </p>
      )}
      {test && (
        <p className="settings__note" data-ok={test.ok || undefined} role="status">
          {test.text}
        </p>
      )}
      <p className="settings__note">
        ローカル AI は、この PC の Ollama だけを使います。短い日常会話はオンラインでも Ollama がすぐ答えます（予定・ToDo・記憶・検索などの操作や、複雑な相談はいつもどおり Gemini）。Ollama は操作（ツール）を実行しません。インターネットや Gemini が使えないときは Ollama が代わりに答え、記憶・ToDo などはオンラインに戻ったときに反映します。
      </p>
      <p className="settings__note">
        初めて使うとき：Windows の「環境変数を編集」で、ユーザー環境変数 <b>OLLAMA_ORIGINS</b> に <b>{origin || "（FRIDAY のアドレス）"}</b> だけを設定し（「*」で全部を許可しない）、Ollama を終了して起動し直してください。
      </p>
    </>
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
  const [keepOpen, setKeepOpen] = useState(true);
  useEffect(() => setKeepOpen(keepOpenWanted()), []);
  const canKeepOpen = installed === true && versionAtLeast(version, KEEP_OPEN_EXTENSION_VERSION);

  return (
    <>
      {canKeepOpen && (
        <>
          <span className="settings__label">呼びかけで F.R.I.D.A.Y. を開く — この端末だけの設定</span>
          <Choice
            value={keepOpen ? "on" : "off"}
            options={[
              { value: "on", label: "裏で開いておく" },
              { value: "off", label: "開かない" },
            ]}
            onChange={(v) => {
              setKeepOpen(v === "on");
              void syncKeepOpen(v === "on");
            }}
          />
          <p className="settings__note">
            「裏で開いておく」にすると、Chrome を開いたときに F.R.I.D.A.Y. をピン留めのタブで裏に開き、「フライデー」と呼ぶとそのタブが前に出て話を聞きます。
            タブを閉じたときは、次に Chrome を開いたときにまた開きます。
          </p>
        </>
      )}
      <p className="settings__note">
        拡張機能：
        {installed === null ? (
          "確認中…"
        ) : installed && !old ? (
          <b style={{ color: "var(--cyan)" }}>接続済み（開く・閉じる・Amazon Music の操作・インストールしたアプリで開くが使えます）</b>
        ) : installed ? (
          <b style={{ color: "var(--cyan)" }}>古い版（{version ?? "?"}）。入れ直すと、インストールしたアプリ（会社のダッシュボード・Amazon Music など）をアプリのまま開けます</b>
        ) : (
          "未導入"
        )}
      </p>
      {(installed === false || old) && (
        <>
          <p className="settings__note">
            入れると「〇〇開いて」でポップアップが止められずに開き、YouTube や Google のページも「閉じて」で閉じられます。
            さらに、Chrome で開いた Amazon Music（music.amazon.co.jp）を「作業用の音楽かけて」「次の曲」「止めて」「音量下げて」で操作できます（パソコンの Chrome / Edge 用）。
            Chrome にアプリとしてインストールしたサイト（会社のダッシュボード・Amazon Music など）は、「〇〇開いて」でタブではなくアプリで開きます（入れるときに「アプリ、拡張機能、テーマの管理」の許可を求められます）。
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
  const [clapWake, setClapWake] = useClapWake();
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
          <OfflineSpeechControls hidden={hidden} />
          <VoiceInputControls onMessage={(text) => setMessage({ ok: true, text })} />
          <span className="settings__label">拍手 2 回で起動 — この端末だけの設定</span>
          <Choice
            value={clapWake ? "on" : "off"}
            options={[
              { value: "on", label: "起動する" },
              { value: "off", label: "起動しない" },
            ]}
            onChange={(v) => {
              setClapWake(v === "on");
              setMessage({ ok: true, text: v === "on" ? "パン、パンと拍手 2 回で全システムを起動します。" : "拍手では起動しません（「フライデー」の呼びかけは使えます）。" });
            }}
          />
          <p className="settings__note">
            パソコンで音声会話がオンの間、「フライデー」の呼びかけに加えて、拍手 2 回でも起動します（裏のタブでも・オフラインでも）。拍手は声紋認証の対象外です。物音で起動してしまうときは「起動しない」にしてください。
          </p>
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

        <Section title="LOCAL AI" sub="ローカル AI（Ollama）">
          <LocalAiControls hidden={hidden} />
        </Section>

        <Section title="VOICEPRINT" sub="声紋認証">
          <VoiceprintControls />
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

/** 声の聞き取りの方式（Chrome の音声認識／録音してサーバーで文字にする） */
function VoiceInputControls({ onMessage }: { onMessage: (text: string) => void }) {
  const input = useVoiceInput();
  return (
    <>
      <span className="settings__label">声の聞き取り方式 — この端末だけの設定</span>
      <Choice
        value={input.mode}
        options={[
          { value: "auto", label: "自動" },
          { value: "chrome", label: "Chrome の聞き取り" },
          { value: "recorded", label: "録音して文字にする" },
        ]}
        onChange={(v) => {
          setVoiceInputMode(v as VoiceInputMode);
          onMessage(
            v === "recorded"
              ? "録音してサーバーで文字にする方式にしました（ChatGPT などと同じ方式。Chrome で選んだマイクを使います）。"
              : v === "chrome"
                ? "Chrome の聞き取りにしました。"
                : "自動にしました（Chrome の聞き取りで声を聞き取れないときは、録音して文字にする方式に切り替えます）。",
          );
        }}
      />
      <p className="settings__note">
        {input.recorded ? "いまは「録音して文字にする」方式で聞いています。" : "いまは Chrome の聞き取りで聞いています。"}
        マイクの音量は動くのに声に反応しないときは「録音して文字にする」を選んでください（Chrome の聞き取りは Windows の「既定の録音デバイス」を使うため、
        Chrome で選んだマイクと違うと声が届きません）。録音方式は、話した 1 発言ごとの音声を文字にするためだけにサーバーへ送ります（保存はしません）。
      </p>
    </>
  );
}
