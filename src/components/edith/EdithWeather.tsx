"use client";

/**
 * E.D.I.T.H. の WEATHER：Windy の天気の地図（Windy Map Forecast API）。風の流れ・雨・気温などが動く地図。
 *   - Windy のライブラリ（Leaflet 1.4.0 と libBoot.js）は、初めて WEATHER を開いたときだけ読み込む
 *   - Windy の地図はページの中で 1 回しか作れない（windyInit は 1 回だけ）。作った地図（#windy）は捨てずに、
 *     画面を閉じるときは見えない置き場へ移し、また開いたら戻して使う
 *   - キーは Windy の設定で、このサイトのドメインだけで使えるように制限しておくこと（キーは画面に渡る）
 *   - Windy のロゴ・出典は地図の中に出る（消さない）
 */
import { useEffect, useRef, useState } from "react";
import { WINDY_LIB, type WindyOverlay } from "@/lib/earth/windy-map";

interface WindyApi {
  map: { setView: (latlng: [number, number], zoom?: number, opts?: unknown) => void; invalidateSize: () => void };
  store: { set: (k: string, v: unknown) => unknown; get: (k: string) => unknown };
}
type WindyInit = (opts: { key: string; lat: number; lon: number; zoom: number; verbose?: boolean }, cb: (api: WindyApi) => void) => void;
type Win = Window & { windyInit?: WindyInit; L?: unknown };

/** 作った地図（ページの中で 1 つだけ） */
let created: { key: string; host: HTMLDivElement; api: Promise<WindyApi> } | null = null;
let parking: HTMLDivElement | null = null;

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const found = document.querySelector<HTMLScriptElement>(`script[data-edith-windy="${src}"]`);
    if (found?.dataset.loaded) return resolve();
    const s = found ?? document.createElement("script");
    s.addEventListener("load", () => {
      s.dataset.loaded = "1";
      resolve();
    });
    s.addEventListener("error", () => reject(new Error("Windy の地図の部品を読み込めませんでした")));
    if (!found) {
      s.src = src;
      s.async = false;
      s.dataset.edithWindy = src;
      document.head.appendChild(s);
    }
  });
}

function loadCss(href: string) {
  if (document.querySelector(`link[data-edith-windy="${href}"]`)) return;
  const l = document.createElement("link");
  l.rel = "stylesheet";
  l.href = href;
  l.dataset.edithWindy = href;
  document.head.appendChild(l);
}

/** 地図を作る（2 回目からは、作ったものを返す）。host は、見えている場所に置いてから呼ぶ */
function createWindy(key: string, host: HTMLDivElement, at: { lat: number; lon: number; zoom: number }): Promise<WindyApi> {
  return (async () => {
    loadCss(WINDY_LIB.leafletCss);
    const w = window as Win;
    if (!w.L) await loadScript(WINDY_LIB.leafletJs);
    if (!w.windyInit) await loadScript(WINDY_LIB.boot);
    const init = w.windyInit;
    if (!init) throw new Error("Windy の地図の部品を読み込めませんでした");
    return await new Promise<WindyApi>((resolve, reject) => {
      // キーが使えない（ドメインの制限・誤り）ときは、呼び返しが来ないことがある
      const t = window.setTimeout(() => reject(new Error("Windy の地図を開けませんでした（キー・ドメインの制限を確認してください）")), 25_000);
      try {
        host.id = "windy";
        init({ key, lat: at.lat, lon: at.lon, zoom: at.zoom, verbose: false }, (api) => {
          clearTimeout(t);
          resolve(api);
        });
      } catch (err) {
        clearTimeout(t);
        reject(err instanceof Error ? err : new Error("Windy の地図を開けませんでした"));
      }
    });
  })();
}

export interface WeatherCenter {
  lat: number;
  lon: number;
  zoom: number;
  /** 変わるたびにそこへ移る */
  key: number;
}

interface Props {
  active: boolean;
  apiKey: string | null;
  /** 設定を読み込み中（キーの有無がまだ分からない） */
  configLoading: boolean;
  overlay: WindyOverlay;
  center: WeatherCenter | null;
}

export function EdithWeather({ active, apiKey, configLoading, overlay, center }: Props) {
  const slot = useRef<HTMLDivElement>(null);
  const apiRef = useRef<WindyApi | null>(null);
  const [state, setState] = useState<{ s: "idle" | "loading" | "ready" | "error"; msg?: string }>({ s: "idle" });
  const latest = useRef({ overlay, center });
  latest.current = { overlay, center };

  // 地図を作る・置き場から戻す（見えているときだけ。見えていない場所で作ると大きさを誤る）
  useEffect(() => {
    const el = slot.current;
    if (!el || !active || !apiKey) return;
    let gone = false;
    if (created && created.key !== apiKey) {
      setState({ s: "error", msg: "キーが変わりました。ページを読み込み直すと新しいキーで開きます。" });
      return;
    }
    if (!created) {
      const host = document.createElement("div");
      host.className = "eweather__map";
      el.appendChild(host);
      const c = latest.current.center;
      created = { key: apiKey, host, api: createWindy(apiKey, host, c ?? { lat: 35.68, lon: 139.77, zoom: 5 }) };
      created.api.catch(() => {
        // 失敗したら、次に開いたときに作り直せるようにする
        host.remove();
        created = null;
      });
    } else if (created.host.parentElement !== el) el.appendChild(created.host);
    const mine = created;
    setState((st) => (st.s === "ready" ? st : { s: "loading" }));
    mine.api.then(
      (api) => {
        if (gone) return;
        apiRef.current = api;
        api.map.invalidateSize();
        api.store.set("overlay", latest.current.overlay);
        setState({ s: "ready" });
      },
      (err: unknown) => {
        if (!gone) setState({ s: "error", msg: err instanceof Error ? err.message : "Windy の地図を開けませんでした" });
      },
    );
    return () => {
      gone = true;
      // 地図は捨てずに、見えない置き場へ移す（Windy の地図はページの中で 1 回しか作れない）
      if (created && created.host.parentElement === el) {
        if (!parking) {
          parking = document.createElement("div");
          parking.style.display = "none";
          parking.setAttribute("aria-hidden", "true");
          document.body.appendChild(parking);
        }
        parking.appendChild(created.host);
      }
    };
  }, [active, apiKey]);

  // 表示するもの（風・雨・気温など）
  useEffect(() => {
    if (state.s === "ready") apiRef.current?.store.set("overlay", overlay);
  }, [overlay, state.s]);

  // 場所へ移る
  useEffect(() => {
    if (state.s !== "ready" || !center) return;
    apiRef.current?.map.setView([center.lat, center.lon], center.zoom);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [center?.key, state.s]);

  return (
    <div className="eweather" ref={slot} data-state={state.s}>
      {!apiKey ? (
        <p className="eweather__msg">
          {configLoading ? "設定を確認しています…" : "WEATHER（Windy の天気の地図）はキーが未設定です。Windy の Map Forecast API のキーを Vercel の環境変数 WINDY_MAP_KEY に入れると使えます。"}
        </p>
      ) : state.s === "loading" || state.s === "idle" ? (
        <p className="eweather__msg">Windy の天気の地図を読み込んでいます…</p>
      ) : state.s === "error" ? (
        <p className="eweather__msg eweather__msg--err">{state.msg}</p>
      ) : null}
    </div>
  );
}
