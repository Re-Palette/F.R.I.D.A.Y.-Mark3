/**
 * 拍手 2 回（パン、パン）の検出。マイクの音を小さな区切り（約 5ms）ごとに見て判定する。
 *
 * 拍手らしい音 = 次のすべてを満たす短い音
 *   - 周りの音（ノイズの底）より十分大きく、一瞬で立ち上がる（直前の 3 区切りの 4 倍以上）
 *   - 高い音まで含むザラッとした音（音全体で見たゼロ交差の速さがおよそ 900Hz 以上。声の母音やノックのような低い音は遅い）
 *   - すぐ消える（大きさが山の 1/4 まで落ちるのが 150ms 以内。部屋の響きは少し残る。話し声は音節が長く続く）
 *   - 消えたあと静かなまま（「パ」のような破裂音は、すぐ後に母音が続くので除く）
 * 拍手らしい音が 0.12〜1 秒の間隔で 2 回続き、そのあと 0.3 秒何も鳴らなければ「2 回の拍手」。
 * 3 回以上続いたとき（拍手喝采・ノックの連打など）は反応しない。
 *
 * 音は録音も送信もしない。大きさとゼロ交差率だけを見る。
 */

const WINDOW_S = 0.005;
/** ノイズの底より何倍大きければ拍手の候補にするか */
const FLOOR_RATIO = 8;
/** これより小さい音は無視（遠くの物音）。マイクの音を加工しない（自動で音量を上げない）ので小さめに */
const MIN_RMS = 0.015;
/** 直前の区切りより何倍の速さで立ち上がれば「一瞬で立ち上がった」とみなすか */
const ATTACK_RATIO = 4;
/** 山の大きさの何割まで落ちたら音が終わったとみなすか */
const DECAY_RATIO = 0.25;
/** 音が消えたあと、静かなままか確かめる時間 */
const TAIL_S = 0.08;
/** 確かめている間に、山の何割まで戻ったら拍手ではないとみなすか */
const TAIL_RATIO = 0.4;
/** 拍手の音の長さの上限（響く部屋では少し長く残る） */
const MAX_CLAP_S = 0.15;
/**
 * 拍手とみなすザラつき（ゼロ交差の速さ。1 秒あたりの交差の半分＝おおよその主な音の高さ Hz）の下限。
 * 拍手の音は 1〜3kHz あたりが強い（手を丸めて打つと 1kHz 前後まで下がる）。声の母音・ノック・机を叩く音はもっと低い。
 * 音の始まりだけでなく音全体で（大きいところほど重く）測るので、「パ」の破裂のあとに母音が続く声は低くなる。
 * サンプリングの速さ（48kHz / 44.1kHz / 16kHz）が違っても同じ基準になるよう Hz で決める
 */
const MIN_ZC_HZ = 900;
/** 2 回の拍手の間隔 */
const MIN_GAP_S = 0.12;
const MAX_GAP_S = 1.0;
/** 2 回目のあと、3 回目が来ないことを確かめる時間 */
const QUIET_AFTER_S = 0.3;
/** 一度反応したら、しばらく反応しない */
const COOLDOWN_S = 2.5;

export class DoubleClapDetector {
  private readonly win: number;
  private buf: Float32Array;
  private fill = 0;
  /** 処理した区切りの数（時刻の代わり） */
  private t = 0;
  private floor = 0.004;
  private recent: number[] = [];
  /** 鳴っている最中の候補 */
  private event: { start: number; peak: number; zc: number; n: number } | null = null;
  /** 音が消えて、静かなままか確かめている拍手の候補 */
  private tail: { start: number; peak: number; until: number } | null = null;
  /** 拍手と判定した音の始まり（区切りの番号） */
  private claps: number[] = [];
  /** 3 回以上続いた（拍手喝采など）。静かになるまで数えない。値は最後の拍手の区切り番号 */
  private burstUntilQuiet: number | null = null;
  private coolUntil = 0;

  private readonly sampleRate: number;
  private readonly onDoubleClap: () => void;
  /** 1 回目の拍手らしい音が鳴ったとき（タブを前に出す準備を先に始めるため） */
  private readonly onFirstClap?: () => void;

  constructor(sampleRate: number, onDoubleClap: () => void, onFirstClap?: () => void) {
    this.sampleRate = sampleRate;
    this.onDoubleClap = onDoubleClap;
    this.onFirstClap = onFirstClap;
    this.win = Math.max(64, Math.round(sampleRate * WINDOW_S));
    this.buf = new Float32Array(this.win);
  }

  private secs(windows: number): number {
    return (windows * this.win) / this.sampleRate;
  }

  /** マイクの音を渡す（長さは自由） */
  push(samples: Float32Array): void {
    let i = 0;
    while (i < samples.length) {
      const n = Math.min(this.win - this.fill, samples.length - i);
      this.buf.set(samples.subarray(i, i + n), this.fill);
      this.fill += n;
      i += n;
      if (this.fill === this.win) {
        this.step(this.buf);
        this.fill = 0;
      }
    }
  }

  /** 拍手の判定をやり直す（マイクを開き直したときなど） */
  reset(): void {
    this.event = null;
    this.tail = null;
    this.claps = [];
    this.burstUntilQuiet = null;
    this.recent = [];
    this.fill = 0;
  }

  private step(w: Float32Array): void {
    this.t++;
    let sum = 0;
    let zc = 0;
    for (let k = 0; k < w.length; k++) {
      sum += w[k] * w[k];
      if (k && (w[k] >= 0) !== (w[k - 1] >= 0)) zc++;
    }
    const rms = Math.sqrt(sum / w.length);
    const before = this.recent.length ? Math.max(...this.recent) : this.floor;

    if (this.event) {
      const e = this.event;
      if (rms > e.peak) e.peak = rms;
      // 音全体のザラつきを、大きいところほど重く測る
      e.zc += zc * sum;
      e.n += w.length * sum;
      if (rms < e.peak * DECAY_RATIO) {
        this.event = null;
        const length = this.secs(this.t - e.start);
        if (length <= MAX_CLAP_S && ((e.zc / e.n) * this.sampleRate) / 2 >= MIN_ZC_HZ) {
          this.tail = { start: e.start, peak: e.peak, until: this.t + Math.max(1, Math.round(TAIL_S / this.secs(1))) };
        } else this.claps = []; // 拍手ではない音が割り込んだら数え直す
      } else if (this.secs(this.t - e.start) > MAX_CLAP_S * 2) {
        this.event = null; // 長く続く音（話し声・音楽）
        this.claps = [];
      }
    } else if (this.tail) {
      if (rms > this.tail.peak * TAIL_RATIO) {
        this.tail = null; // すぐ後に音が続いた（話し声の破裂音など）
        this.claps = [];
      } else if (this.t >= this.tail.until) {
        const start = this.tail.start;
        this.tail = null;
        this.clap(start);
      }
    } else if (rms > MIN_RMS && rms > this.floor * FLOOR_RATIO && rms > before * ATTACK_RATIO) {
      this.event = { start: this.t, peak: rms, zc: zc * sum, n: w.length * sum };
    } else {
      // 静かなときだけノイズの底を更新する（下がるのは速く、上がるのはゆっくり）
      const k = rms < this.floor ? 0.05 : 0.005;
      this.floor = Math.max(0.0005, this.floor + (rms - this.floor) * k);
    }

    this.recent.push(rms);
    if (this.recent.length > 3) this.recent.shift();

    if (this.burstUntilQuiet !== null && !this.event && this.secs(this.t - this.burstUntilQuiet) >= QUIET_AFTER_S) {
      this.burstUntilQuiet = null;
    }
    // 2 回目のあと静かなままなら確定
    if (this.claps.length === 2 && !this.event && !this.tail && this.secs(this.t - this.claps[1]) >= QUIET_AFTER_S) {
      this.claps = [];
      if (this.t >= this.coolUntil) {
        this.coolUntil = this.t + Math.round(COOLDOWN_S / this.secs(1));
        this.onDoubleClap();
      }
    }
    // 1 回だけで間が空いたら忘れる（2 回目らしい音を確かめている最中は待つ）
    if (this.claps.length === 1 && !this.event && !this.tail && this.secs(this.t - this.claps[0]) > MAX_GAP_S) this.claps = [];
  }

  private clap(start: number): void {
    if (this.burstUntilQuiet !== null) {
      this.burstUntilQuiet = start;
      return;
    }
    const last = this.claps[this.claps.length - 1];
    if (last !== undefined) {
      const gap = this.secs(start - last);
      if (gap < MIN_GAP_S) return; // 同じ拍手の残響
      if (gap > MAX_GAP_S) this.claps = [];
    }
    this.claps.push(start);
    if (this.claps.length === 1) this.onFirstClap?.();
    if (this.claps.length > 2) {
      // 3 回以上は反応しない（静かになるまで数えない）
      this.claps = [];
      this.burstUntilQuiet = start;
    }
  }
}
