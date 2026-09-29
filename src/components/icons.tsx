/**
 * 線画アイコン（依存ライブラリなし）。stroke は currentColor。
 */
import type { SVGProps } from "react";

const paths = {
  home: <><path d="M3 11l9-7 9 7" /><path d="M5 10v10h5v-6h4v6h5V10" /></>,
  chat: <><path d="M4 5h16v11H9l-5 4z" /><path d="M8 10h.01M12 10h.01M16 10h.01" /></>,
  projects: <><path d="M4 4h10l6 6v10H4z" /><path d="M14 4v6h6" /><path d="M8 15l2 2 4-4" /></>,
  memory: <><circle cx="12" cy="12" r="8" /><path d="M12 8v4l3 2" /><path d="M4 12H2M22 12h-2" /></>,
  tasks: <><circle cx="12" cy="12" r="8" /><path d="M8.5 12l2.5 2.5 4.5-5" /></>,
  calendar: <><rect x="4" y="5" width="16" height="15" rx="2" /><path d="M4 10h16M9 3v4M15 3v4" /><path d="M8 14h2M12 14h2M16 14h.01M8 17h2M12 17h2" /></>,
  files: <><path d="M4 7a2 2 0 012-2h4l2 2h6a2 2 0 012 2v8a2 2 0 01-2 2H6a2 2 0 01-2-2z" /><path d="M9 13l2 2 4-4" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z" /></>,
  search: <><circle cx="11" cy="11" r="6" /><path d="M20 20l-4.5-4.5" /></>,
  doc: <><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v4h4M9 12h6M9 15h6M9 18h4" /></>,
  vault: <><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v4h4" /><path d="M9 11h2v2H9zM13 11h2M9 16h6" /></>,
  automation: <><rect x="4" y="5" width="16" height="15" rx="2" /><path d="M4 10h16M9 3v4M15 3v4" /><circle cx="9" cy="15" r="1" /><circle cx="15" cy="15" r="1" /><path d="M10 15h4" /></>,
  analysis: <><path d="M4 20h16" /><path d="M7 17V11M11 17V7M15 17v-4M19 17V5" /></>,
  share: <><circle cx="17" cy="6" r="2.5" /><circle cx="7" cy="12" r="2.5" /><circle cx="17" cy="18" r="2.5" /><path d="M9.2 10.8l5.6-3.3M9.2 13.2l5.6 3.3" /></>,
  brain: <><path d="M9 4a3 3 0 00-3 3v.5A3 3 0 004 10.5a3 3 0 001 2.2A3 3 0 006 18a3 3 0 003 2h1V4z" /><path d="M15 4a3 3 0 013 3v.5a3 3 0 012 3 3 3 0 01-1 2.2 3 3 0 01-1 5.3 3 3 0 01-3 2h-1V4z" /><path d="M10 9H8M14 9h2M10 14H8M14 14h2" /></>,
  mic: <><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0014 0M12 18v3" /></>,
  wifi: <><path d="M2 8.5a15 15 0 0120 0M5 12a10 10 0 0114 0M8.5 15.5a5 5 0 017 0" /><circle cx="12" cy="19" r="1" /></>,
  chevrons: <><path d="M6 6l6 6-6 6M13 6l6 6-6 6" /></>,
  send: <><path d="M5 12h12M12 6l6 6-6 6" /></>,
  stop: <><rect x="7" y="7" width="10" height="10" rx="1.5" /></>,
  clip: <><path d="M20 12l-7.5 7.5a5 5 0 01-7-7L13 5a3.5 3.5 0 015 5l-7.5 7.5a2 2 0 01-3-3L14 8" /></>,
  image: <><rect x="3" y="5" width="18" height="14" rx="2" /><circle cx="9" cy="10" r="1.5" /><path d="M21 16l-5-5-8 8" /></>,
  plus: <><path d="M12 5v14M5 12h14" /></>,
  pulse: <><path d="M3 12h4l2-5 4 10 2-5h6" /></>,
  chevron: <><path d="M9 6l6 6-6 6" /></>,
  back: <><circle cx="12" cy="12" r="3" /><circle cx="12" cy="12" r="8" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2" /></>,
  retry: <><path d="M4 12a8 8 0 0114-5.3L20 9" /><path d="M20 4v5h-5" /><path d="M20 12a8 8 0 01-14 5.3L4 15" /><path d="M4 20v-5h5" /></>,
  memo: <><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z" /></>,
  folder: <><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" /></>,
  link: <><path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1" /></>,
  youtube: <><rect x="3" y="6" width="18" height="12" rx="3" /><path d="M10 9.5v5l4.5-2.5z" /></>,
  instagram: <><rect x="4" y="4" width="16" height="16" rx="4.5" /><circle cx="12" cy="12" r="3.5" /><path d="M16.5 7.5h.01" /></>,
  mail: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 7l9 6 9-6" /></>,
  google: <><path d="M20 12.2c0-.6 0-1.1-.1-1.7H12v3.3h4.5a4 4 0 01-1.7 2.6" /><path d="M14.8 16.4A6.5 6.5 0 115.5 12 6.5 6.5 0 0116.4 7.6" /></>,
  bell: <><path d="M6 17V11a6 6 0 0112 0v6l1.5 2h-15z" /><path d="M10 21h4" /></>,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" /></>,
  cloud: <><path d="M7 19h10a4 4 0 000-8 5.5 5.5 0 00-10.6 1.8A3.2 3.2 0 007 19z" /></>,
  rain: <><path d="M7 15h10a4 4 0 000-8 5.5 5.5 0 00-10.6 1.8A3.2 3.2 0 007 15z" /><path d="M8 18l-1 2.5M12 18l-1 2.5M16 18l-1 2.5" /></>,
  snow: <><path d="M7 15h10a4 4 0 000-8 5.5 5.5 0 00-10.6 1.8A3.2 3.2 0 007 15z" /><path d="M8 19h.01M12 20h.01M16 19h.01M10 21.5h.01M14 21.5h.01" /></>,
  storm: <><path d="M7 15h10a4 4 0 000-8 5.5 5.5 0 00-10.6 1.8A3.2 3.2 0 007 15z" /><path d="M12.5 15l-2 3.5h3l-2 3.5" /></>,
  fog: <><path d="M4 9h16M6 13h12M4 17h16" /></>,
  weather: <><circle cx="9" cy="8" r="3" /><path d="M9 2v1.5M3 8h1.5M4.8 3.8l1 1M13.2 3.8l-1 1" /><path d="M7 20h10a3.5 3.5 0 000-7 5 5 0 00-9.6 1.5A2.8 2.8 0 007 20z" /></>,
  battery: <><rect x="2" y="7" width="17" height="10" rx="2" /><path d="M22 11v2" /></>,
} as const;

export type IconName = keyof typeof paths;

export function Icon({ name, size = 20, ...rest }: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {paths[name]}
    </svg>
  );
}
