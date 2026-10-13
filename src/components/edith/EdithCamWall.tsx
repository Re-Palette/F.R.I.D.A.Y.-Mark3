"use client";

/**
 * E.D.I.T.H. の LIVE（ピックアップした場所のカメラ映像）。GOD'S EYE VIEW いっぱいに、
 *   上：大きな映像（選んだもの。最初から再生する。16:9 の枠に切らずに収める）・場所・座標・番号・全画面
 *   中：一覧（1 段。横に送る）。先頭はライブ配信（YouTube。いま配信中の動画）、続いて公開カメラ（Windy。数分ごとの画像・タイムラプス）
 *   下：最新の更新（取得した時刻・件数）と、元のページ（YouTube・Windy）を開くボタン
 * 「LIVE」の印は、いま配信中だと確かめたライブ配信にだけ付ける。画質（4K など）は分からないので出さない。
 */
import { useEffect, useRef, useState } from "react";
import { agoText, utcText } from "@/lib/earth/status";

/** 一覧の 1 件（ライブ配信・公開カメラをそろえた形） */
export interface WallItem {
  key: string;
  kind: "stream" | "cam";
  title: string;
  /** チャンネル名・街の名前など */
  sub: string | null;
  lat: number | null;
  lon: number | null;
  thumbnail: string | null;
  /** 静止画（公開カメラだけ） */
  still: string | null;
  /** 再生画面（埋め込み） */
  player: string | null;
  /** 元のページ */
  detail: string | null;
  /** 画像の更新・配信の開始の時刻（ISO） */
  at: string | null;
  /** いま見ている人の数（ライブ配信だけ） */
  viewers: number | null;
  /** 道路・交通のカメラ */
  traffic: boolean;
}

const label = (it: WallItem, i: number) => (it.kind === "stream" ? "LIVE" : `CAM ${String(i + 1).padStart(2, "0")}`);
const latText = (lat: number) => `${Math.abs(lat).toFixed(4)}° ${lat >= 0 ? "N" : "S"}`;
const lonText = (lon: number) => `${Math.abs(lon).toFixed(4)}° ${lon >= 0 ? "E" : "W"}`;

interface Props {
  /** ピックアップした場所の名前 */
  place: string;
  items: WallItem[];
  /** 件数（ライブ配信・公開カメラ） */
  counts: { streams: number; cams: number };
  fetchedAt?: string;
  now: number;
  /** 一覧が無いときに出す説明（探し中・未設定・見つからない・エラー） */
  emptyText: string;
  /** 補足（片方だけ未設定など） */
  note?: string | null;
  traffic: boolean;
  /** 地球儀でこの場所を見る */
  onShowOnEarth: (it: WallItem) => void;
}

export function EdithCamWall({ place, items, counts, fetchedAt, now, emptyText, note, traffic, onShowOnEarth }: Props) {
  const [selKey, setSelKey] = useState<string | null>(null);
  // 静止画にする（公開カメラだけ。既定は再生画面）
  const [still, setStill] = useState(false);
  const stage = useRef<HTMLDivElement>(null);
  // 上の大きな映像：自分で選んだもの。選んでいなければ、ライブ配信（YouTube）があればそれ、無ければ先頭のカメラ
  //（ライブ配信が後から届いても、選んでいなければ配信に切り替わる）
  const chosen = selKey ? items.find((c) => c.key === selKey) : undefined;
  const sel = chosen ?? items.find((c) => c.kind === "stream") ?? items[0] ?? null;
  const camIndex = (it: WallItem) => items.filter((x) => x.kind === "cam").indexOf(it);

  // 場所が変わったら、先頭から
  useEffect(() => {
    setSelKey(null);
    setStill(false);
  }, [place]);

  const pick = (c: WallItem) => {
    setSelKey(c.key);
    setStill(false);
  };
  const play = Boolean(sel?.player) && !(still && sel?.kind === "cam" && sel.still);
  const fullscreen = () => {
    const el = stage.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void el.requestFullscreen?.().catch(() => {});
  };

  return (
    <div className="ecamwall" role="region" aria-label={`${place} のカメラ映像`}>

      {sel ? (
        <>
          <div className="ecamwall__stagebox">
            <div className="ecamwall__stage" ref={stage}>
              <header className="ecamwall__head">
                <span className="ecamwall__dot" aria-hidden="true" />
                <b>LIVE CAM</b>
                <span className="ecamwall__sep">/</span>
                <span className="ecamwall__title">{sel ? sel.title : place}</span>
                <span className="ecamwall__tag">{sel?.kind === "stream" ? "ライブ配信（YouTube）" : traffic ? "道路カメラ" : "公開カメラ（Windy）"}</span>
              </header>

              {play && sel.player ? (
                <iframe
                  key={sel.key}
                  src={sel.player}
                  title={`${sel.title}（${sel.kind === "stream" ? "YouTube のライブ配信" : "Windy の再生画面"}）`}
                  allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
                  referrerPolicy="strict-origin-when-cross-origin"
                  allowFullScreen
                />
              ) : sel.still ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img key={sel.key} src={sel.still} alt={`${sel.title} の最新の画像`} referrerPolicy="no-referrer" />
              ) : (
                <p className="ecamwall__noimg">この映像を読み込めませんでした</p>
              )}
              {!play && (
                <div className="ecamwall__caption">
                  <b>{sel.title}</b>
                  <span>
                    {sel.lat !== null && sel.lon !== null ? `${latText(sel.lat)}　${lonText(sel.lon)}` : place}
                    {sel.at ? `　·　画像 ${agoText(Date.parse(sel.at), now)}` : ""}
                  </span>
                </div>
              )}
              <div className="ecamwall__tools">
                <span className="ecamwall__no" data-live={sel.kind === "stream" || undefined}>
                  {sel.kind === "stream" ? `● LIVE${sel.viewers !== null ? ` · ${sel.viewers.toLocaleString()} 人` : ""}` : label(sel, camIndex(sel))}
                </span>
                {sel.kind === "cam" && sel.player && sel.still && (
                  <button type="button" onClick={() => setStill((v) => !v)} title={play ? "最新の静止画にする" : "Windy の再生画面にする（タイムラプス。カメラによってはライブ）"} aria-pressed={play}>
                    {play ? "■ 静止画" : "▶ 再生"}
                  </button>
                )}
                <button type="button" onClick={() => onShowOnEarth(sel)} title="地球儀でこの場所を見る">
                  ◎ 地図
                </button>
                <button type="button" onClick={fullscreen} title="全画面" aria-label="全画面">
                  ⤢
                </button>
              </div>
            </div>
          </div>

          <ul className="ecamwall__grid" aria-label="近くのカメラ映像">
            {items.map((c) => (
              <li key={c.key}>
                <button type="button" onClick={() => pick(c)} aria-pressed={c.key === sel.key} data-on={c.key === sel.key || undefined} data-kind={c.kind} title={c.sub ? `${c.title}（${c.sub}）` : c.title}>
                  {c.thumbnail ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={c.thumbnail} alt="" loading="lazy" referrerPolicy="no-referrer" />
                  ) : (
                    <span className="ecamwall__thumbnone">NO IMAGE</span>
                  )}
                  {c.kind === "stream" && <span className="ecamwall__live">● LIVE</span>}
                  <span className="ecamwall__label">
                    <b>{c.title}</b>
                    <i>{c.key === sel.key ? "VIEWING" : c.kind === "stream" ? (c.sub ?? "YouTube") : label(c, camIndex(c))}</i>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <div className="ecamwall__empty">
          <header className="ecamwall__head">
            <span className="ecamwall__dot" aria-hidden="true" />
            <b>LIVE CAM</b>
            <span className="ecamwall__sep">/</span>
            <span className="ecamwall__title">{place}</span>
            <span className="ecamwall__tag">{traffic ? "道路カメラ" : "カメラ映像"}</span>
          </header>
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
                {place}：ライブ配信 {counts.streams} 件・公開カメラ {counts.cams} 台
                {note ? `（${note}）` : ""} ·{" "}
                <a href="https://www.youtube.com/" target="_blank" rel="noopener noreferrer">
                  YouTube
                </a>{" "}
                ·{" "}
                <a href="https://www.windy.com/" target="_blank" rel="noopener noreferrer">
                  Webcams provided by windy.com
                </a>
              </small>
            </>
          ) : (
            <small>{note ? `${emptyText}（${note}）` : emptyText}</small>
          )}
        </span>
        {sel?.detail && (
          <a className="ecamwall__more" href={sel.detail} target="_blank" rel="noopener noreferrer">
            {sel.kind === "stream" ? "YouTube で見る →" : "詳細を見る →"}
          </a>
        )}
      </footer>
    </div>
  );
}
