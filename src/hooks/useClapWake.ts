"use client";

/**
 * 「拍手 2 回で起動」の設定。部屋の音の環境で変わるので、端末ごとに覚える（既定はオン）。
 */
import { useCallback, useEffect, useState } from "react";

const KEY = "friday.voice.clap";
const EVENT = "friday:clap-changed";

function read(): boolean {
  try {
    return localStorage.getItem(KEY) !== "off";
  } catch {
    return true;
  }
}

export function useClapWake(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(true);
  useEffect(() => {
    setOn(read());
    const sync = () => setOn(read());
    window.addEventListener(EVENT, sync);
    return () => window.removeEventListener(EVENT, sync);
  }, []);
  const update = useCallback((value: boolean) => {
    try {
      localStorage.setItem(KEY, value ? "on" : "off");
    } catch {
      /* 保存できない環境ではこの画面の間だけ */
    }
    setOn(value);
    window.dispatchEvent(new Event(EVENT));
  }, []);
  return [on, update];
}
