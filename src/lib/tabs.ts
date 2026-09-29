/**
 * F.R.I.D.A.Y. が開いた Web ページ（タブ）の管理。ブラウザの決まりで、閉じられるのは自分で開いたタブだけ。
 * 音声で頼んだときはクリックが無いので、ブラウザにポップアップを止められることがある →
 * そのときは TAB_BLOCKED を知らせ、画面の「開く」ボタンから開いてもらう。
 */

/** ポップアップが止められたときのイベント（detail: { url, label }） */
export const TAB_BLOCKED = "friday:tab-blocked";

const opened: Window[] = [];

export function openTab(url: string, label: string): boolean {
  const win = window.open(url, "_blank");
  if (!win) {
    window.dispatchEvent(new CustomEvent(TAB_BLOCKED, { detail: { url, label } }));
    return false;
  }
  // opener は切らない（切ると「閉じて」で閉じられなくなる）。開く URL はサーバー側で http(s) だけに絞っている
  opened.push(win);
  return true;
}

/** 閉じた数を返す */
export function closeTabs(target: "last" | "all"): number {
  let closed = 0;
  while (opened.length) {
    const win = opened.pop()!;
    if (win.closed) continue;
    win.close();
    closed++;
    if (target === "last") break;
  }
  return closed;
}
