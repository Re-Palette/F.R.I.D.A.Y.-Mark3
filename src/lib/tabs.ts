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

export type ExtReply = { ok?: boolean; closed?: number; version?: number; error?: string; [key: string]: unknown };

/** 拡張機能に頼みごとをして、返事を待つ（返事が無ければ null） */
export function askExtension(message: Record<string, unknown>, timeoutMs: number): Promise<ExtReply | null> {
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

let found = false;

/**
 * 拡張機能が入っているか。拡張機能はページに data-friday-tabs の印を付ける（古い版は印なし → 問い合わせて確かめる）。
 * 見つからなかった結果は覚えない（後から入れても、再読み込みなしで使えるように）。
 */
export async function hasExtension(): Promise<boolean> {
  if (found || typeof document === "undefined") return found;
  if (document.documentElement.dataset.fridayTabs) return (found = true);
  found = Boolean((await askExtension({ type: "ping" }, 500))?.ok);
  return found;
}

/** Amazon Music の操作に必要な拡張機能の版 */
export const MUSIC_EXTENSION_VERSION = "1.2.0";

/** 入っている拡張機能の版（分からなければ undefined） */
export function extensionVersion(): string | undefined {
  return typeof document === "undefined" ? undefined : document.documentElement.dataset.fridayTabs || undefined;
}

/** 版 a が b 以上か（"1.10.0" > "1.2.0" のように数字で比べる） */
export function versionAtLeast(a: string | undefined, b: string): boolean {
  if (!a) return false;
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  }
  return true;
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
