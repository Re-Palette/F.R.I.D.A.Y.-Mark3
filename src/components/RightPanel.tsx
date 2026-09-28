import { memo, useEffect, useState, type ReactNode } from "react";
import type { CalendarEventView } from "@/core/types";
import { QUICK_ACCESS, SAMPLE_PROJECTS, SAMPLE_SCHEDULE, SAMPLE_WEATHER } from "@/data/dashboard";
import { useCalendar } from "@/hooks/useCalendar";
import type { WeatherKind, WeatherReport } from "@/integrations/weather";
import { HudFrame } from "./HudFrame";
import { Icon, type IconName } from "./icons";

function PanelHead({ title, accent, extra, idx }: { title: string; accent?: string; extra?: ReactNode; idx: string }) {
  return (
    <div className="panel__head">
      <span className="panel__idx">{idx}</span>
      <span>
        {title} {accent && <em>{accent}</em>}
      </span>
      <i className="panel__rule" />
      {extra && <span className="panel__extra">{extra}</span>}
    </div>
  );
}

/** Phase 1 の右パネルはサンプル表示（未接続） */
const SAMPLE_TITLE = "サンプルデータ（連携は今後のアップデートで対応）";

const WEATHER_ICON: Record<WeatherKind, IconName> = {
  clear: "sun",
  partly: "weather",
  cloudy: "cloud",
  fog: "fog",
  rain: "rain",
  snow: "snow",
  storm: "storm",
};

const DAY_EN = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const dayEn = (date: string) => DAY_EN[new Date(`${date}T12:00:00Z`).getUTCDay()];

/** 天気（Open-Meteo）。取れなければサンプル表示 */
function WeatherPanel() {
  const [weather, setWeather] = useState<WeatherReport | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch("/api/weather", { cache: "no-store" })
        .then((r) => r.json() as Promise<{ ok: boolean; weather?: WeatherReport }>)
        .then((j) => alive && j.ok && j.weather && setWeather(j.weather))
        .catch(() => {});
    void load();
    const t = setInterval(load, 15 * 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  if (!weather) {
    return (
      <section className="panel hud" title={SAMPLE_TITLE}>
        <HudFrame cut={14} />
        <PanelHead title="WEATHER /" accent={SAMPLE_WEATHER.city} extra="SAMPLE" idx="01" />
        <div className="weather" data-sample>
          <Icon name="weather" size={44} className="weather__icon" />
          <div className="weather__now">
            <b>{SAMPLE_WEATHER.now}°</b>
            <span>/ {SAMPLE_WEATHER.low}°</span>
          </div>
          <ul className="weather__list">
            {SAMPLE_WEATHER.forecast.map((f) => (
              <li key={f.day}>
                <span>{f.day}</span>
                <span>
                  {f.hi}° / {f.lo}°
                </span>
              </li>
            ))}
          </ul>
        </div>
      </section>
    );
  }

  const today = weather.days[0];
  return (
    <section className="panel hud" title={`${weather.label} ${weather.now}℃（体感 ${weather.feelsLike}℃）`}>
      <HudFrame cut={14} />
      <PanelHead
        title="WEATHER /"
        accent={weather.city.toUpperCase()}
        extra={today ? `${today.label} · ☂${today.rain}%` : weather.label}
        idx="01"
      />
      <div className="weather">
        <Icon name={WEATHER_ICON[weather.kind]} size={44} className="weather__icon" />
        <div className="weather__now">
          <b>{weather.now}°</b>
          {today && <span>/ {today.lo}°</span>}
        </div>
        <ul className="weather__list">
          {weather.days.slice(0, 4).map((d) => (
            <li key={d.date} title={`${d.label} 降水確率 ${d.rain}%`}>
              <span>{dayEn(d.date)}</span>
              <span>
                {d.hi}° / {d.lo}°
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/** 今（1 分ごとに更新）。終わった予定・次の予定の表示に使う */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

const endOf = (e: CalendarEventView) => Date.parse(e.end || e.start);

/** TODAY'S SCHEDULE: Google カレンダーに接続していれば今日の予定、未接続ならサンプル */
function SchedulePanel() {
  const cal = useCalendar();
  const now = useNow();

  if (cal.state !== "connected") {
    const connectable = cal.state === "disconnected";
    return (
      <section className="panel hud" title={connectable ? undefined : SAMPLE_TITLE} data-calendar={cal.state}>
        <HudFrame cut={14} />
        <PanelHead title="TODAY'S" accent="SCHEDULE" extra={connectable ? "NOT LINKED" : "SAMPLE"} idx="02" />
        {connectable ? (
          <div className="schedule-connect">
            <p>{cal.reason ?? "Google カレンダーに接続すると、今日の予定が表示され、会話で予定を追加できます。"}</p>
            <a className="ghost-btn schedule-connect__btn" href="/api/calendar/connect">
              <Icon name="calendar" size={14} /> Google カレンダーに接続
            </a>
          </div>
        ) : (
          <ul className="schedule" data-sample>
            {SAMPLE_SCHEDULE.map((s) => (
              <li key={s.time} data-accent={s.accent || undefined}>
                <i />
                <span className="schedule__time">{s.time}</span>
                <span className="schedule__title">{s.title}</span>
                {s.done && <span className="schedule__done">✓</span>}
              </li>
            ))}
          </ul>
        )}
      </section>
    );
  }

  // 次（または今）の予定を強調し、終わった予定には ✓
  const next = cal.events.find((e) => !e.allDay && endOf(e) > now);
  return (
    <section className="panel hud" data-calendar="connected">
      <HudFrame cut={14} />
      <PanelHead
        title="TODAY'S"
        accent="SCHEDULE"
        idx="02"
        extra={
          <a href="https://calendar.google.com/" target="_blank" rel="noreferrer noopener" title="Google カレンダーを開く">
            GOOGLE ↗
          </a>
        }
      />
      {cal.events.length === 0 ? (
        <p className="schedule-empty">今日の予定はありません</p>
      ) : (
        <ul className="schedule">
          {cal.events.slice(0, 7).map((e) => {
            const done = !e.allDay && endOf(e) <= now;
            return (
              <li
                key={e.id}
                data-accent={e === next || undefined}
                data-done={done || undefined}
                title={`${e.rangeLabel} ${e.title}${e.location ? ` @${e.location}` : ""}`}
              >
                <i />
                <span className="schedule__time">{e.timeLabel}</span>
                <span className="schedule__title">{e.title}</span>
                {done && <span className="schedule__done">✓</span>}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export const RightPanel = memo(function RightPanel() {
  return (
    <aside className="rightbar">
      <p className="quote">
        「明日の君を、もっと好きにさせる。」
        <span>— F.R.I.D.A.Y.</span>
      </p>

      <WeatherPanel />

      <SchedulePanel />

      <section className="panel hud" title={SAMPLE_TITLE}>
        <HudFrame cut={14} />
        <PanelHead title="CURRENT" accent="PROJECTS" extra="VIEW ALL" idx="03" />
        <ul className="projects">
          {SAMPLE_PROJECTS.map((p) => (
            <li key={p.name}>
              <span className="projects__avatar" style={{ background: p.color }}>
                {p.initial}
              </span>
              <span className="projects__body">
                <span className="projects__row">
                  <span>{p.name}</span>
                  <span className="projects__pct">{p.progress}%</span>
                </span>
                <span className="projects__bar">
                  <span style={{ transform: `scaleX(${p.progress / 100})` }} />
                </span>
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="panel hud">
        <HudFrame cut={14} />
        <PanelHead title="QUICK" accent="ACCESS" idx="04" />
        <div className="quick">
          {QUICK_ACCESS.map((q) =>
            "href" in q ? (
              <a key={q.label} className="quick__item" href={q.href} target="_blank" rel="noreferrer noopener">
                <Icon name={q.icon} size={20} />
                <span>{q.label}</span>
              </a>
            ) : (
              <span key={q.label} className="quick__item is-disabled" title="今後対応">
                <Icon name={q.icon} size={20} />
                <span>{q.label}</span>
              </span>
            ),
          )}
        </div>
      </section>

      <div className="motto" aria-hidden="true">
        DREAMS <i>/</i> PLAN <i>/</i> ACTION <i>/</i> REALITY
      </div>
    </aside>
  );
});
