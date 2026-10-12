"use client";

/**
 * GOD'S EYE VIEW（EARTH）の操作と情報。
 *   EarthLayersPanel … 右のパネルの EARTH ページ：レイヤーの ON/OFF と状態・件数・取得時刻、衛星のグループと数、場所の検索、視点、凡例、出典
 *   EarthDetail      … 選んだ地震・衛星の詳細（発生時刻と取得時刻、軌道要素の時刻と計算の時刻を分けて出す）と、追従・移動。
 *                      国際宇宙ステーションを選んだときは、NASA 公式のライブ映像を押したときだけ開ける
 *   地球の画像（IMAGERY）… 詳細な衛星写真・今日の地球（前日の雲）・雨雲レーダーの ON/OFF と、撮影日・観測時刻・クレジット
 * 「リアルタイム」「一定間隔で更新されるデータ」「軌道要素から計算した推定位置」を区別して書く。
 */
import { useState } from "react";
import { agoText, utcText, type LayerStatus } from "@/lib/earth/status";
import { depthText, MAG_BANDS, magBand, QUAKE_FEED_LABEL, type QuakePoint } from "@/lib/earth/quakes";
import { FRESHNESS_LABEL, makeSatrec, orbitFreshness, SAT_GROUPS, SAT_LIMIT_MAX, satFailNote, satPosition, type OrbitElement, type SatGroup } from "@/lib/earth/satellites";
import type { EarthSettings } from "@/lib/earth/settings";
import type { LayerData } from "./useEarthData";
import { GIBS_CREDIT, ISS_LIVE_EMBED, ISS_LIVE_PAGE, isIssName, RADAR_CREDIT, S2_CREDIT, S2_YEAR, type ImageryCredit, type RadarFrame } from "@/lib/earth/imagery";
import type { ImageryKind } from "./EdithEarth";

function Credit({ c }: { c: ImageryCredit }) {
  return (
    <>
      {c.text}{" "}
      {c.links.map((l) => (
        <a key={l.href} href={l.href} target="_blank" rel="noopener noreferrer">
          {l.label}{" "}
        </a>
      ))}
    </>
  );
}

const STATUS_HINT: Record<LayerStatus, string> = {
  LOADING: "取得しています",
  LIVE: "取得できています",
  STALE: "前に取れたデータを表示しています（最新ではありません）",
  "NO DATA": "取得できましたが、該当するデータがありません",
  ERROR: "取得できませんでした",
  OFFLINE: "オフラインのため取得できません",
};

function StatusChip({ status, predicted }: { status: LayerStatus; predicted?: boolean }) {
  return (
    <span className="eearth__chip" data-status={status} title={STATUS_HINT[status]}>
      {status === "LIVE" && predicted ? "LIVE · 推定" : status}
    </span>
  );
}

interface PanelProps {
  settings: EarthSettings;
  onSettings: (f: (s: EarthSettings) => EarthSettings) => void;
  quakes: LayerData<{ ok: true; fetchedAt: string; items: QuakePoint[] }>;
  sats: LayerData<{ ok: true; fetchedAt: string; elements: OrbitElement[] }>;
  now: number;
  /** 場所の検索（見つかれば true） */
  onSearch: (text: string) => boolean;
  onReset: () => void;
  viewStatus: string;
  /** 一覧から選ぶ（地球儀の点のクリックと同じ） */
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** 雨雲レーダーの取得の状態（無ければ出さない） */
  radar?: LayerData<{ ok: true; fetchedAt: string; items: RadarFrame[] }>;
  /** 今日の地球に使っている日（UTC） */
  cloudsDate?: string;
  /** 重ねた画像の一部を読み込めなかった種類 */
  imageryErrors?: Partial<Record<ImageryKind, boolean>>;
}

export function EarthLayersPanel(p: PanelProps) {
  const [q, setQ] = useState("");
  const [searchMsg, setSearchMsg] = useState("");
  const set = <K extends keyof EarthSettings>(k: K, v: EarthSettings[K]) => p.onSettings((s) => ({ ...s, [k]: v }));
  const qd = p.quakes.data;
  const sd = p.sats.data;
  const shownSats = sd ? Math.min(sd.elements.length, p.settings.satLimit) : 0;
  return (
    <div className="eearth__panel">
      <section className="eearth__layer" aria-label="地震のレイヤー">
        <header>
          <button type="button" className="edisp__toggle" role="switch" aria-checked={p.settings.quakes} data-on={p.settings.quakes || undefined} onClick={() => set("quakes", !p.settings.quakes)}>
            <span>EARTHQUAKES</span>
          </button>
          {p.settings.quakes && <StatusChip status={p.quakes.status} />}
        </header>
        {p.settings.quakes && (
          <dl>
            <dt>DATA</dt>
            <dd>{QUAKE_FEED_LABEL}（一定間隔で更新）</dd>
            <dt>COUNT</dt>
            <dd>{qd ? `${qd.items.length} 件` : "—"}</dd>
            <dt>FETCHED</dt>
            <dd title={qd ? utcText(qd.fetchedAt) : undefined}>{qd ? `${agoText(Date.parse(qd.fetchedAt), p.now)}（${utcText(qd.fetchedAt)}）` : "—"}</dd>
            {p.quakes.fetch.lastError && (p.quakes.status === "STALE" || p.quakes.status === "ERROR") && (
              <>
                <dt>ERROR</dt>
                <dd className="eearth__err">{p.quakes.fetch.lastError}</dd>
              </>
            )}
          </dl>
        )}
        {p.settings.quakes && qd && qd.items.length > 0 && (
          <ul className="eearth__list" aria-label="規模の大きい地震">
            {[...qd.items]
              .sort((a, b) => b.mag - a.mag)
              .slice(0, 5)
              .map((x) => (
                <li key={x.id}>
                  <button type="button" data-on={p.selectedId === `quake:${x.id}` || undefined} onClick={() => p.onSelect(`quake:${x.id}`)}>
                    <i style={{ background: magBand(x.mag).color }} />
                    <b>M{x.mag.toFixed(1)}</b>
                    <span>{x.place}</span>
                  </button>
                </li>
              ))}
          </ul>
        )}
      </section>

      <section className="eearth__layer" aria-label="人工衛星のレイヤー">
        <header>
          <button type="button" className="edisp__toggle" role="switch" aria-checked={p.settings.sats} data-on={p.settings.sats || undefined} onClick={() => set("sats", !p.settings.sats)}>
            <span>SATELLITES</span>
          </button>
          {p.settings.sats && <StatusChip status={p.sats.status} predicted />}
        </header>
        {p.settings.sats && (
          <>
            <label className="edisp__row edisp__select">
              <span>GROUP</span>
              <select value={p.settings.satGroup} onChange={(e) => set("satGroup", e.target.value as SatGroup)}>
                {SAT_GROUPS.map((g) => (
                  <option key={g.key} value={g.key}>
                    {g.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="edisp__row edisp__slider" style={{ ["--v" as string]: `${(p.settings.satLimit / SAT_LIMIT_MAX) * 100}%` }} title="一度に描く衛星の数（多いと重くなります）">
              <span>LIMIT</span>
              <input type="range" min={5} max={SAT_LIMIT_MAX} step={5} value={p.settings.satLimit} onChange={(e) => set("satLimit", Number(e.target.value))} aria-label="描く衛星の数" />
              <b>{p.settings.satLimit}</b>
            </label>
            <dl>
              <dt>DATA</dt>
              <dd>CelesTrak の軌道要素から計算した推定位置（観測値ではありません）</dd>
              <dt>COUNT</dt>
              <dd>{sd ? `${shownSats} / ${sd.elements.length} 機` : "—"}</dd>
              <dt>FETCHED</dt>
              <dd>{sd ? `${agoText(Date.parse(sd.fetchedAt), p.now)}（${utcText(sd.fetchedAt)}）` : "—"}</dd>
              {p.sats.fetch.lastError && (p.sats.status === "STALE" || p.sats.status === "ERROR") && (
                <>
                  <dt>ERROR</dt>
                  <dd className="eearth__err">{p.sats.fetch.lastError}</dd>
                  {p.sats.fail && satFailNote(p.sats.fail) && (
                    <>
                      <dt>STATE</dt>
                      <dd className="eearth__err" data-sat-hold={p.sats.fail.reason ?? undefined}>
                        {satFailNote(p.sats.fail)}
                      </dd>
                    </>
                  )}
                </>
              )}
            </dl>
            {sd && sd.elements.length > 0 && (
              <ul className="eearth__list" aria-label="衛星">
                {sd.elements.slice(0, Math.min(5, p.settings.satLimit)).map((x) => (
                  <li key={x.id}>
                    <button type="button" data-on={p.selectedId === `sat:${x.id}` || undefined} onClick={() => p.onSelect(`sat:${x.id}`)}>
                      <i style={{ background: "#5cf2ff" }} />
                      <span>{x.name}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>

      <section className="eearth__layer" aria-label="地球の画像">
        <header>
          <span className="eearth__sect">IMAGERY</span>
        </header>
        <header>
          <button type="button" className="edisp__toggle" role="switch" aria-checked={p.settings.detail} data-on={p.settings.detail || undefined} onClick={() => set("detail", !p.settings.detail)} title="Sentinel-2 の雲なし衛星写真（10m 程度まで拡大できます）">
            <span>DETAIL（衛星写真）</span>
          </button>
        </header>
        {p.settings.detail && (
          <dl>
            <dt>DATA</dt>
            <dd>Sentinel-2 cloudless（{S2_YEAR} 年の写真をつないだもの。いまの様子ではありません）</dd>
            {p.imageryErrors?.detail && (
              <>
                <dt>ERROR</dt>
                <dd className="eearth__err">一部の衛星写真を読み込めませんでした（届いた部分だけ表示しています）</dd>
              </>
            )}
          </dl>
        )}
        <header>
          <button type="button" className="edisp__toggle" role="switch" aria-checked={p.settings.clouds} data-on={p.settings.clouds || undefined} onClick={() => set("clouds", !p.settings.clouds)} title="NASA の衛星（MODIS）が撮った地球全体の画像（前日分・雲の様子）">
            <span>CLOUDS（今日の地球）</span>
          </button>
        </header>
        {p.settings.clouds && (
          <dl>
            <dt>DATA</dt>
            <dd>NASA GIBS · MODIS（Terra）の撮影日 {p.cloudsDate ?? "—"}（UTC）。毎日更新・数時間〜1 日遅れ</dd>
            {p.imageryErrors?.clouds && (
              <>
                <dt>ERROR</dt>
                <dd className="eearth__err">一部の画像を読み込めませんでした</dd>
              </>
            )}
          </dl>
        )}
        <header>
          <button type="button" className="edisp__toggle" role="switch" aria-checked={p.settings.radar} data-on={p.settings.radar || undefined} onClick={() => set("radar", !p.settings.radar)} title="世界の雨雲レーダー（RainViewer。約 10 分ごと）">
            <span>RADAR（雨雲）</span>
          </button>
          {p.settings.radar && p.radar && <StatusChip status={p.radar.status} />}
        </header>
        {p.settings.radar && (
          <dl>
            <dt>OBSERVED</dt>
            <dd>{p.radar?.data?.items[0] ? `${utcText(p.radar.data.items[0].time)}（${agoText(Date.parse(p.radar.data.items[0].time), p.now)}）` : "—"}</dd>
            <dt>FETCHED</dt>
            <dd>{p.radar?.data ? agoText(p.radar.fetch.lastOkAt, p.now) : "—"}</dd>
            {p.radar?.fetch.lastError && (p.radar.status === "STALE" || p.radar.status === "ERROR") && (
              <>
                <dt>ERROR</dt>
                <dd className="eearth__err">{p.radar.fetch.lastError}</dd>
              </>
            )}
            {p.imageryErrors?.radar && (
              <>
                <dt>ERROR</dt>
                <dd className="eearth__err">一部のレーダー画像を読み込めませんでした</dd>
              </>
            )}
          </dl>
        )}
      </section>

      <form
        className="eearth__search"
        onSubmit={(e) => {
          e.preventDefault();
          const ok = q.trim() ? p.onSearch(q.trim()) : false;
          setSearchMsg(q.trim() ? (ok ? "" : "その場所は見つかりませんでした（国・主な都市の名前で探せます）") : "");
        }}
      >
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="場所へ移動（例：東京・ロンドン）" aria-label="場所の名前" />
        <button type="submit" className="efeed__tool">GO</button>
      </form>
      {searchMsg && <p className="eearth__err">{searchMsg}</p>}

      <div className="eearth__row">
        <button type="button" className="efeed__tool" onClick={p.onReset} title="宇宙から見下ろす初期の視点に戻す">
          RESET VIEW
        </button>
        <button type="button" className="efeed__tool" data-on={p.settings.autoRotate || undefined} aria-pressed={p.settings.autoRotate} onClick={() => set("autoRotate", !p.settings.autoRotate)} title="地球をゆっくり回す（操作中・追従中は止まる）">
          AUTO ROTATE
        </button>
        <span className="eearth__view">{p.viewStatus}</span>
      </div>

      <div className="eearth__legend" aria-label="凡例">
        <p>LEGEND</p>
        {MAG_BANDS.map((b) => (
          <span key={b.label}>
            <i style={{ background: b.color, width: b.size / 1.6, height: b.size / 1.6 }} />
            地震 {b.label}
          </span>
        ))}
        <span>
          <i style={{ background: "#5cf2ff", width: 6, height: 6 }} />
          人工衛星（推定位置）
        </span>
      </div>
      <p className="eearth__attr">
        地震：USGS（米国地質調査所）公開データ ／ 衛星：CelesTrak の GP データを satellite.js（SGP4）で計算 ／ 地図：Natural Earth II（パブリックドメイン）／ 3D：CesiumJS
        {p.settings.detail && (
          <>
            {" "}／ <Credit c={S2_CREDIT} />
          </>
        )}
        {p.settings.clouds && (
          <>
            {" "}／ <Credit c={GIBS_CREDIT} />
          </>
        )}
        {p.settings.radar && (
          <>
            {" "}／ <Credit c={RADAR_CREDIT} />
          </>
        )}
      </p>
    </div>
  );
}

interface DetailProps {
  quake?: QuakePoint;
  quakesFetchedAt?: string;
  sat?: OrbitElement;
  satsFetchedAt?: string;
  now: number;
  tracked: boolean;
  onTrack: () => void;
  onUntrack: () => void;
  onFly: (lat: number, lon: number) => void;
  onClose: () => void;
}

export function EarthDetail(p: DetailProps) {
  const [live, setLive] = useState(false);
  const rec = p.sat ? makeSatrec(p.sat) : null;
  const pos = rec ? satPosition(rec, p.now) : null;
  const fresh = p.sat ? orbitFreshness(p.sat.epoch, p.now) : null;
  return (
    <div className="epoint eearth__detail" role="dialog" aria-label="選んだ対象の詳細">
      <button type="button" className="epoint__close" onClick={p.onClose} aria-label="閉じる">
        ×
      </button>
      {p.quake && (
        <>
          <p className="epoint__meta">EARTHQUAKE · USGS</p>
          <h3>
            <i className="eearth__dot" style={{ background: magBand(p.quake.mag).color }} />M{p.quake.mag.toFixed(1)} {p.quake.place}
          </h3>
          <dl>
            <dt>発生時刻</dt>
            <dd>
              {utcText(p.quake.time)}（{agoText(Date.parse(p.quake.time), p.now)}）
            </dd>
            <dt>深さ</dt>
            <dd>{depthText(p.quake.depthKm)}</dd>
            <dt>震源</dt>
            <dd>
              {p.quake.lat.toFixed(3)}°, {p.quake.lon.toFixed(3)}°
            </dd>
            <dt>値の状態</dt>
            <dd>{p.quake.status === "reviewed" ? "確定値（reviewed）" : "自動決定（後で変わることがあります）"}</dd>
            <dt>USGS の更新</dt>
            <dd>{utcText(p.quake.updated)}</dd>
            <dt>データの取得</dt>
            <dd>{p.quakesFetchedAt ? `${utcText(p.quakesFetchedAt)}（このシステムが取得した時刻）` : "—"}</dd>
          </dl>
          {p.quake.url && (
            <p>
              <a href={p.quake.url} target="_blank" rel="noopener noreferrer">
                USGS のページを開く
              </a>
            </p>
          )}
        </>
      )}
      {p.sat && (
        <>
          <p className="epoint__meta">SATELLITE · CelesTrak · 推定位置</p>
          <h3>{p.sat.name}</h3>
          <dl>
            <dt>NORAD</dt>
            <dd>
              {p.sat.id}
              {p.sat.intlId ? ` / ${p.sat.intlId}` : ""}
            </dd>
            <dt>推定位置</dt>
            <dd>{pos ? `${pos.lat.toFixed(2)}°, ${pos.lon.toFixed(2)}° · 高度 ${Math.round(pos.heightKm).toLocaleString()} km` : "計算できません"}</dd>
            <dt>計算の時刻</dt>
            <dd>{pos ? utcText(pos.at) : "—"}</dd>
            <dt>軌道要素の時刻</dt>
            <dd>
              {utcText(p.sat.epoch)}（{agoText(Date.parse(p.sat.epoch), p.now)}・{fresh ? FRESHNESS_LABEL[fresh] : "—"}）
            </dd>
            <dt>データの取得</dt>
            <dd>{p.satsFetchedAt ? utcText(p.satsFetchedAt) : "—"}</dd>
          </dl>
          <p className="eearth__note">軌道要素（SGP4）から計算した推定位置です。観測した位置ではなく、軌道要素が古いほど誤差が大きくなります。</p>
          {isIssName(p.sat.name) && (
            <div className="eearth__live">
              {live ? (
                <>
                  <div className="eearth__video">
                    <iframe src={ISS_LIVE_EMBED} title="NASA 公式ライブ映像（国際宇宙ステーション）" allow="autoplay; encrypted-media; picture-in-picture" referrerPolicy="strict-origin-when-cross-origin" allowFullScreen />
                  </div>
                  <p className="eearth__note">
                    NASA 公式の YouTube ライブ。時間帯によって ISS 以外の中継や、通信の切り替えで青い画面になることがあります。映らないときは{" "}
                    <a href={ISS_LIVE_PAGE} target="_blank" rel="noopener noreferrer">
                      YouTube で開く
                    </a>
                  </p>
                  <button type="button" className="ebtn" onClick={() => setLive(false)}>
                    ライブ映像を閉じる
                  </button>
                </>
              ) : (
                <button type="button" className="ebtn" onClick={() => setLive(true)} title="押したときだけ YouTube（youtube-nocookie）を読み込みます">
                  ▶ ライブ映像（NASA 公式）
                </button>
              )}
            </div>
          )}
        </>
      )}
      <div className="eearth__row">
        {p.tracked ? (
          <button type="button" className="ebtn" onClick={p.onUntrack}>
            追従を解除
          </button>
        ) : (
          <button type="button" className="ebtn" onClick={p.onTrack}>
            追従する
          </button>
        )}
        {p.quake && (
          <button type="button" className="ebtn" onClick={() => p.onFly(p.quake!.lat, p.quake!.lon)}>
            この地点へ移動
          </button>
        )}
        {pos && (
          <button type="button" className="ebtn" onClick={() => p.onFly(pos.lat, pos.lon)}>
            いまの推定位置へ移動
          </button>
        )}
      </div>
    </div>
  );
}
