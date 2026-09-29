/**
 * F.R.I.D.A.Y. が開く Web ページ（タブ）の管理。
 *
 * - 拡張機能「F.R.I.D.A.Y. Tabs」（extension/）が入っていれば、それに頼んで開く・閉じる。
 *   ポップアップも止められず、YouTube や Google のようなページも閉じられる。
 * - 入っていなければ window.open で開く。ただしブラウザの決まりで、
 *   ・クリックの無い依頼（音声など）はポップアップとして止められることがある → TAB_BLOCKED で「開く」ボタンを出す
 *   ・YouTube・Google など安全のため開いた側とのつながりを切るページは、あとから閉じられない
 */

/** ポップアップが止められたときのイベント（detail: { url, label }） */
export const TAB_BLOCKED = "friday:tab-blocked";

/** 画面に出すお知らせ（止められたページ、または閉じられなかった理由） */
export interface TabNotice {
  url?: string;
  label?: string;
  reason?: string;
}

export interface CloseResult {
  closed: number;
  /** 閉じられなかった理由（拡張機能なしで、つながりが切れたページなど） */
  reason?: string;
}

const opened: Window[] = [];
/** 拡張機能を使わずに開いて、閉じられなくなったタブの数 */
let lost = 0;

type ExtReply = { ok?: boolean; closed?: number; version?: number; error?: string };

function askExtension(message: Record<string, unknown>, timeoutMs: number): Promise<ExtReply | null> {
  if (typeof window === "undefined") return Promise.resolve(null);
  const id = Math.random().toString(36).slice(2);
  return new Promise((resolve) => {
    const done = (value: ExtReply | null) => {
      window.removeEventListener("message", onMessage);
      clearTimeout(timer);
      resolve(value);
    };
    const onMessage = (e: MessageEvent) => {
      const d = e.data as { source?: string; id?: string } & ExtReply;
      if (e.source === window && d?.source === "friday-ext" && d.id === id) done(d);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    window.addEventListener("message", onMessage);
    window.postMessage({ source: "friday", id, ...message }, location.origin);
  });
}

let extension: Promise<boolean> | null = null;

/** 拡張機能が入っているか（一度調べたら覚えておく） */
export function hasExtension(): Promise<boolean> {
  extension ??= askExtension({ type: "ping" }, 600).then((r) => Boolean(r?.ok));
  return extension;
}

/** 開けたら true（拡張機能なしでポップアップが止められたら false） */
export async function openTab(url: string, label: string): Promise<boolean> {
  if (await hasExtension()) {
    const r = await askExtension({ type: "open", url }, 3000);
    if (r?.ok) return true;
  }
  const win = window.open(url, "_blank");
  if (!win) {
    window.dispatchEvent(new CustomEvent(TAB_BLOCKED, { detail: { url, label } }));
    return false;
  }
  opened.push(win);
  return true;
}

/** クリックの中で開く（ポップアップとして止められない）。あとで「閉じて」で閉じられるよう覚えておく */
export function openTabNow(url: string): void {
  const win = window.open(url, "_blank");
  if (win) opened.push(win);
}

export async function closeTabs(target: "last" | "all"): Promise<CloseResult> {
  let closed = 0;
  if (await hasExtension()) {
    const r = await askExtension({ type: "close", target }, 3000);
    closed = r?.closed ?? 0;
    if (closed && target === "last") return { closed };
  }
  while (opened.length) {
    const win = opened.pop()!;
    // closed なのに自分では閉じていない＝ページ側がつながりを切った（または自分で閉じられた）
    if (win.closed) {
      lost++;
      continue;
    }
    win.close();
    closed++;
    if (target === "last") break;
  }
  if (closed) return { closed };
  if (lost && !(await hasExtension())) {
    lost = 0;
    return { closed: 0, reason: "YouTube や Google などのページは、ブラウザの安全の決まりで F.R.I.D.A.Y. からは閉じられません（拡張機能を入れると閉じられます）。" };
  }
  return { closed: 0 };
}
