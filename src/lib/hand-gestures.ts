/**
 * カメラに映った手の形（MediaPipe の 21 点）から、ホログラムの操作を読み取る。
 *
 *   つまんで動かす（親指と人差し指をくっつけたまま動かす）→ 回す
 *   両手でつまんで広げる／縮める                           → 大きく／小さく
 *   グーを 0.7 秒                                           → 元の向きに戻す
 *
 * カメラの映像は鏡のように左右が逆なので、x は 1 - x にそろえて扱う（手を右に動かすと右に回る）。
 */
import type { HandCursor } from "./hologram-control";

export interface Point {
  x: number;
  y: number;
  z?: number;
}

export type GestureEvent = { type: "rotate"; dx: number; dy: number } | { type: "zoom"; factor: number } | { type: "reset" };

const PINCH_ON = 0.35;
const PINCH_OFF = 0.5;
const FIST_MS = 700;
/** 速く動かして一瞬見失っても、この時間までは「つまんだまま」とみなして操作を続ける */
const LOST_GRACE_MS = 220;
const ROTATE_GAIN = 1.1;

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

interface HandState {
  pinching: boolean;
  /** 見失った時刻（見えている間は無し） */
  lostAt?: number;
  /** 最後に見えた手首の位置（片手を見失ったとき、残った手がどちらかを見分ける） */
  wrist?: Point;
  /** 最後に見えたつまみの位置（一瞬見失った間はここにあるとみなす） */
  seen?: { x: number; y: number };
  last?: { x: number; y: number };
  fistSince?: number;
  fistDone?: boolean;
}

export class GestureTracker {
  private hands: HandState[] = [{ pinching: false }, { pinching: false }];
  private lastSpread?: number;
  cursors: HandCursor[] = [];

  /** 1 フレーム分の手の形を受け取り、起きた操作を返す */
  update(landmarks: Point[][], now: number): GestureEvent[] {
    const events: GestureEvent[] = [];
    // 左右の並びが入れ替わらないよう、画面の左から順に並べる
    const list = landmarks
      .filter((h) => h.length >= 21)
      .slice(0, 2)
      .sort((a, b) => b[0].x - a[0].x);
    this.cursors = [];
    const pinchPoints: { x: number; y: number }[] = [];

    // 2 本見えていれば左から順。1 本だけなら、前に見えていた手首が近い方の手として扱う
    const slots: (Point[] | undefined)[] = [list[0], list[1]];
    if (list.length === 1) {
      let best = 0;
      let bestDist = Infinity;
      this.hands.forEach((h, i) => {
        if (!h.wrist) return;
        const d = dist(h.wrist, list[0][0]);
        if (d < bestDist) {
          bestDist = d;
          best = i;
        }
      });
      slots[0] = slots[1] = undefined;
      slots[best] = list[0];
    }

    for (let i = 0; i < 2; i++) {
      const lm = slots[i];
      const st = this.hands[i];
      if (!lm) {
        // 一瞬見失っただけなら状態を残す（速く動かしたときに操作が途切れないように）
        st.lostAt ??= now;
        if (now - st.lostAt > LOST_GRACE_MS) this.hands[i] = { pinching: false };
        else if (st.pinching && st.seen) pinchPoints.push(st.seen);
        continue;
      }
      st.lostAt = undefined;
      st.wrist = lm[0];
      const size = dist(lm[0], lm[9]) || 1e-6;
      const gap = dist(lm[4], lm[8]) / size;
      st.pinching = st.pinching ? gap < PINCH_OFF : gap < PINCH_ON;
      const point = { x: 1 - (lm[4].x + lm[8].x) / 2, y: (lm[4].y + lm[8].y) / 2 };
      st.seen = point;
      this.cursors.push({ ...point, pinching: st.pinching });

      // グー：4 本の指先がすべて手のひらの近くにある
      const fist = [8, 12, 16, 20].every((tip) => dist(lm[tip], lm[0]) < size * 1.05);
      if (fist && !st.pinching) {
        st.fistSince ??= now;
        if (!st.fistDone && now - st.fistSince >= FIST_MS) {
          st.fistDone = true;
          events.push({ type: "reset" });
        }
      } else {
        st.fistSince = undefined;
        st.fistDone = false;
      }

      if (st.pinching) pinchPoints.push(point);
      else st.last = undefined;
    }

    if (pinchPoints.length === 2) {
      // 両手でつまんでいる → 手の間の距離で大きさを変える
      const spread = dist(pinchPoints[0], pinchPoints[1]);
      if (this.lastSpread && spread > 0.02) events.push({ type: "zoom", factor: spread / this.lastSpread });
      this.lastSpread = spread;
      this.hands.forEach((h) => (h.last = undefined));
    } else {
      this.lastSpread = undefined;
      const i = this.hands.findIndex((h) => h.pinching);
      if (i >= 0) {
        const p = pinchPoints[0];
        const st = this.hands[i];
        if (st.last) {
          const dx = p.x - st.last.x;
          const dy = p.y - st.last.y;
          if (Math.abs(dx) + Math.abs(dy) > 0.002) events.push({ type: "rotate", dx: dx * ROTATE_GAIN, dy: dy * ROTATE_GAIN });
        }
        st.last = p;
      }
    }
    return events;
  }
}
