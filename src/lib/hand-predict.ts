/**
 * 手の位置の先読み。
 * 手の認識は 1 回に数十ミリ秒かかり、結果が届いたときには手はもう先へ動いている（しかも 1 秒に十数回しか届かない）。
 * そこで、届いた結果から各点の速さを求め、「いま」の位置を先読みして返す。
 *   - 描画のたびに呼べば、認識の合間もなめらかに動く（1 秒に 60 回）
 *   - 認識の遅れの分だけ先に進めるので、実際の手に追いつく
 *   - ほとんど動いていないときは先読みしない（細かい揺れを大きくしない）
 *   - 先読みは長くても MAX_AHEAD_MS まで（手を止めたときに行き過ぎない）
 *   - 結果が届くたびの「先読みのずれの直し」で点が跳ねないよう、表示する位置は少し遅れて追いかける（SMOOTH_MS）
 */
import type { Point } from "./hand-gestures";

/** これより先は読まない（ミリ秒） */
const MAX_AHEAD_MS = 140;
/** 速さのなめらかさ（新しい値の重み） */
const VELOCITY_WEIGHT = 0.65;
/** これより遅い動き（画面の幅/秒）は先読みしない。これの 3 倍で完全に先読みする */
const STILL_SPEED = 0.12;
/** 表示する位置が先読みの位置を追いかける速さ（時定数・ミリ秒）。大きいほどなめらかで、少し遅れる */
const SMOOTH_MS = 45;

interface Track {
  at: number;
  points: Point[];
  /** 各点の速さ（画面の幅/ミリ秒） */
  v: { x: number; y: number }[];
}

export class HandPredictor {
  private tracks: Track[] = [];
  /** 表示している位置（手ごと） */
  private shown: Point[][] = [];
  private shownAt = 0;

  /** 認識の結果（撮った時刻つき）を受け取る。古い結果（後から届いた前のコマ）は無視する */
  push(hands: Point[][], capturedAt: number): void {
    if (this.tracks[0] && capturedAt <= this.tracks[0].at) return;
    // 左から順（hand-gestures と同じ並び）にそろえて、同じ手どうしで速さを求める
    const sorted = hands.filter((h) => h.length >= 21).sort((a, b) => b[0].x - a[0].x);
    const prev = this.tracks;
    this.tracks = sorted.map((points, i) => {
      const old = prev.length === sorted.length && prev[i].points.length === points.length ? prev[i] : undefined;
      const dt = old ? capturedAt - old.at : 0;
      // 前の結果が古すぎる・手の数が変わった → 速さは 0 から
      if (!old || dt <= 0 || dt > 250) return { at: capturedAt, points, v: points.map(() => ({ x: 0, y: 0 })) };
      const v = points.map((p, j) => {
        const q = old.points[j];
        const ov = old.v[j];
        return {
          x: ov.x + ((p.x - q.x) / dt - ov.x) * VELOCITY_WEIGHT,
          y: ov.y + ((p.y - q.y) / dt - ov.y) * VELOCITY_WEIGHT,
        };
      });
      return { at: capturedAt, points, v };
    });
    if (!this.tracks.length) this.tracks = [{ at: capturedAt, points: [], v: [] }];
  }

  /** 時刻 now の手の位置（先読みして、なめらかにつないだもの） */
  at(now: number): Point[][] {
    const target = this.tracks
      .filter((t) => t.points.length)
      .map((t) => {
        const ahead = Math.min(MAX_AHEAD_MS, Math.max(0, now - t.at));
        // 手全体の速さ（手首と中指の付け根の平均）で、先読みの強さを決める
        const sp = (Math.hypot(t.v[0].x, t.v[0].y) + Math.hypot(t.v[9].x, t.v[9].y)) * 500; // 画面の幅/秒
        const k = Math.min(1, Math.max(0, (sp - STILL_SPEED) / (STILL_SPEED * 2)));
        return t.points.map((p, j) => ({ x: p.x + t.v[j].x * ahead * k, y: p.y + t.v[j].y * ahead * k }));
      });
    const dt = now - this.shownAt;
    this.shownAt = now;
    // 手の数が変わった・久しぶり → そのまま出す
    if (target.length !== this.shown.length || dt <= 0 || dt > 200) {
      this.shown = target;
      return target;
    }
    const f = 1 - Math.exp(-dt / SMOOTH_MS);
    this.shown = target.map((h, i) => h.map((p, j) => {
      const s = this.shown[i][j];
      return { x: s.x + (p.x - s.x) * f, y: s.y + (p.y - s.y) * f };
    }));
    return this.shown;
  }

  clear(): void {
    this.tracks = [];
    this.shown = [];
  }
}
