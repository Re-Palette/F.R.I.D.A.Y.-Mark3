/**
 * いまどの AI が受け持っているか（F.R.I.D.A.Y. / K.A.R.E.N.）。画面の切り替えと会話の行き先は、必ずここを見る。
 *   F.R.I.D.A.Y.：ふだんの会話・検索・予定・情報整理・会社の支援・ほかの AI やツールの呼び出し
 *   K.A.R.E.N. ：3D モデル・3D シーン・ホログラム用の見た目・デザイン・アニメーション・モデル編集・レンダリング
 * 会話の履歴・設定・使えるツールは共有する（同じシステムの 2 つの AI）。
 * 切り替えの言葉は AI に聞かずにこの端末で見分ける（速く・オフラインでも・誤って会話として送らないように）。
 */
import { useSyncExternalStore } from "react";
import type { AiMode } from "./ai-words";

export { detectModeCommand, EDITH_NAME_SRC, GLOBAL_PROTOCOL_RE, type AiMode } from "./ai-words";

const KEY = "friday.ai-mode.v1";
let mode: AiMode = "friday";
let loaded = false;
const listeners = new Set<() => void>();

function load() {
  if (loaded || typeof window === "undefined") return;
  loaded = true;
  try {
    // 開き直したときも同じ AI のまま（タブを閉じたら F.R.I.D.A.Y. に戻る）
    const saved = sessionStorage.getItem(KEY);
    if (saved === "karen" || saved === "edith") mode = saved;
  } catch {
    /* noop */
  }
}

export function getAiMode(): AiMode {
  load();
  return mode;
}

export function setAiMode(next: AiMode): void {
  load();
  if (mode === next) return;
  mode = next;
  try {
    sessionStorage.setItem(KEY, next);
  } catch {
    /* noop */
  }
  listeners.forEach((l) => l());
}

export function useAiMode(): AiMode {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    getAiMode,
    () => "friday",
  );
}
