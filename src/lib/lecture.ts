/**
 * 授業の文字起こし（画面側）。
 *   - 文字起こしはブラウザの音声認識（Chrome）で、その場で行う。音声そのものは保存も送信もしない
 *     （Chrome の音声認識は、文字にするために Google のサーバーを使う）
 *   - 文字にしたものは、このブラウザの中（localStorage）にだけ保存する
 *   - まとめ（全体像・重要なところ）は、文字起こしを F.R.I.D.A.Y. のサーバー経由で Gemini に渡して作る
 */
import { getRecognitionCtor, type RecognitionLike } from "./speech";

/** 文字起こしの 1 区切り（t は授業の始まりからの秒数） */
export interface LectureSegment {
  t: number;
  text: string;
}

/** まとめ（サーバーが Gemini に作らせる） */
export interface LectureSummary {
  title: string;
  /** 全体像（この授業で何を学んだか） */
  overview: string;
  /** 授業の流れ（時間・見出し・要点） */
  outline: { time?: string; heading: string; points: string[] }[];
  /** 重要なところ */
  keyPoints: { point: string; detail?: string; time?: string }[];
  /** 用語 */
  terms: { term: string; meaning: string }[];
  /** テストに出そうなところ・先生が強調したところ */
  exam: string[];
  /** 課題・連絡事項（締め切りなど） */
  notices: string[];
  /** 復習で確かめること */
  review: string[];
}

export interface Lecture {
  id: string;
  subject: string;
  /** 始めた時刻（ISO） */
  startedAt: string;
  /** 録っていた時間（秒） */
  duration: number;
  segments: LectureSegment[];
  summary?: LectureSummary;
}

const KEY = "friday.lectures.v1";
/** 保存しておく授業の数（古いものから消す） */
const KEEP = 40;

export function loadLectures(): Lecture[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || "[]") as Lecture[];
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** 保存する（容量が足りなければ古いものから消して入れ直す）。保存できなければ false */
export function saveLecture(lecture: Lecture): boolean {
  let list = [lecture, ...loadLectures().filter((l) => l.id !== lecture.id)].slice(0, KEEP);
  while (list.length) {
    try {
      localStorage.setItem(KEY, JSON.stringify(list));
      return true;
    } catch {
      if (list.length === 1) return false;
      list = list.slice(0, -1);
    }
  }
  return false;
}

export function deleteLecture(id: string): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(loadLectures().filter((l) => l.id !== id)));
  } catch {
    /* noop */
  }
}

/** 秒 → "12:34"（1 時間以上は "1:02:03"） */
export function clock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
}

/** 文字起こしを読みやすい文章に（1 分ごとに時刻を付ける） */
export function transcriptText(segments: LectureSegment[]): string {
  let lastMinute = -1;
  const out: string[] = [];
  for (const s of segments) {
    const minute = Math.floor(s.t / 60);
    if (minute !== lastMinute) {
      out.push(`\n[${clock(s.t)}] ${s.text}`);
      lastMinute = minute;
    } else out.push(s.text);
  }
  return out.join(" ").trim();
}

export function supportsLectureRecording(): boolean {
  return Boolean(getRecognitionCtor());
}

/**
 * 授業を聞き続けて文字にする。
 * Chrome の音声認識は数十秒〜数分で勝手に止まるので、録音中は止まるたびにすぐ再開する。
 * 画面が消えると止まるので、録音中は画面を消さないようにする（対応しているブラウザだけ）。
 */
export class LectureRecorder {
  private rec: RecognitionLike | null = null;
  private running = false;
  private startedAt = 0;
  /** 一時停止していた時間を除いた、録音していた時間（ミリ秒） */
  private elapsedBefore = 0;
  private wakeLock: { release(): Promise<void> } | null = null;
  private restartTimer = 0;
  private failures = 0;

  constructor(
    private readonly on: {
      /** 確定した文（t は授業の始まりからの秒数） */
      final: (segment: LectureSegment) => void;
      /** 聞き取り途中の文 */
      interim: (text: string) => void;
      /** 続けられないエラー（マイクの許可がない など） */
      error: (message: string) => void;
    },
  ) {}

  /** 授業の始まりからの秒数（一時停止中は進まない） */
  elapsed(): number {
    return (this.elapsedBefore + (this.running ? performance.now() - this.startedAt : 0)) / 1000;
  }

  get recording(): boolean {
    return this.running;
  }

  /** 始める（一時停止からの再開も同じ）。前の授業の続きなら、その時間から数える */
  start(fromSeconds = this.elapsedBefore / 1000): boolean {
    const Ctor = getRecognitionCtor();
    if (!Ctor) {
      this.on.error("このブラウザは文字起こしに対応していません。パソコンの Chrome で開いてください。");
      return false;
    }
    if (this.running) return true;
    this.elapsedBefore = fromSeconds * 1000;
    this.startedAt = performance.now();
    this.running = true;
    this.failures = 0;
    this.listen(Ctor);
    void this.keepAwake();
    document.addEventListener("visibilitychange", this.onVisible);
    return true;
  }

  /** 一時停止（文字起こしは残る） */
  pause(): void {
    if (!this.running) return;
    this.elapsedBefore += performance.now() - this.startedAt;
    this.running = false;
    clearTimeout(this.restartTimer);
    const rec = this.rec;
    this.rec = null;
    if (rec) {
      rec.onend = null;
      try {
        rec.stop(); // 聞き取り途中の分も確定させてから止める
      } catch {
        /* noop */
      }
      // 止めた後に届く最後の確定分は受け取る
      setTimeout(() => (rec.onresult = null), 1500);
    }
    this.on.interim("");
    void this.wakeLock?.release().catch(() => {});
    this.wakeLock = null;
    document.removeEventListener("visibilitychange", this.onVisible);
  }

  private listen(Ctor: new () => RecognitionLike) {
    const rec = new Ctor();
    rec.lang = "ja-JP";
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        const text = r[0].transcript.trim();
        if (!text) continue;
        if (r.isFinal) {
          this.failures = 0;
          this.on.final({ t: Math.max(0, this.elapsed() - 2), text });
        } else interim += text;
      }
      this.on.interim(interim);
    };
    rec.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        this.on.error("マイクの使用が許可されていません。アドレスバーのマイクのアイコンから許可してください。");
        this.pause();
      } else if (e.error === "audio-capture") {
        this.on.error("マイクが見つかりません。");
        this.pause();
      } else if (e.error === "network") this.failures++;
      // no-speech（しばらく無音）・aborted などは、onend で再開する
    };
    rec.onend = () => {
      if (!this.running || this.rec !== rec) return;
      this.on.interim("");
      // 続けて失敗するとき（通信が切れた など）は、少しずつ間をあけて再開する
      const wait = this.failures ? Math.min(5000, 400 * 2 ** this.failures) : 0;
      if (this.failures >= 6) this.on.error("音声認識につながりません。ネットワークを確認してください（つながると自動で再開します）。");
      this.restartTimer = window.setTimeout(() => {
        if (!this.running || this.rec !== rec) return;
        this.listen(Ctor);
      }, wait);
    };
    this.rec = rec;
    try {
      rec.start();
    } catch {
      this.failures++;
    }
  }

  private async keepAwake() {
    try {
      const nav = navigator as unknown as { wakeLock?: { request(type: "screen"): Promise<{ release(): Promise<void> }> } };
      this.wakeLock = (await nav.wakeLock?.request("screen")) ?? null;
    } catch {
      /* 対応していない・許可されない */
    }
  }

  /** 別のタブから戻ったとき、画面を消さない設定をかけ直す（タブを離れると外れるため） */
  private onVisible = () => {
    if (document.visibilityState === "visible" && this.running && !this.wakeLock) void this.keepAwake();
    if (document.visibilityState === "hidden") this.wakeLock = null;
  };
}
