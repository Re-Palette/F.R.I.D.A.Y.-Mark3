"use client";

/**
 * E.D.I.T.H. の LIVE（ピックアップした場所のライブカメラ）。GOD'S EYE VIEW いっぱいに、
 *   上：大きな映像（選んだカメラ。最初から Windy の再生画面で出す。16:9 の枠に切らずに収める）・場所・座標・カメラの番号・全画面
 *   中：近くのカメラの一覧（1 段。横に送る。押すと上の大きな映像に出す）
 *   下：最新の更新（取得した時刻・台数）と、Windy のカメラのページを開くボタン
 * 映っているのは運営者が公開しているカメラだけ。画質・ライブかどうかは分からないので「4K」「LIVE」のような印は付けない
 * （更新の時刻を出す。再生はタイムラプス、カメラによってはライブ）。
 */
import { useEffect, useRef, useState } from "react";
import { agoText, utcText } from "@/lib/earth/status";
import type { Webcam } from "@/lib/earth/webcams";

const GRID_MAX = 8;
const camNo = (i: number) => `CAM ${String(i + 1).padStart(2, "0")}`;
const latText = (lat: number) => `${Math.abs(lat).toFixed(4)}° ${lat >= 0 ? "N" : "S"}`;
const lonText = (lon: number) => `${Math.abs(lon).toFixed(4)}° ${lon >= 0 ? "E" : "W"}`;

interface Props {
  /** ピックアップした場所の名前 */
  place: string;
  items: Webcam[];
  fetchedAt?: string;
  now: number;
  /** 一覧が無いときに出す説明（探し中・未設定・見つからない・エラー） */
  emptyText: string;
  traffic: boolean;
  /** 地球儀でこのカメラの場所を見る */
  onShowOnEarth: (cam: Webcam) => void;
}

export function EdithCamWall({ place, items, fetchedAt, now, emptyText, traffic, onShowOnEarth }: Props) {
  const [selId, setSelId] = useState<string | null>(null);
  // 静止画にする（既定は再生画面。再生画面の無いカメラは静止画）
  const [still, setStill] = useState(false);
  const stage = useRef<HTMLDivElement>(null);
  const list = items.slice(0, GRID_MAX);
  const selIndex = Math.max(0, list.findIndex((c) => c.id === selId));
  const sel = list[selIndex] ?? null;

  // 場所が変わったら、最初のカメラから
  useEffect(() => {
    setSelId(null);
    setStill(false);
  }, [place]);

  const pick = (c: Webcam) => {
    setSelId(c.id);
    setStill(false);
  };
  const play = Boolean(sel?.player) && !still;
  const fullscreen = () => {
    const el = stage.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void el.requestFullscreen?.().catch(() => {});
  };

  return (
    <div className="ecamwall" role="region" aria-label={`${place} のライブカメラ`}>
      <header className="ecamwall__head">
        <span className="ecamwall__dot" aria-hidden="true" />
        <b>LIVE CAM</b>
        <span className="ecamwall__sep">/</span>
        <span className="ecamwall__title">{sel ? sel.title : place}</span>
        <span className="ecamwall__tag">{traffic ? "道路カメラ" : "公開カメラ"}</span>
      </header>

      {sel ? (
        <>
          <div className="ecamwall__stagebox">
          <div className="ecamwall__stage" ref={stage}>
            {play && sel.player ? (
              <iframe key={sel.id} src={sel.player} title={`${sel.title}（Windy の再生画面）`} allow="autoplay; fullscreen" referrerPolicy="strict-origin-when-cross-origin" allowFullScreen />
            ) : sel.preview ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img key={sel.id} src={sel.preview} alt={`${sel.title} の最新の画像`} referrerPolicy="no-referrer" />
            ) : (
              <p className="ecamwall__noimg">このカメラの画像を読み込めませんでした</p>
            )}
            {!play && (
              <div className="ecamwall__caption">
                <b>{sel.title}</b>
                <span>
                  {latText(sel.lat)}　{lonText(sel.lon)}
                  {sel.updatedAt ? `　·　画像 ${agoText(Date.parse(sel.updatedAt), now)}` : ""}
                </span>
              </div>
            )}
            <div className="ecamwall__tools">
              <span className="ecamwall__no">{camNo(selIndex)}</span>
              {sel.player && (
                <button type="button" onClick={() => setStill((v) => !v)} title={play ? "最新の静止画にする" : "Windy の再生画面にする（タイムラプス。カメラによってはライブ）"} aria-pressed={play}>
                  {play ? "■ 静止画" : "▶ 再生"}
                </button>
              )}
              <button type="button" onClick={() => onShowOnEarth(sel)} title="地球儀でこのカメラの場所を見る">
                ◎ 地図
              </button>
              <button type="button" onClick={fullscreen} title="全画面" aria-label="全画面">
                ⤢
              </button>
            </div>
          </div>
          </div>

          <ul className="ecamwall__grid" aria-label="近くのカメラ">
            {list.map((c, i) => (
              <li key={c.id}>
                <button type="button" onClick={() => pick(c)} aria-pressed={c.id === sel.id} data-on={c.id === sel.id || undefined} title={c.title}>
                  {c.thumbnail ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={c.thumbnail} alt="" loading="lazy" referrerPolicy="no-referrer" />
                  ) : (
                    <span className="ecamwall__thumbnone">NO IMAGE</span>
                  )}
                  <span className="ecamwall__label">
                    <b>{c.title}</b>
                    <i>{c.id === sel.id ? "VIEWING" : camNo(i)}</i>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <div className="ecamwall__empty">
          <p>{emptyText}</p>
        </div>
      )}

      <footer className="ecamwall__foot">
        <span className="ecamwall__chip">最新の更新</span>
        <span className="ecamwall__status">
          {fetchedAt ? (
            <>
              <b>
                {utcText(fetchedAt)}（{agoText(Date.parse(fetchedAt), now)}）
              </b>
              <small>
                {place}の近くの公開カメラ {items.length} 台を取得しました ·{" "}
                <a href="https://www.windy.com/" target="_blank" rel="noopener noreferrer">
                  Webcams provided by windy.com
                </a>
              </small>
            </>
          ) : (
            <small>{emptyText}</small>
          )}
        </span>
        {sel?.detail && (
          <a className="ecamwall__more" href={sel.detail} target="_blank" rel="noopener noreferrer">
            詳細を見る →
          </a>
        )}
      </footer>
    </div>
  );
}
