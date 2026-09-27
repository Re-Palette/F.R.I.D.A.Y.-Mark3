"use client";

import { useEffect, useState } from "react";
import { Icon } from "./icons";

interface BatteryLike {
  level: number;
  charging: boolean;
  addEventListener: (t: string, f: () => void) => void;
  removeEventListener: (t: string, f: () => void) => void;
}

function useClock() {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

function useDeviceStatus() {
  const [online, setOnline] = useState(true);
  const [battery, setBattery] = useState<number | null>(null);

  useEffect(() => {
    setOnline(navigator.onLine);
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);

    let bat: BatteryLike | undefined;
    const update = () => bat && setBattery(Math.round(bat.level * 100));
    const nav = navigator as Navigator & { getBattery?: () => Promise<BatteryLike> };
    nav
      .getBattery?.()
      .then((b) => {
        bat = b;
        update();
        b.addEventListener("levelchange", update);
      })
      .catch(() => {});

    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
      bat?.removeEventListener("levelchange", update);
    };
  }, []);

  return { online, battery };
}

const pad = (n: number) => String(n).padStart(2, "0");
const DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

export function Header() {
  const now = useClock();
  const { online, battery } = useDeviceStatus();

  return (
    <header className="topbar">
      <svg className="topbar__frame" viewBox="0 0 1000 72" preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <linearGradient id="frameGrad" x1="0" x2="1">
            <stop offset="0" stopColor="#ff8a1f" stopOpacity="0.1" />
            <stop offset="0.3" stopColor="#ff8a1f" stopOpacity="0.9" />
            <stop offset="0.7" stopColor="#ff8a1f" stopOpacity="0.55" />
            <stop offset="1" stopColor="#ff8a1f" stopOpacity="0.15" />
          </linearGradient>
        </defs>
        <path d="M0 70 H345 L365 58 H700 L716 70 H1000" fill="none" stroke="url(#frameGrad)" strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
        <path d="M365 58 H700" fill="none" stroke="#ffb458" strokeWidth="2" strokeOpacity="0.5" vectorEffect="non-scaling-stroke" className="topbar__frame-hi" />
      </svg>
      <div className="brand">
        <svg className="brand__mark" viewBox="0 0 40 40" aria-hidden="true">
          <defs>
            <linearGradient id="brandGrad" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#ffc46e" />
              <stop offset="1" stopColor="#ff6a00" />
            </linearGradient>
          </defs>
          <path d="M20 1 39 20 20 39 1 20Z" fill="url(#brandGrad)" />
          <path d="M20 8 32 20 20 32 8 20Z" fill="#0a0806" />
          <path d="M20 13 27 20 20 27 13 20Z" fill="url(#brandGrad)" />
        </svg>
        <span className="brand__name">F.R.I.D.A.Y.</span>
        <span className="brand__mk">Mark3</span>
        <span className="brand__sub">AI ASSISTANT SYSTEM</span>
      </div>

      <div className="topbar__right">
        <div className="clock" suppressHydrationWarning>
          <span className="clock__date">
            {now ? `${now.getFullYear()}.${pad(now.getMonth() + 1)}.${pad(now.getDate())}  ${DAYS[now.getDay()]}` : "—"}
          </span>
          <span className="clock__time">
            {now ? `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}` : "--:--:--"}
          </span>
        </div>
        <div className="sys-icons">
          <span title="音声（今後対応）">
            <Icon name="mic" size={20} />
          </span>
          <span className={online ? "" : "is-off"} title={online ? "ONLINE" : "OFFLINE"}>
            <Icon name="wifi" size={20} />
          </span>
          {battery !== null && (
            <span className="battery" title="バッテリー">
              <span className="battery__shell">
                <span className="battery__fill" style={{ width: `${battery}%` }} />
              </span>
              {battery}%
            </span>
          )}
        </div>
      </div>
    </header>
  );
}
