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
import type { EarthConfig } from "./useEarthData";
import { aircraftPositionAt, type Aircraft } from "@/lib/earth/aircraft";
import type { Bus, Ship } from "@/lib/earth/transport";
import type { Webcam } from "@/lib/earth/webcams";

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
  /** 飛行機の取得の状態 */
  aircraft?: LayerData<{ ok: true; fetchedAt: string; items: Aircraft[] }>;
  /** 見ている範囲が広すぎて、飛行機を取りに行っていない */
  aircraftTooWide?: boolean;
  /** 外部サービスの設定の有無 */
  config?: EarthConfig | null;
  /** 3D の街の状態 */
  city3d?: { state: "off" | "loading" | "ready" | "error"; message?: string };
  /** 3D の街を見る（東京駅のあたりへ斜めに寄る） */
  onCityView?: () => void;
  buses?: LayerData<{ ok: true; fetchedAt: string; items: Bus[] }>;
  busesInView?: boolean;
  ships?: LayerData<{ ok: true; fetchedAt: string; items: Ship[] }>;
  shipsInView?: boolean;
  webcams?: LayerData<{ ok: true; fetchedAt: string; items: Webcam[] }>;
  /** ライブカメラを探す場所が決まっている（寄っている・ピックアップした） */
  webcamsInView?: boolean;
  /** 見つかったカメラを一覧で開く */
  onOpenCams?: () => void;
}

/** キーの要るレイヤーの「未設定・寄ると表示・件数・取得時刻・エラー」 */
function KeyedLayer(p: { configured: boolean | undefined; envName: string; inView: boolean | undefined; viewHint: string; data?: LayerData<{ ok: true; fetchedAt: string; items: unknown[] }>; unit: string; now: number; source: string }) {
  return (
    <dl>
      <dt>DATA</dt>
      <dd>{p.source}</dd>
      {p.configured === undefined ? (
        <>
          <dt>STATE</dt>
          <dd>設定を確認しています</dd>
        </>
      ) : !p.configured ? (
        <>
          <dt>STATE</dt>
          <dd className="eearth__err">未設定：キーを Vercel の環境変数 {p.envName} に入れると使えます</dd>
        </>
      ) : !p.inView ? (
        <>
          <dt>VIEW</dt>
          <dd>{p.viewHint}</dd>
        </>
      ) : (
        <>
          <dt>COUNT</dt>
          <dd>{p.data?.data ? `${p.data.data.items.length} ${p.unit}` : "—"}</dd>
          <dt>FETCHED</dt>
          <dd>{p.data?.data ? `${agoText(Date.parse(p.data.data.fetchedAt), p.now)}（${utcText(p.data.data.fetchedAt)}）` : "—"}</dd>
          {p.data?.fetch.lastError && (p.data.status === "STALE" || p.data.status === "ERROR") && (
            <>
              <dt>ERROR</dt>
              <dd className="eearth__err">{p.data.fetch.lastError}</dd>
            </>
          )}
        </>
      )}
    </dl>
  );
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

      <section className="eearth__layer" aria-label="飛行機のレイヤー">
        <header>
          <button type="button" className="edisp__toggle" role="switch" aria-checked={p.settings.aircraft} data-on={p.settings.aircraft || undefined} onClick={() => set("aircraft", !p.settings.aircraft)}>
            <span>AIRCRAFT</span>
          </button>
          {p.settings.aircraft && p.aircraft && !p.aircraftTooWide && <StatusChip status={p.aircraft.status} predicted />}
        </header>
        {p.settings.aircraft && (
          <>
            <dl>
              <dt>DATA</dt>
              <dd>OpenSky Network（機体が報告した位置。報告の後は速度と向きから推定して動かします）</dd>
              {p.aircraftTooWide ? (
                <>
                  <dt>VIEW</dt>
                  <dd>もっと寄ると表示します（見ている範囲が広すぎるため、取りに行っていません）</dd>
                </>
              ) : (
                <>
                  <dt>COUNT</dt>
                  <dd>{p.aircraft?.data ? `${p.aircraft.data.items.length} 機（空を飛んでいるもの）` : "—"}</dd>
                  <dt>FETCHED</dt>
                  <dd>{p.aircraft?.data ? `${agoText(Date.parse(p.aircraft.data.fetchedAt), p.now)}（${utcText(p.aircraft.data.fetchedAt)}）` : "—"}</dd>
                </>
              )}
              {p.aircraft?.fetch.lastError && (p.aircraft.status === "STALE" || p.aircraft.status === "ERROR") && !p.aircraftTooWide && (
                <>
                  <dt>ERROR</dt>
                  <dd className="eearth__err">{p.aircraft.fetch.lastError}</dd>
                </>
              )}
              {p.config?.services.opensky === "anonymous" && (
                <>
                  <dt>NOTE</dt>
                  <dd>匿名で取得しています（1 日の回数が少なめ。OpenSky に無料登録して OPENSKY_CLIENT_ID・OPENSKY_CLIENT_SECRET を設定すると増えます）</dd>
                </>
              )}
            </dl>
            {!p.aircraftTooWide && p.aircraft?.data && p.aircraft.data.items.length > 0 && (
              <ul className="eearth__list" aria-label="飛行機">
                {p.aircraft.data.items.slice(0, 5).map((a) => (
                  <li key={a.icao24}>
                    <button type="button" data-on={p.selectedId === `air:${a.icao24}` || undefined} onClick={() => p.onSelect(`air:${a.icao24}`)}>
                      <i className="eearth__dot" style={{ background: "#ffd27a" }} />
                      <span>{a.callsign ?? a.icao24.toUpperCase()}</span>
                      <small>{a.altM !== null ? `${Math.round(a.altM).toLocaleString()} m` : ""}</small>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>

      <section className="eearth__layer" aria-label="道路の渋滞">
        <header>
          <button type="button" className="edisp__toggle" role="switch" aria-checked={p.settings.traffic} data-on={p.settings.traffic || undefined} onClick={() => set("traffic", !p.settings.traffic)}>
            <span>TRAFFIC（渋滞）</span>
          </button>
        </header>
        {p.settings.traffic && (
          <dl>
            <dt>DATA</dt>
            <dd>TomTom の道路ごとの混み具合（緑＝流れている → 赤＝混んでいる）。寄ったときだけ表示します</dd>
            {p.config && !p.config.services.tomtom && (
              <>
                <dt>STATE</dt>
                <dd className="eearth__err">未設定：キーを Vercel の環境変数 TOMTOM_API_KEY に入れると使えます</dd>
              </>
            )}
            {p.imageryErrors?.traffic && (
              <>
                <dt>ERROR</dt>
                <dd className="eearth__err">一部の渋滞の画像を読み込めませんでした</dd>
              </>
            )}
          </dl>
        )}
      </section>

      <section className="eearth__layer" aria-label="都営バスのレイヤー">
        <header>
          <button type="button" className="edisp__toggle" role="switch" aria-checked={p.settings.buses} data-on={p.settings.buses || undefined} onClick={() => set("buses", !p.settings.buses)}>
            <span>BUSES（都営バス）</span>
          </button>
          {p.settings.buses && p.config?.services.odpt && p.busesInView && p.buses && <StatusChip status={p.buses.status} />}
        </header>
        {p.settings.buses && (
          <KeyedLayer configured={p.config ? p.config.services.odpt : undefined} envName="ODPT_CONSUMER_KEY" inView={p.busesInView} viewHint="東京のあたりに寄ると表示します" data={p.buses} unit="台" now={p.now} source="公共交通オープンデータ（都営バスの位置。約 30 秒ごと）" />
        )}
      </section>

      <section className="eearth__layer" aria-label="船のレイヤー">
        <header>
          <button type="button" className="edisp__toggle" role="switch" aria-checked={p.settings.ships} data-on={p.settings.ships || undefined} onClick={() => set("ships", !p.settings.ships)}>
            <span>SHIPS（船）</span>
          </button>
          {p.settings.ships && p.config?.services.ais && p.shipsInView && p.ships && <StatusChip status={p.ships.status} />}
        </header>
        {p.settings.ships && (
          <KeyedLayer configured={p.config ? p.config.services.ais : undefined} envName="AISSTREAM_API_KEY" inView={p.shipsInView} viewHint="もっと寄ると表示します（港や湾のあたり）" data={p.ships} unit="隻（最近報告のあったもの）" now={p.now} source="AISStream（船の AIS の位置の報告。約 1 分ごと）" />
        )}
      </section>

      <section className="eearth__layer" aria-label="ライブカメラのレイヤー">
        <header>
          <button type="button" className="edisp__toggle" role="switch" aria-checked={p.settings.webcams} data-on={p.settings.webcams || undefined} onClick={() => set("webcams", !p.settings.webcams)}>
            <span>LIVE CAMS（ライブカメラ）</span>
          </button>
          {p.settings.webcams && p.config?.services.webcams && p.webcamsInView && p.webcams && <StatusChip status={p.webcams.status} />}
        </header>
        {p.settings.webcams && (
          <>
            <KeyedLayer configured={p.config ? p.config.services.webcams : undefined} envName="WINDY_WEBCAMS_KEY" inView={p.webcamsInView} viewHint="街に寄るか、声で「渋谷をピックアップ」と言うと、近くの公開カメラを探します" data={p.webcams} unit="台（近くの公開カメラ）" now={p.now} source="Windy Webcams（運営者が公開している道路・街・観光地のカメラ）" />
            {p.config?.services.webcams && p.webcamsInView && (p.webcams?.data?.items.length ?? 0) > 0 && (
              <button type="button" className="ebtn" onClick={p.onOpenCams}>
                カメラを一覧で見る
              </button>
            )}
          </>
        )}
      </section>

      <section className="eearth__layer" aria-label="地球の画像">
        <header>
          <span className="eearth__sect">IMAGERY</span>
        </header>
        <header>
          <button type="button" className="edisp__toggle" role="switch" aria-checked={p.settings.city3d} data-on={p.settings.city3d || undefined} onClick={() => set("city3d", !p.settings.city3d)} title="Google の写真のような 3D の街（キーが必要）">
            <span>3D CITY（Google）</span>
          </button>
        </header>
        {p.settings.city3d && (
          <dl>
            <dt>STATE</dt>
            <dd className={p.city3d?.state === "error" || (p.config && !p.config.google3dKey) ? "eearth__err" : undefined}>
              {!p.config
                ? "設定を確認しています"
                : !p.config.google3dKey
                  ? "未設定：Google Maps Platform のキー（Map Tiles API）を Vercel の環境変数 GOOGLE_MAPS_API_KEY に入れると使えます"
                  : p.city3d?.state === "ready"
                    ? "表示中（Google の 3D の間は、ほかの地図の画像は隠しています）"
                    : p.city3d?.state === "error"
                      ? `読み込めませんでした：${p.city3d.message ?? ""}`
                      : "読み込んでいます"}
            </dd>
          </dl>
        )}
        {p.settings.city3d && p.city3d?.state === "ready" && p.onCityView && (
          <div className="eearth__row">
            <button type="button" className="efeed__tool" onClick={p.onCityView} title="東京駅のあたりへ斜めに寄る（場所の検索でも移動できます）">
              街に寄る（東京）
            </button>
          </div>
        )}
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
        {p.settings.aircraft && (
          <>
            {" "}／ 飛行機：{" "}
            <a href="https://opensky-network.org" target="_blank" rel="noopener noreferrer">
              The OpenSky Network
            </a>
          </>
        )}
        {p.settings.city3d && p.city3d?.state === "ready" && <> ／ 3D の街：Google（地球儀の下にロゴ・クレジット）</>}
        {p.settings.traffic && p.config?.services.tomtom && <> ／ 渋滞：© TomTom</>}
        {p.settings.buses && p.config?.services.odpt && <> ／ バス：公共交通オープンデータセンター・東京都交通局（CC BY 4.0）</>}
        {p.settings.ships && p.config?.services.ais && <> ／ 船：AISStream</>}
        {p.settings.webcams && p.config?.services.webcams && (
          <>
            {" "}／ ライブカメラ：
            <a href="https://www.windy.com/" target="_blank" rel="noopener noreferrer">
              Webcams provided by windy.com
            </a>
          </>
        )}
      </p>
    </div>
  );
}

interface DetailProps {
  cam?: Webcam;
  camsFetchedAt?: string;
  bus?: Bus;
  busesFetchedAt?: string;
  ship?: Ship;
  shipsFetchedAt?: string;
  aircraft?: Aircraft;
  aircraftFetchedAt?: string;
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
      {p.cam && <CamDetail cam={p.cam} fetchedAt={p.camsFetchedAt} now={p.now} />}
      {p.bus && (
        <>
          <p className="epoint__meta">BUS · 都営バス · ODPT</p>
          <h3>{p.bus.route ?? "都営バス"}</h3>
          <dl>
            <dt>車両</dt>
            <dd>{p.bus.number ?? "—"}</dd>
            <dt>位置</dt>
            <dd>
              {p.bus.lat.toFixed(4)}°, {p.bus.lon.toFixed(4)}°{p.bus.azimuth !== null ? ` · ${Math.round(p.bus.azimuth)}°` : ""}
            </dd>
            <dt>位置の時刻</dt>
            <dd>
              {utcText(p.bus.reportedAt)}（{agoText(Date.parse(p.bus.reportedAt), p.now)}）
            </dd>
            <dt>データの取得</dt>
            <dd>{p.busesFetchedAt ? utcText(p.busesFetchedAt) : "—"}</dd>
          </dl>
          <p className="eearth__note">東京都交通局が公開しているバスの位置（約 30 秒ごと）です。</p>
        </>
      )}
      {p.ship && (
        <>
          <p className="epoint__meta">SHIP · AIS · AISStream</p>
          <h3>{p.ship.name ?? `MMSI ${p.ship.mmsi}`}</h3>
          <dl>
            <dt>MMSI</dt>
            <dd>{p.ship.mmsi}</dd>
            <dt>位置</dt>
            <dd>
              {p.ship.lat.toFixed(4)}°, {p.ship.lon.toFixed(4)}°
            </dd>
            <dt>速度・向き</dt>
            <dd>
              {p.ship.sog !== null ? `${p.ship.sog.toFixed(1)} ノット` : "—"}
              {p.ship.heading !== null ? ` · ${Math.round(p.ship.heading)}°` : ""}
            </dd>
            <dt>報告の時刻</dt>
            <dd>
              {utcText(p.ship.reportedAt)}（{agoText(Date.parse(p.ship.reportedAt), p.now)}）
            </dd>
            <dt>データの取得</dt>
            <dd>{p.shipsFetchedAt ? utcText(p.shipsFetchedAt) : "—"}</dd>
          </dl>
          <p className="eearth__note">船が AIS で報告した位置です。止まっている船は報告が少なく、表示が古いことがあります。</p>
        </>
      )}
      {p.aircraft && (() => {
        const a = p.aircraft;
        const est = aircraftPositionAt(a, p.now);
        return (
          <>
            <p className="epoint__meta">AIRCRAFT · OpenSky Network</p>
            <h3>{a.callsign ?? a.icao24.toUpperCase()}</h3>
            <dl>
              <dt>ICAO24</dt>
              <dd>
                {a.icao24.toUpperCase()}
                {a.country ? ` · ${a.country}` : ""}
              </dd>
              <dt>報告の位置</dt>
              <dd>
                {a.lat.toFixed(3)}°, {a.lon.toFixed(3)}°（{utcText(a.reportedAt)}・{agoText(Date.parse(a.reportedAt), p.now)}）
              </dd>
              <dt>いまの推定</dt>
              <dd>{est.estimated ? `${est.lat.toFixed(3)}°, ${est.lon.toFixed(3)}°（速度と向きから推定）` : "報告の位置のまま"}</dd>
              <dt>高度</dt>
              <dd>{a.altM !== null ? `${Math.round(a.altM).toLocaleString()} m（約 ${Math.round(a.altM * 3.281).toLocaleString()} ft）` : "—"}</dd>
              <dt>速度・向き</dt>
              <dd>
                {a.speedMs !== null ? `${Math.round(a.speedMs * 3.6).toLocaleString()} km/h` : "—"}
                {a.heading !== null ? ` · ${Math.round(a.heading)}°` : ""}
                {a.verticalMs !== null && Math.abs(a.verticalMs) >= 0.5 ? ` · ${a.verticalMs > 0 ? "上昇" : "降下"} ${Math.abs(a.verticalMs).toFixed(1)} m/s` : ""}
              </dd>
              <dt>データの取得</dt>
              <dd>{p.aircraftFetchedAt ? utcText(p.aircraftFetchedAt) : "—"}</dd>
            </dl>
            <p className="eearth__note">機体が報告した位置（ADS-B など）です。報告の後は推定で動かしているため、実際の位置とずれることがあります。</p>
          </>
        );
      })()}
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
        {(p.bus || p.ship) && (
          <button type="button" className="ebtn" onClick={() => { const x = (p.bus ?? p.ship)!; p.onFly(x.lat, x.lon); }}>
            この位置へ移動
          </button>
        )}
        {p.aircraft && (
          <button type="button" className="ebtn" onClick={() => { const e = aircraftPositionAt(p.aircraft!, p.now); p.onFly(e.lat, e.lon); }}>
            この飛行機へ移動
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

/** ライブカメラの出典（Windy の条件：Windy.com へのリンクを出す） */
export const WINDY_CREDIT = { label: "Webcams provided by windy.com", href: "https://www.windy.com/" };

/** ライブカメラの詳細：最新の静止画と、押したときだけ読み込む再生画面（Windy） */
function CamDetail({ cam, fetchedAt, now }: { cam: Webcam; fetchedAt?: string; now: number }) {
  const [play, setPlay] = useState(false);
  return (
    <>
      <p className="epoint__meta">LIVE CAM · {cam.traffic ? "道路・交通" : "公開カメラ"} · Windy</p>
      <h3>{cam.title}</h3>
      {play && cam.player ? (
        <div className="eearth__video">
          <iframe src={cam.player} title={`${cam.title}（Windy の再生画面）`} allow="autoplay; fullscreen" referrerPolicy="strict-origin-when-cross-origin" allowFullScreen />
        </div>
      ) : cam.preview ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img className="ecam__img" src={cam.preview} alt={`${cam.title} の最新の画像`} loading="lazy" referrerPolicy="no-referrer" />
      ) : (
        <p className="eearth__note">画像を読み込めませんでした。</p>
      )}
      <dl>
        <dt>場所</dt>
        <dd>{[cam.city, cam.country].filter(Boolean).join(" · ") || `${cam.lat.toFixed(3)}°, ${cam.lon.toFixed(3)}°`}</dd>
        <dt>画像の更新</dt>
        <dd>{cam.updatedAt ? `${utcText(cam.updatedAt)}（${agoText(Date.parse(cam.updatedAt), now)}）` : "—"}</dd>
        <dt>データの取得</dt>
        <dd>{fetchedAt ? utcText(fetchedAt) : "—"}</dd>
      </dl>
      <div className="eearth__row">
        {cam.player && (
          <button type="button" className="ebtn" onClick={() => setPlay((v) => !v)} title="押したときだけ Windy の再生画面を読み込みます">
            {play ? "静止画に戻す" : "▶ 映像を再生（Windy）"}
          </button>
        )}
        {cam.detail && (
          <a className="ebtn" href={cam.detail} target="_blank" rel="noopener noreferrer">
            Windy で開く
          </a>
        )}
      </div>
      <p className="eearth__note">
        運営者が公開しているカメラの画像です（数分ごとの更新。再生はタイムラプス、カメラによってはライブ）。{" "}
        <a href={WINDY_CREDIT.href} target="_blank" rel="noopener noreferrer">
          {WINDY_CREDIT.label}
        </a>
      </p>
    </>
  );
}

/** ピックアップした場所の近くのライブカメラの一覧（静止画を並べる。押すとそのカメラを選ぶ） */
export function CamGrid(p: { title: string; items: Webcam[]; status: string; error?: string | null; onPick: (cam: Webcam) => void; onClose: () => void }) {
  return (
    <div className="ecams" role="dialog" aria-label={`${p.title} のライブカメラ`}>
      <button type="button" className="epoint__close" onClick={p.onClose} aria-label="閉じる">
        ×
      </button>
      <p className="epoint__meta">PICKUP · LIVE CAMS · Windy</p>
      <h3>
        {p.title}
        <small>{p.items.length ? ` ${p.items.length} 台` : ""}</small>
      </h3>
      {p.items.length ? (
        <ul className="ecams__grid">
          {p.items.slice(0, 12).map((c) => (
            <li key={c.id}>
              <button type="button" onClick={() => p.onPick(c)} title={c.title}>
                {c.thumbnail ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={c.thumbnail} alt="" loading="lazy" referrerPolicy="no-referrer" />
                ) : (
                  <span className="ecams__noimg">NO IMAGE</span>
                )}
                <span className="ecams__name">{c.title}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="eearth__note">{p.error ? p.error : p.status}</p>
      )}
      <p className="eearth__note">
        運営者が公開しているカメラだけを表示します。{" "}
        <a href={WINDY_CREDIT.href} target="_blank" rel="noopener noreferrer">
          {WINDY_CREDIT.label}
        </a>
      </p>
    </div>
  );
}
