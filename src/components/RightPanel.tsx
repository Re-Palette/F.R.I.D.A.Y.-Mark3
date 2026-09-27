import { QUICK_ACCESS, SAMPLE_PROJECTS, SAMPLE_SCHEDULE, SAMPLE_WEATHER } from "@/data/dashboard";
import { HudFrame } from "./HudFrame";
import { Icon } from "./icons";

function PanelHead({ title, accent, extra, idx }: { title: string; accent?: string; extra?: string; idx: string }) {
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

export function RightPanel() {
  return (
    <aside className="rightbar">
      <p className="quote">
        「明日の君を、もっと好きにさせる。」
        <span>— F.R.I.D.A.Y.</span>
      </p>

      <section className="panel hud" title={SAMPLE_TITLE}>
        <HudFrame cut={14} />
        <PanelHead title="WEATHER /" accent={SAMPLE_WEATHER.city} idx="01" />
        <div className="weather">
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

      <section className="panel hud" title={SAMPLE_TITLE}>
        <HudFrame cut={14} />
        <PanelHead title="TODAY'S" accent="SCHEDULE" extra="VIEW ALL" idx="02" />
        <ul className="schedule">
          {SAMPLE_SCHEDULE.map((s) => (
            <li key={s.time} data-accent={s.accent || undefined}>
              <i />
              <span className="schedule__time">{s.time}</span>
              <span className="schedule__title">{s.title}</span>
              {s.done && <span className="schedule__done">✓</span>}
            </li>
          ))}
        </ul>
      </section>

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
}
