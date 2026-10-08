/**
 * 隠しタグ（Tool）の名前。サーバーの FRIDAY Core と、オフライン時に画面で動く Offline Core の両方が同じ名前を使う。
 * （各 *-actions.ts はサーバー専用の処理を含むので、名前だけをここに分けてある）
 */
export const BRAIN_TAGS = ["todo-add", "todo-done", "project-progress", "reminder"] as const;
export const BROWSER_TAGS = ["open-url", "close-tab"] as const;
export const CALENDAR_TAGS = ["calendar", "calendar-update", "calendar-delete"] as const;
export const COMPANY_TAGS = ["company-instruct", "company-advance"] as const;
export const GMAIL_TAGS = ["gmail-draft"] as const;
export const MUSIC_TAGS = ["music"] as const;

/** Core が返答から取り出すすべての隠しタグ */
export const CORE_TAGS = ["memory", "news-settings", "document", "slides", "file-note", "focus", "quiz-result", ...CALENDAR_TAGS, ...BRAIN_TAGS, ...BROWSER_TAGS, "hologram", ...GMAIL_TAGS, ...MUSIC_TAGS, ...COMPANY_TAGS] as const;
/** 長い中身を持てるタグの上限（文字数） */
export const CORE_TAG_LIMITS = { document: 30_000, slides: 30_000, "gmail-draft": 8000, "file-note": 6000 };
