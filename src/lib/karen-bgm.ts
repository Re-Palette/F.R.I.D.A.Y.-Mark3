/**
 * K.A.R.E.N. を開いている間に流す BGM（自分で用意した MP3 をループ再生）。画面側だけで動く。
 *   曲：K.A.R.E.N. の画面で選んだファイル（この端末の IndexedDB にしまう）。無ければ public/karen-bgm.mp3（置いてあれば）。
 *   K.A.R.E.N. に切り替えたらすぐ（切り替えの演出を待たずに）流し、F.R.I.D.A.Y. に戻したらすぐ止める。タブが裏の間は止める。
 *   曲は画面を開いたときに先に読み込んでおくので、切り替えた瞬間に鳴る。開き直すたびに曲の初めから流す。
 *   声で話しかけている間・返事を読み上げている間は小さくする（声が聞き取りにくくならないように）。
 *   ブラウザが勝手な再生を止めたとき（声で開いたときなど）は、次に画面を触ったときに流し始める。
 */
import { useSyncExternalStore } from "react";
import { getLocal, setLocal } from "./local-store";

const FILE_KEY = "karen.bgm.file.v1";
const PREF_KEY = "karen.bgm.prefs.v1";
/** リポジトリの public/ に置いたときの曲（選んだ曲が無いときに使う） */
const DEFAULT_URL = "/karen-bgm.mp3";
/** 曲の大きさの上限（大きすぎると端末の保存場所を圧迫する） */
const MAX_BYTES = 40 * 1024 * 1024;
/** 声に合わせて小さくする・戻すときだけ、少しなめらかに変える */
const DUCK_FADE_MS = 300;
/** 声を聞いている・話している間の音量の割合 */
const DUCK = 0.2;

export interface BgmPrefs {
  on: boolean;
  /** 0〜1 */
  volume: number;
}

export interface BgmState extends BgmPrefs {
  /** 流す曲があるか（選んだ曲・既定の曲） */
  hasTrack: boolean;
  /** 曲の名前（選んだファイル名。既定の曲なら null） */
  name: string | null;
  /** いま鳴っているか */
  playing: boolean;
  /** ブラウザに止められて、画面を触るのを待っている */
  blocked: boolean;
}

let state: BgmState = { on: true, volume: 0.45, hasTrack: false, name: null, playing: false, blocked: false };
const listeners = new Set<() => void>();
const set = (next: Partial<BgmState>) => {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
};

export function useBgm(): BgmState {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      void load();
      return () => listeners.delete(fn);
    },
    () => state,
    () => state,
  );
}

let audio: HTMLAudioElement | null = null;
let srcUrl: string | null = null;
let loaded: Promise<void> | null = null;
/** K.A.R.E.N. が開いているか */
let wanted = false;
/** 声を聞いている・話しているか（音量を下げる） */
let ducked = false;
let fadeRaf = 0;

function el(): HTMLAudioElement {
  if (!audio) {
    audio = new Audio();
    audio.loop = true;
    audio.preload = "auto";
    audio.volume = 0;
    audio.addEventListener("playing", () => set({ playing: true, blocked: false }));
    audio.addEventListener("pause", () => set({ playing: false }));
    audio.addEventListener("error", () => set({ playing: false }));
  }
  return audio;
}

/** 選んだ曲（無ければ既定の曲があるか）を読み込む。1 回だけ */
function load(): Promise<void> {
  loaded ??= (async () => {
    const prefs = await getLocal<BgmPrefs>(PREF_KEY);
    if (prefs) set({ on: prefs.on !== false, volume: clamp(prefs.volume ?? state.volume) });
    const file = await getLocal<{ name: string; type: string; data: ArrayBuffer }>(FILE_KEY);
    if (file?.data instanceof ArrayBuffer) {
      setTrack(new Blob([file.data], { type: file.type || "audio/mpeg" }), file.name);
      return;
    }
    // 既定の曲（public/karen-bgm.mp3）を置いてあれば使う
    const ok = await fetch(DEFAULT_URL, { method: "HEAD", cache: "no-store" })
      .then((r) => r.ok && /audio|mpeg|octet/.test(r.headers.get("content-type") ?? "audio"))
      .catch(() => false);
    if (ok) {
      el().src = DEFAULT_URL;
      set({ hasTrack: true, name: null });
    }
  })();
  return loaded;
}

function setTrack(blob: Blob, name: string) {
  if (srcUrl) URL.revokeObjectURL(srcUrl);
  srcUrl = URL.createObjectURL(blob);
  el().src = srcUrl;
  set({ hasTrack: true, name });
}

const clamp = (v: number) => Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0.45));
const target = () => (wanted && state.on && !document.hidden ? state.volume * (ducked ? DUCK : 1) : 0);

/** 今の状態に合わせて、なめらかに音量を変える（0 になったら止める） */
function apply(fade = false) {
  if (!state.hasTrack || typeof document === "undefined") return;
  const a = el();
  const goal = target();
  cancelAnimationFrame(fadeRaf);
  // 切り替え・ON/OFF・音量はすぐに反映する（ふわっとさせない）
  if (!fade || document.hidden || a.paused) {
    a.volume = goal;
    if (goal === 0) {
      if (!a.paused) a.pause();
      return;
    }
  }
  if (goal > 0 && a.paused) {
    a.play().then(
      () => set({ blocked: false }),
      () => set({ blocked: true }), // 画面を触るまで待つ
    );
  }
  if (!fade || a.paused) return;
  const from = a.volume;
  const start = performance.now();
  const step = (now: number) => {
    const k = Math.min(1, (now - start) / DUCK_FADE_MS);
    a.volume = clamp(from + (goal - from) * k);
    if (k < 1) fadeRaf = requestAnimationFrame(step);
  };
  fadeRaf = requestAnimationFrame(step);
}

let hooked = false;
function hookPage() {
  if (hooked || typeof document === "undefined") return;
  hooked = true;
  document.addEventListener("visibilitychange", () => apply());
  // 勝手な再生を止められていたら、画面を触ったときに流し始める
  const retry = () => {
    if (state.blocked && wanted) apply();
  };
  window.addEventListener("pointerdown", retry, true);
  window.addEventListener("keydown", retry, true);
}

/** 画面を開いたときに曲を先に読み込んでおく（K.A.R.E.N. に切り替えた瞬間に鳴らすため） */
export function preloadBgm(): void {
  hookPage();
  void load().then(() => {
    if (state.hasTrack) el().load();
  });
}

/** K.A.R.E.N. に切り替えた・戻した */
export function setBgmActive(active: boolean): void {
  if (wanted === active) return;
  wanted = active;
  hookPage();
  // K.A.R.E.N. を開き直すたびに、曲の初めから流す
  if (active && audio) audio.currentTime = 0;
  if (loaded && state.hasTrack) apply();
  else void load().then(() => apply());
}

/** 声を聞いている・話している間は小さくする */
export function setBgmDucked(v: boolean): void {
  if (ducked === v) return;
  ducked = v;
  apply(true);
}

async function savePrefs() {
  await setLocal(PREF_KEY, { on: state.on, volume: state.volume } satisfies BgmPrefs);
}

export function setBgmOn(on: boolean): void {
  set({ on });
  void savePrefs();
  apply();
}

export function setBgmVolume(volume: number): void {
  set({ volume: clamp(volume) });
  void savePrefs();
  // 音量の操作はすぐに反映する（フェードしない）
  apply();
}

/** 曲を選ぶ（MP3 など）。この端末にしまって、次から K.A.R.E.N. を開くたびに流す。うまくいかなければ理由 */
export async function chooseBgm(file: File): Promise<string | null> {
  if (!/^audio\//.test(file.type) && !/\.(mp3|m4a|aac|ogg|wav)$/i.test(file.name)) return "音楽のファイル（MP3 など）を選んでください。";
  if (file.size > MAX_BYTES) return `ファイルが大きすぎます（${Math.round(file.size / 1024 / 1024)}MB）。40MB 以下にしてください。`;
  const data = await file.arrayBuffer();
  await load();
  const saved = await setLocal(FILE_KEY, { name: file.name, type: file.type || "audio/mpeg", data });
  setTrack(new Blob([data], { type: file.type || "audio/mpeg" }), file.name);
  set({ on: true });
  void savePrefs();
  apply();
  return saved ? null : "この端末に保存できなかったので、今回だけ流します（プライベートウィンドウなど）。";
}
