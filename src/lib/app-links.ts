/**
 * パソコンのアプリを開くためのリンク（「Spotify 開いて」など）。
 * アプリが登録している専用のリンク（spotify: など）を開くと、Chrome が「アプリを開きますか？」と確かめてから起動する。
 * 開けるのはこの一覧のアプリだけ（ほかの種類のリンクは開かない）。拡張機能（extension/background.js）にも同じ一覧がある。
 */

export interface AppLink {
  /** 呼び方（画面・声で使う名前） */
  name: string;
  /** アプリを開くリンク */
  url: string;
}

/** 開けるアプリ（専用のリンクを持つもの） */
export const APP_LINKS: AppLink[] = [
  { name: "Spotify", url: "spotify:" },
  { name: "Slack", url: "slack://open" },
  { name: "Discord", url: "discord://" },
  { name: "Zoom", url: "zoommtg://" },
  { name: "Microsoft Teams", url: "msteams:" },
  { name: "Notion", url: "notion://" },
  { name: "LINE", url: "line://" },
  { name: "Obsidian", url: "obsidian://" },
  { name: "Figma", url: "figma://" },
  { name: "VS Code", url: "vscode://" },
  { name: "Windows の設定", url: "ms-settings:" },
];

/** 開いてよいアプリのリンクの種類 */
export const APP_SCHEMES = ["spotify:", "slack:", "discord:", "zoommtg:", "msteams:", "notion:", "line:", "obsidian:", "figma:", "vscode:", "ms-settings:"];

/** アプリのリンクなら整えて返す（一覧に無い種類・長すぎるもの・空白入りは null） */
export function appUrl(raw: string): string | null {
  const text = raw.trim().replace(/^<|>$/g, "");
  if (!text || text.length > 300 || /\s/.test(text)) return null;
  const scheme = text.match(/^([a-z][\w+.-]*:)/i)?.[1]?.toLowerCase();
  if (!scheme || !APP_SCHEMES.includes(scheme)) return null;
  return scheme + text.slice(scheme.length);
}

export function isAppUrl(url: string): boolean {
  return appUrl(url) !== null;
}

/** アプリの名前（一覧にあれば一覧の名前） */
export function appName(url: string): string {
  const scheme = url.match(/^([a-z][\w+.-]*:)/i)?.[1]?.toLowerCase() ?? "";
  return APP_LINKS.find((a) => a.url.toLowerCase().startsWith(scheme))?.name ?? scheme.replace(/:$/, "");
}
