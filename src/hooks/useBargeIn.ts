"use client";

/**
 * 「話している間も聞く（割り込み）」の設定。スピーカーかヘッドホンかで変わるので、端末ごとに覚える。
 */
import { useCallback, useEffect, useState } from "react";

const KEY = "friday.voice.bargeIn";
const EVENT = "friday:barge-in-changed";

function read(): boolean {
  try {
    return localStorage.getItem(KEY) !== "off";
  } catch {
    return true;
  }
}

export function useBargeIn(): [boolean, (on: boolean) => void] {
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
