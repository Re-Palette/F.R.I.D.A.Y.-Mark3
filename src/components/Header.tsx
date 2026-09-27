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
      <div className="brand">
        <svg className="brand__mark" viewBox="0 0 40 40" aria-hidden="true">
          <path d="M20 2 38 20 20 38 2 20Z" fill="none" stroke="#ff8a1f" strokeWidth="2.5" />
          <path d="M20 10 30 20 20 30 10 20Z" fill="#ff8a1f" />
          <path d="M20 15 25 20 20 25 15 20Z" fill="#07090d" />
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
