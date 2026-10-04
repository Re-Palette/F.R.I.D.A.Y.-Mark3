"use client";

import { useEffect, useState } from "react";

/** メディアクエリに当てはまるか（最初の描画では false） */
export function useMedia(query: string): boolean {
  const [match, setMatch] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const update = () => setMatch(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, [query]);
  return match;
}

/** スマホ幅（HOME をスクロールなしの 1 画面にする幅） */
export const PHONE_QUERY = "(max-width: 720px)";
