/**
 * Chat Agent — 会話担当（Gemini Flash 系）。
 * 自然な日常会話・相談・雑談を低コスト・高速に処理する。
 */
import type { Agent, AgentContext, AgentOutputChunk } from "@/agents/types";
import { asksForSns, asksForTrend, needsSearch } from "@/agents/search/needs-search";
import { getWeather, type WeatherReport } from "@/integrations/weather";
import { readNewsSettings } from "@/integrations/news";
import { asksForMail, asksForMailDraft } from "@/integrations/gmail";
import {
  asksForCompany,
  companyBrief,
  companyConnected,
  type CompanyBrief,
} from "@/integrations/company";
import { asksForMusic } from "@/lib/music";
import { quizMaterial, recentLectures, recentWeakPoints, type LectureDigest } from "@/integrations/brain-notes";
import { inQuiz } from "./quiz";
import { asksForMorning } from "./morning";
import { listReminders, type Reminder } from "@/integrations/reminders";
import { getTasksOverview, type TasksOverview } from "@/integrations/tasks";
import { peekAppSettings } from "@/integrations/settings";
import { asksForDiary, asksForReview, formatMaterial, gatherReview } from "@/integrations/review";
import { latestWeeklyReview } from "@/integrations/weekly";
import { getGeminiConfig, getSearchMode, settingsHint } from "@/lib/config";
import { streamGemini, type GeminiContent } from "@/llm/gemini";
import type { CalendarEvent } from "@/integrations/google-calendar";
import type { MemoryRecord } from "@/memory/long-term";
import { buildSystemInstruction, type MailData, type MusicContext } from "./persona";

/**
 * 脳・カレンダー・天気を集めるのに待てる時間。間に合わなければ無しで返答する（返答の速さ優先）。
 * どれも前回の結果をキャッシュから即座に返すので、普段はほぼ待たない（上限は初回や障害時の保険）。
 */
const CONTEXT_BUDGET_MS = { text: 900, voice: 450 };

/** 振り返り・日記の材料集めに待てる時間（頼まれたときだけなので長め） */
const REVIEW_BUDGET_MS = 3000;

/** この長さ未満の普通の発言は、Gemini に考えさせる量を最小にして最初の一言を速くする */
const QUICK_REPLY_CHARS = 120;

/** 時間内に終わらなければ fallback を返す（失敗も fallback） */
async function within<T>(task: Promise<T>, ms: number, fallback: T, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  const safe = task.catch((err) => {
    console.warn(`[friday] ${label} failed:`, err instanceof Error ? err.message : err);
    return fallback;
  });
  try {
    return await Promise.race([safe, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export const chatAgent: Agent = {
  id: "chat",

  describe() {
    const config = getGeminiConfig();
    return config.apiKey
      ? { model: config.model, ready: true }
      : { model: config.model, ready: false, reason: `Gemini API キーが設定されていません。${settingsHint("GEMINI_API_KEY")}` };
  },

  async *run(ctx: AgentContext): AsyncIterable<AgentOutputChunk> {
    const config = getGeminiConfig();
    const latest = ctx.messages[ctx.messages.length - 1]?.content ?? "";

    // 長期記憶（Obsidian の脳）・予定（Google カレンダー）・天気を同時に集める。時間切れなら無しで返答
    yield { text: "", stage: "connect" };
    const prepStart = Date.now();
    const budget = ctx.voice ? CONTEXT_BUDGET_MS.voice : CONTEXT_BUDGET_MS.text;
    const briefing = Boolean(ctx.news?.deliver);
    // メールは頼まれたとき・朝のあいさつ・ニュースのまとめのときだけ読む。
    // 返信・メールの下書きを頼まれたら、直近のメールを本文つきで読み、下書きを作れるかも確かめる
    const drafting = Boolean(ctx.mailRecent) && asksForMailDraft(latest);
    const wantsMail = drafting || (Boolean(ctx.mail) && (asksForMail(latest) || briefing || asksForMorning(latest)));
    const mailTask: Promise<MailData> = wantsMail
      ? (drafting ? ctx.mailRecent! : ctx.mail!)().then(
          (list) => ({ list }),
          (err: unknown) => ({ error: err instanceof Error ? err.message : "メールを読めませんでした。" }),
        )
      : Promise.resolve(null);
    // 振り返り（1 週間）・日記（今日）を頼まれたら、会話ログ・ToDo・予定などの材料を集める（少し長めに待つ）
    let reviewKind: "week" | "day" | "week-saved" | null = !ctx.memory.connected ? null : asksForReview(latest) ? "week" : asksForDiary(latest) ? "day" : null;
    // 今週の振り返りが保存してあれば（日曜の夜に自動で作ったもの）、作り直さずにそれを話す。「作り直して」「作って」なら新しく作る
    const saved =
      reviewKind === "week" && !/作り直|作って|書いて|新しく|もう一度|更新/.test(latest)
        ? await within(latestWeeklyReview(), budget, null, "weekly")
        : null;
    if (saved) reviewKind = "week-saved";
    const reviewTask: Promise<string | null> = saved
      ? Promise.resolve(saved.text)
      : reviewKind
        ? within(
            gatherReview(ctx.timezone, reviewKind === "week" ? 7 : 1, ctx.calendar).then(formatMaterial),
            REVIEW_BUDGET_MS,
            null,
            "review",
          )
        : Promise.resolve(null);
    // 朝のブリーフィング（「おはよう」「今日のことまとめて」）：予定・天気・ToDo に加えて、最近の授業の復習ポイントも集める
    const morning = asksForMorning(latest);
    const lectureTask: Promise<LectureDigest[]> =
      morning && ctx.memory.connected ? within(recentLectures(ctx.timezone, 2, 3), budget, [] as LectureDigest[], "lectures") : Promise.resolve([]);
    // クイズ（頼まれたとき・答えている途中）：授業ノートと、前回までの苦手なところを集める
    const quizAsk = inQuiz(ctx.messages);
    const quizTask: Promise<{ subject: string | null; notes: LectureDigest[]; weak: string[] } | null> = quizAsk
      ? within(
          Promise.all([quizMaterial(quizAsk), recentWeakPoints().catch(() => [])]).then(([m, weak]) => ({ ...m, weak })),
          budget + 800,
          { subject: null, notes: [], weak: [] },
          "quiz",
        )
      : Promise.resolve(null);
    // 音楽の話のときだけ、いま流れている曲を Spotify に聞く（接続済みのとき）
    const musicTalk = asksForMusic(latest);
    // Spotify に接続していれば Spotify、していなければ Amazon Music（画面の拡張機能が操作する）
    const musicTask: Promise<MusicContext> = !musicTalk
      ? Promise.resolve(null)
      : ctx.spotify
        ? ctx.spotify.nowPlaying().then(
            (now) => ({ kind: "spotify" as const, now }),
            (err: unknown) => ({ kind: "spotify" as const, error: err instanceof Error ? err.message : "Spotify に接続できませんでした。" }),
          )
        : Promise.resolve({ kind: "amazon" as const, ext: Boolean(ctx.amazon?.ext), now: ctx.amazon?.now ?? null });
    const canDraftTask: Promise<boolean | undefined> =
      wantsMail && ctx.mailCanDraft ? ctx.mailCanDraft().catch(() => false) : Promise.resolve(undefined);
    // AI 会社（ARQO）の状況。会社の話をしているとき・朝のまとめのときだけ集める
    const wantsCompany = companyConnected() && (asksForCompany(latest) || morning);
    const companyTask: Promise<CompanyBrief | null> = wantsCompany
      ? companyBrief(ctx.signal).catch((err: unknown) => ({
          text: `AI 会社の状況を取れなかった: ${err instanceof Error ? err.message : "不明"}`,
          needsCeo: 0,
        }))
      : Promise.resolve(null);

    const [memories, events, weather, newsSettings, tasks, reminders, mail, reviewMaterial, mailCanDraft, music, lectures, quiz, company] = await Promise.all([
      ctx.memory.connected ? within(ctx.memory.recall(latest, ctx.messages), budget, [] as MemoryRecord[], "recall") : [],
      ctx.calendar ? within<CalendarEvent[] | null>(ctx.calendar.upcoming(7), budget, null, "calendar") : null,
      within<WeatherReport | null>(getWeather(), budget, null, "weather"),
      // ニュースをまとめるときだけ、興味のある分野を最新の設定で
      ctx.news && briefing ? within(readNewsSettings(), budget, ctx.news.settings, "news") : ctx.news?.settings,
      ctx.memory.connected ? within<TasksOverview | null>(getTasksOverview(), budget, null, "tasks") : null,
      ctx.memory.connected ? within<Reminder[] | null>(listReminders(), budget, null, "reminders") : null,
      within<MailData>(mailTask, budget + 600, wantsMail ? { error: "メールの読み込みが間に合いませんでした。" } : null, "mail"),
      reviewTask,
      within<boolean | undefined>(canDraftTask, budget + 600, undefined, "mail-draft"),
      within<MusicContext>(musicTask, budget + 600, musicTalk && ctx.spotify ? { kind: "spotify", error: "Spotify の応答が間に合いませんでした。" } : null, "music"),
      lectureTask,
      quizTask,
      within<CompanyBrief | null>(companyTask, budget + 600, wantsCompany ? { text: "AI 会社の応答が間に合わなかった。", needsCeo: 0 } : null, "company"),
    ]);
    const prepMs = Date.now() - prepStart;
    const news = ctx.news && newsSettings ? { ...ctx.news, settings: newsSettings } : ctx.news;

    // Web 検索: 最新情報が必要そうな発言だけ（無料枠の回数を節約）
    const settings = peekAppSettings();
    const mode = settings.search ?? getSearchMode();
    // ニュースをまとめるときは検索する（FRIDAY_SEARCH=off のときだけは検索しない）
    const sns = asksForSns(latest);
    // カメラの映像を見せたときは、画像から答える（「調べて」と言われたときだけ検索する）
    // 添えたファイルを読んで答えるときも同じ（中身はファイルにあるので、検索しない）
    const reading = ctx.messages.some((m) => m.files?.length);
    const looking = Boolean(ctx.messages[ctx.messages.length - 1]?.image) || Boolean(ctx.messages[ctx.messages.length - 1]?.files?.length);
    const search =
      mode !== "off" &&
      (mode === "always" || briefing || (looking ? /調べ|検索|ググ/.test(latest) : needsSearch(latest) || asksForTrend(latest)));

    yield { text: "", stage: search ? "search" : "think" };

    // カメラの映像（最新の発言にだけ付く）は、文字の前に画像として渡す
    const camera = Boolean(ctx.messages[ctx.messages.length - 1]?.image);
    const contents: GeminiContent[] = ctx.messages.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [
        // 添えたファイル（画像・PDF はそのまま、取り出した文字は区切りを付けて）
        ...(m.files ?? []).map((f) =>
          f.data
            ? { inlineData: { mimeType: f.mimeType, data: f.data } }
            : { text: `【添付ファイル「${f.name}」の中身ここから】\n${f.text ?? ""}\n【添付ファイル「${f.name}」ここまで】` },
        ),
        ...(m.image ? [{ inlineData: { mimeType: m.image.mimeType, data: m.image.data } }] : []),
        { text: m.files?.length ? `（添付：${[...new Set(m.files.map((f) => f.name.replace(/（\d+ ページ）$/, "")))].join("、")}）\n${m.content}` : m.content },
      ],
    }));

    // 音声会話は「最初の一言の速さ」優先: 考える量を最小にし、返答も短く
    // ニュースのまとめは長くなるので上限を広げる
    // 短い普通の発言（検索・まとめ以外）も考える量を最小にする（最初の一言が速くなる）
    const quick = !search && !briefing && !morning && !quiz && !reviewKind && !sns && !drafting && !reading && latest.length < QUICK_REPLY_CHARS;
    const runConfig = ctx.voice
      ? {
          ...config,
          thinkingLevel: "minimal" as const,
          // 文書・振り返りは本文を隠しタグに書くので長く、読み上げは短い
          maxOutputTokens: briefing ? 1200 : reviewKind || sns || drafting || /企画書|レポート|報告書|文書|原稿|下書き/.test(latest) ? 5000 : Math.min(config.maxOutputTokens, 400),
        }
      : briefing || reviewKind || sns || drafting || reading || /企画書|レポート|報告書|文書|原稿|下書き|書いて|作成して/.test(latest)
        ? { ...config, maxOutputTokens: Math.max(config.maxOutputTokens, 6000) }
        : quick
          ? { ...config, thinkingLevel: "minimal" as const }
          : config;

    let first = true;
    for await (const chunk of streamGemini({
      config: runConfig,
      systemInstruction: buildSystemInstruction({
        now: ctx.now,
        timezone: ctx.timezone,
        memories,
        memoryConnected: ctx.memory.connected,
        calendar: ctx.calendar ? { connected: true, events } : { connected: false },
        weather,
        search,
        news,
        tasks,
        reminders,
        mail,
        mailDraft: mailCanDraft,
        music,
        camera,
        files: reading,
        morning: morning ? { lectures } : null,
        quiz,
        focus: /集中|ポモドーロ|タイマー|フォーカス|勉強(を)?(始め|はじめ|する)|作業(を)?(始め|はじめ)/.test(latest),
        fileNote: Boolean(ctx.messages[ctx.messages.length - 1]?.attached?.length) && ctx.memory.connected,
        review: reviewKind && { kind: reviewKind, material: reviewMaterial },
        replyLength: settings.replyLength,
        sns,
        company,
        companyConnected: companyConnected(),
        voice: ctx.voice,
      }),
      contents,
      signal: ctx.signal,
      googleSearch: search,
    })) {
      // 準備（脳・カレンダー・天気）にかかった時間を最初の塊で知らせる（画面に表示して遅さの原因を見分ける）
      yield first ? { ...chunk, prepMs } : chunk;
      first = false;
    }
  },
};
