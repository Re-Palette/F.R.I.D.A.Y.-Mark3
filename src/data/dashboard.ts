/**
 * 右パネル用のサンプルデータ（Phase 1 では表示のみ・未接続）。
 * 将来は Calendar / Weather / Projects 連携に置き換える。
 */
export const SAMPLE_WEATHER = {
  city: "TOKYO",
  now: 21,
  low: 16,
  forecast: [
    { day: "SUN", hi: 23, lo: 18 },
    { day: "MON", hi: 21, lo: 20 },
    { day: "TUE", hi: 20, lo: 18 },
    { day: "WED", hi: 23, lo: 18 },
  ],
};

export const SAMPLE_SCHEDULE = [
  { time: "07:00", title: "起床・朝のルーティン", done: true },
  { time: "09:00", title: "学校" },
  { time: "15:30", title: "Re-Palette ミーティング", accent: true },
  { time: "18:00", title: "NEWTONE 企画書作成", accent: true },
  { time: "20:00", title: "ジム" },
  { time: "22:00", title: "自由時間" },
];

export const SAMPLE_PROJECTS = [
  { initial: "A", name: "ARQO", progress: 68, color: "#2fd6a3" },
  { initial: "R", name: "Re-Palette", progress: 42, color: "#3d8bff" },
  { initial: "N", name: "NEWTONE", progress: 25, color: "#9b6bff" },
  { initial: "U", name: "大学受験", progress: 70, color: "#e0885a" },
];

export const QUICK_ACCESS = [
  { label: "カレンダー", icon: "calendar", href: "https://calendar.google.com" },
  { label: "メモ", icon: "memo" },
  { label: "ファイル", icon: "folder" },
  { label: "リンク", icon: "link" },
  { label: "YouTube", icon: "youtube", href: "https://www.youtube.com" },
  { label: "Instagram", icon: "instagram", href: "https://www.instagram.com" },
  { label: "Gmail", icon: "mail", href: "https://mail.google.com" },
  { label: "Google", icon: "google", href: "https://www.google.com" },
] as const;
