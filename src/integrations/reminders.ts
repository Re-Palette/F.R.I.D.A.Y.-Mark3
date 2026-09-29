/**
 * リマインダー（脳の「FRIDAY/リマインダー.md」に保存）。
 *
 *   - [ ] 2026-09-29 18:00 ジムに行く
 *
 * 時間になったら、開いている F.R.I.D.A.Y. の画面が声と通知で知らせ、[x] にする。
 * 脳に置くので、パソコンでもスマホでも同じリマインダーが見える。
 */
import { createHash } from "node:crypto";
import { getTimezone } from "@/lib/config";
import { invalidate, swr } from "@/lib/swr";
import { labelLocal, parseLocal, toLocal } from "@/lib/time";
import { BRAIN_DIR, isBrainConfigured, listNotes, readNote, updateNote } from "@/memory/github-brain";

export const REMINDER_PATH = `${BRAIN_DIR}/リマインダー.md`;
const CACHE_KEY = "reminders";
const LINE = /^(\s*[-*]\s+\[)([ xX])(\]\s+)(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})\s+(.+)$/;

export interface Reminder {
  id: string;
  /** その地域の "2026-09-29T18:00" */
  local: string;
  /** ミリ秒（時刻比較用） */
  at: number;
  label: string;
  text: string;
  done: boolean;
}

const idOf = (local: string, text: string) => createHash("sha1").update(`${local}|${text}`).digest("hex").slice(0, 12);

function parse(text: string, tz: string): Reminder[] {
  const out: Reminder[] = [];
  for (const line of text.split("\n")) {
    const m = LINE.exec(line);
    if (!m) continue;
    const local = `${m[4]}T${m[5]}`;
    const at = parseLocal(local, tz);
    if (Number.isNaN(at.getTime())) continue;
    out.push({ id: idOf(local, m[6].trim()), local, at: at.getTime(), label: labelLocal(at, tz), text: m[6].trim(), done: m[2] !== " " });
  }
  return out.sort((a, b) => a.at - b.at);
}

async function load(): Promise<Reminder[]> {
  const file = (await listNotes()).find((f) => f.path === REMINDER_PATH);
  return file ? parse(await readNote(file), getTimezone()) : [];
}

/** 未完了のリマインダー（15 秒以内は前回の結果） */
export async function listReminders(): Promise<Reminder[]> {
  if (!isBrainConfigured()) return [];
  const all = await swr(CACHE_KEY, 15_000, 10 * 60_000, load);
  return all.filter((r) => !r.done);
}

async function afterWrite(): Promise<void> {
  invalidate(CACHE_KEY);
  await listNotes(true).catch(() => {});
}

const LOCAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/** リマインダーを追加する（at はその地域の "YYYY-MM-DDTHH:MM"） */
export async function addReminder(input: { at?: unknown; text?: unknown }): Promise<Reminder> {
  if (!isBrainConfigured()) throw new Error("脳（Obsidian）が接続されていないため保存できません。");
  const tz = getTimezone();
  const text = String(input.text ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
  const raw = String(input.at ?? "").trim();
  if (!text) throw new Error("何を知らせるのか分かりませんでした。");
  if (!LOCAL.test(raw)) throw new Error("知らせる時刻が分かりませんでした。");
  const at = parseLocal(raw.slice(0, 16), tz);
  if (Number.isNaN(at.getTime())) throw new Error("知らせる時刻が分かりませんでした。");
  if (at.getTime() < Date.now() - 60_000) throw new Error("その時刻はもう過ぎています。");
  const local = toLocal(at, tz);
  await updateNote(
    REMINDER_PATH,
    (current) =>
      `${(current ?? "# リマインダー\n\nF.R.I.D.A.Y. が時間になったら声と通知で知らせます。知らせたものは [x] になります。\n").trimEnd()}\n- [ ] ${local.replace("T", " ")} ${text}\n`,
    `F.R.I.D.A.Y.: リマインダーを追加（${local.replace("T", " ")}）`,
  );
  await afterWrite();
  return { id: idOf(local, text), local, at: at.getTime(), label: labelLocal(at, tz), text, done: false };
}

/** 知らせたリマインダーを [x] にする */
export async function markReminderDone(id: string): Promise<boolean> {
  let changed = false;
  await updateNote(
    REMINDER_PATH,
    (current) =>
      (current ?? "")
        .split("\n")
        .map((l) => {
          const m = LINE.exec(l);
          if (!m || changed || m[2] !== " " || idOf(`${m[4]}T${m[5]}`, m[6].trim()) !== id) return l;
          changed = true;
          return `${m[1]}x${m[3]}${m[4]} ${m[5]} ${m[6]}`;
        })
        .join("\n"),
    "F.R.I.D.A.Y.: リマインダーを通知済みに",
  );
  if (changed) await afterWrite();
  return changed;
}
