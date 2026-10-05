/**
 * 先回りの声かけ（F.R.I.D.A.Y. のほうから話しかける材料）。
 *   予定      … 始まる 20 分前に「あと 20 分です」。場所の入った予定は、移動時間（既定 45 分）前に「そろそろ出る時間です」と天気・期限も一緒に
 *   ToDo      … 期限が今日のもの（朝 9 時）・明日のもの（夜 7 時）
 *   天気      … 今日の降水確率が高いとき（朝 7 時）「傘を持っていって」
 *   プロジェクト … しばらく動いていないもの（昼 12 時に 1 日 1 回）
 *   振り返り  … 日曜の夜、今週の振り返りができていたら（20 時半）
 * 授業ノートの課題（締め切りつき）は、まとめたときに ToDo に入るので、ToDo の声かけで知らせる。
 * 声かけの文と「いつから・いつまで言ってよいか」を返し、画面が時間になったら話す（同じものは 1 回だけ）。
 * Gemini は使わない（無料枠を使わない・すぐ返せる）。
 */
import type { CalendarEvent } from "@/integrations/google-calendar";
import { departText, isOuting, spokenTime, travelMinutes } from "@/integrations/depart";
import { getTasksOverview, stalledProjects, type Project } from "@/integrations/tasks";
import { getWeather } from "@/integrations/weather";
import { latestWeeklyReview } from "@/integrations/weekly";

export interface Nudge {
  id: string;
  /** この時刻（ミリ秒）から話してよい */
  at: number;
  /** この時刻を過ぎたら話さない（古い知らせになるため） */
  until: number;
  /** 話す文。{left} は画面が話す時点の「あと何分」（eventAt まで）に置き換える */
  text: string;
  /** 予定の始まる時刻 */
  eventAt?: number;
  kind: "calendar" | "todo" | "weather" | "project" | "depart";
}

/** その地域での日付（YYYY-MM-DD） */
const localDate = (tz: string, ms: number) => new Intl.DateTimeFormat("sv-SE", { timeZone: tz }).format(new Date(ms));

/** その地域の「日付 HH:MM」の時刻（ミリ秒） */
export function localTime(date: string, hm: string, tz: string): number {
  const guess = Date.parse(`${date}T${hm}:00Z`);
  const d = new Date(guess);
  const asTz = Date.parse(d.toLocaleString("en-US", { timeZone: tz }));
  const asUtc = Date.parse(d.toLocaleString("en-US", { timeZone: "UTC" }));
  return guess - (asTz - asUtc);
}

const addDays = (date: string, n: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

const MIN = 60_000;
/** 予定の何分前に知らせるか */
const LEAD_MIN = 20;

const list = (items: string[]) => (items.length <= 3 ? items.join("、") : `${items.slice(0, 3).join("、")} ほか ${items.length - 3} 件`);

export async function buildNudges(input: { tz: string; now?: number; events?: CalendarEvent[] | null }): Promise<Nudge[]> {
  const now = input.now ?? Date.now();
  const tz = input.tz;
  const today = localDate(tz, now);
  const out: Nudge[] = [];

  const [{ todos, projects }, weather] = await Promise.all([
    getTasksOverview().catch(() => ({ todos: [] as { text: string; due?: string }[], projects: [] as Project[] })),
    getWeather().catch(() => null),
  ]);
  const day = weather?.days.find((d) => d.date === today);

  // 予定：始まる 20 分前から、始まるまで。出かける予定（場所あり）は、移動時間の前に「そろそろ出る時間」
  for (const ev of input.events ?? []) {
    if (ev.allDay) continue;
    const start = Date.parse(ev.start);
    if (!Number.isFinite(start) || start <= now || start - now > 6 * 60 * MIN) continue;
    if (isOuting(ev)) {
      out.push({
        id: `depart:${ev.id}:${ev.start}`,
        at: start - travelMinutes(ev) * MIN,
        until: start - 5 * MIN,
        eventAt: start,
        text: departText(ev, { rain: day?.rain, snow: day?.label.includes("雪"), dueToday: todos.filter((t) => t.due === today).map((t) => t.text), left: true }),
        kind: "depart",
      });
      continue;
    }
    out.push({
      id: `cal:${ev.id}:${ev.start}`,
      at: start - LEAD_MIN * MIN,
      until: start - 2 * MIN,
      eventAt: start,
      text: `${spokenTime(ev.timeLabel)}から「${ev.title}」です。あと{left}分です。${ev.location ? `場所は${ev.location}です。` : ""}`,
      kind: "calendar",
    });
  }

  // ToDo：期限が今日（朝 9 時から夜まで）・明日（夜 7 時から寝るまで）
  const dueToday = todos.filter((t) => t.due === today).map((t) => t.text);
  const dueTomorrow = todos.filter((t) => t.due === addDays(today, 1)).map((t) => t.text);
  const overdue = todos.filter((t) => t.due && t.due < today).map((t) => t.text);
  if (dueToday.length) {
    out.push({
      id: `todo:today:${today}`,
      at: localTime(today, "09:00", tz),
      until: localTime(today, "23:00", tz),
      text: `今日が期限のものが${dueToday.length}件あります。${list(dueToday)}です。`,
      kind: "todo",
    });
  }
  if (dueTomorrow.length) {
    out.push({
      id: `todo:tomorrow:${today}`,
      at: localTime(today, "19:00", tz),
      until: localTime(today, "23:30", tz),
      text: `明日が締め切りのものがあります。${list(dueTomorrow)}。今日のうちに少し進めておくと楽です。`,
      kind: "todo",
    });
  }
  if (overdue.length) {
    out.push({
      id: `todo:overdue:${today}`,
      at: localTime(today, "10:00", tz),
      until: localTime(today, "22:00", tz),
      text: `期限を過ぎているものが${overdue.length}件残っています。${list(overdue)}。終わっていれば消しておきます。`,
      kind: "todo",
    });
  }

  // プロジェクト：しばらく動いていないものを、昼に 1 日 1 回だけ（いちばん長く止まっているもの）
  const stalled = stalledProjects(projects);
  if (stalled.length) {
    const p = stalled[0];
    const others = stalled.length > 1 ? `ほかに${stalled.slice(1, 3).map((q) => q.name).join("と")}も止まっています。` : "";
    out.push({
      id: `stall:${today}`,
      at: localTime(today, "12:00", tz),
      until: localTime(today, "21:00", tz),
      text: `${p.name}が${p.idleDays}日動いていません。${p.next ? `次は「${p.next}」からですね。` : "次の一手を決めておきましょうか。"}${others}`,
      kind: "project",
    });
  }

  // 週の振り返り：日曜の夜、今週の分ができていたら（自動で作られるのは 20 時すぎ）
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(new Date(now));
  if (weekday === "Sun" && now >= localTime(today, "20:00", tz)) {
    const weekly = await latestWeeklyReview().catch(() => null);
    if (weekly?.path.endsWith(`${today}.md`)) {
      out.push({
        id: `weekly:${today}`,
        at: localTime(today, "20:30", tz),
        until: localTime(today, "23:30", tz),
        text: "今週の振り返りができています。「振り返り聞かせて」と言ってもらえれば、要点を話します。",
        kind: "project",
      });
    }
  }

  // 天気：今日の降水確率が 50% 以上なら、朝のうちに
  if (day && day.rain >= 50) {
    out.push({
      id: `rain:${today}`,
      at: localTime(today, "06:30", tz),
      until: localTime(today, "14:00", tz),
      text: `今日は${day.label.includes("雪") ? "雪" : "雨"}の予報です。降水確率${day.rain}%なので、傘を持って出てください。`,
      kind: "weather",
    });
  }
  return out.filter((n) => n.until > now).sort((a, b) => a.at - b.at);
}
