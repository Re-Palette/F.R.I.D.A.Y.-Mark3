"use client";

/**
 * サイドバーの各画面（PROJECTS / TASKS / CALENDAR / MEMORY / FILES）。
 * どれも脳（Obsidian）や Google カレンダーの内容を、その場で見て・直せるようにする。
 */
import { memo, useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import type { CalendarEventView, CalendarResponse } from "@/core/types";
import { CALENDAR_CHANGED, TASKS_CHANGED } from "@/hooks/useChat";
import { REMINDERS_CHANGED } from "@/hooks/useReminders";
import { HudFrame } from "./HudFrame";
import { Icon } from "./icons";
import { Markdown } from "./Markdown";

/* ---------- 共通 ---------- */

interface Task {
  text: string;
  done: boolean;
  due?: string;
  project?: string;
  path: string;
}

interface Project {
  name: string;
  progress: number;
  open: number;
  done: number;
  next?: string;
  status?: string;
  color: string;
  initial: string;
}

interface Overview {
  configured?: boolean;
  projects: Project[];
  todos: Task[];
  done: Task[];
  error?: string;
}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { cache: "no-store", ...init, headers: { "Content-Type": "application/json", ...init?.headers } });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `エラー（${res.status}）`);
  return json;
}

export function Page({ title, sub, hidden, message, children }: { title: string; sub: string; hidden: boolean; message?: Msg; children: ReactNode }) {
  return (
    <section className="settings page" data-active={!hidden || undefined} aria-hidden={hidden} inert={hidden} aria-label={title}>
      <header className="settings__bar">
        <div>
          <div className="settings__title">{title}</div>
          <div className="settings__sub">{sub}</div>
        </div>
        {message && (
          <p className="settings__msg" data-ok={message.ok || undefined} role="status">
            {message.text}
          </p>
        )}
      </header>
      <div className="settings__grid">{children}</div>
    </section>
  );
}

export function Card({ title, sub, wide, children }: { title: string; sub?: string; wide?: boolean; children: ReactNode }) {
  return (
    <section className="settings__section hud" data-wide={wide || undefined}>
      <HudFrame cut={14} small={6} ticks={false} />
      <h2>
        {title}
        {sub && <span>{sub}</span>}
      </h2>
      {children}
    </section>
  );
}

export type Msg = { ok: boolean; text: string } | undefined;

/** 画面を開いている間の読み込み・再読み込み（イベントでも読み直す） */
function useLoad<T>(hidden: boolean, url: string, events: string[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [message, setMessage] = useState<Msg>();
  const load = useCallback(async () => {
    try {
      setData(await call<T>(url));
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : "読み込めませんでした。" });
    }
  }, [url]);
  useEffect(() => {
    if (hidden) return;
    void load();
    for (const e of events) window.addEventListener(e, load);
    return () => {
      for (const e of events) window.removeEventListener(e, load);
    };
  }, [hidden, load]); // eslint-disable-line react-hooks/exhaustive-deps
  return { data, setData, message, setMessage, load };
}

export const Empty = ({ children }: { children: ReactNode }) => <p className="settings__note">{children}</p>;

function TodoItem({ t, onToggle }: { t: Task; onToggle: (t: Task) => void }) {
  return (
    <li className="page-todo" data-done={t.done || undefined}>
      <label>
        <input type="checkbox" checked={t.done} onChange={() => onToggle(t)} />
        <span>{t.text}</span>
      </label>
      {t.project && <em>{t.project}</em>}
      {t.due && <time>〆 {t.due.slice(5).replace("-", "/")}</time>}
    </li>
  );
}

/** ToDo の操作（追加・完了切り替え）を共通化 */
function useTaskActions(setData: (o: Overview) => void, setMessage: (m: Msg) => void) {
  const post = useCallback(
    async (body: Record<string, unknown>, done: string) => {
      try {
        setData(await call<Overview>("/api/tasks", { method: "POST", body: JSON.stringify(body) }));
        setMessage({ ok: true, text: done });
        window.dispatchEvent(new Event(TASKS_CHANGED));
      } catch (err) {
        setMessage({ ok: false, text: err instanceof Error ? err.message : "保存できませんでした。" });
      }
    },
    [setData, setMessage],
  );
  const toggle = useCallback(
    (t: Task) => void post({ action: "toggle", path: t.path, text: t.text, done: !t.done }, t.done ? "未完了に戻しました。" : "完了にしました。"),
    [post],
  );
  return { post, toggle };
}

/* ---------- PROJECTS ---------- */

export const ProjectsPage = memo(function ProjectsPage({ hidden }: { hidden: boolean }) {
  const { data, setData, message, setMessage } = useLoad<Overview>(hidden, "/api/projects", [TASKS_CHANGED]);
  const { post, toggle } = useTaskActions(setData as (o: Overview) => void, setMessage);
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  return (
    <Page title="PROJECTS" sub="脳の「プロジェクト」フォルダのノート。1 プロジェクト 1 ノートで管理します" hidden={hidden} message={message}>
      {data && !data.configured && <Empty>脳（Obsidian）が接続されていません。</Empty>}
      {data?.configured && data.projects.length === 0 && (
        <Card title="NO PROJECTS" wide>
          <Empty>Obsidian で「プロジェクト/名前.md」を作るか、F.R.I.D.A.Y. に「〇〇のプロジェクトを作って」と頼んでください。</Empty>
        </Card>
      )}
      {data?.projects.map((p) => {
        const todos = [...data.todos, ...data.done].filter((t) => t.project === p.name);
        return (
          <Card key={p.name} title={p.name} sub={p.status}>
            <div className="page-progress">
              <span className="projects__avatar" style={{ background: p.color }}>
                {p.initial}
              </span>
              <span className="projects__bar">
                <span style={{ transform: `scaleX(${p.progress / 100})` }} />
              </span>
              <select
                value={Math.round(p.progress / 10) * 10}
                onChange={(e) => void post({ action: "progress", project: p.name, progress: Number(e.target.value) }, `${p.name} の進捗を記録しました。`)}
                aria-label="進捗"
              >
                {Array.from({ length: 11 }, (_, i) => i * 10).map((v) => (
                  <option key={v} value={v}>
                    {v}%
                  </option>
                ))}
              </select>
            </div>
            <ul className="page-todos">
              {todos.length ? todos.map((t) => <TodoItem key={t.path + t.text} t={{ ...t, project: undefined }} onToggle={toggle} />) : <Empty>ToDo はまだありません。</Empty>}
            </ul>
            <form
              className="settings__inline"
              onSubmit={(e: FormEvent) => {
                e.preventDefault();
                const text = drafts[p.name]?.trim();
                if (!text) return;
                void post({ action: "add", text, project: p.name }, "ToDo を追加しました。");
                setDrafts((d) => ({ ...d, [p.name]: "" }));
              }}
            >
              <input value={drafts[p.name] ?? ""} onChange={(e) => setDrafts((d) => ({ ...d, [p.name]: e.target.value }))} placeholder="ToDo を追加" />
              <button type="submit" className="ghost-btn">
                追加
              </button>
            </form>
          </Card>
        );
      })}
    </Page>
  );
});

/* ---------- TASKS ---------- */

interface ReminderView {
  id: string;
  at: number;
  label: string;
  text: string;
}

export const TasksPage = memo(function TasksPage({ hidden }: { hidden: boolean }) {
  const { data, setData, message, setMessage } = useLoad<Overview>(hidden, "/api/projects", [TASKS_CHANGED]);
  const reminders = useLoad<{ reminders: ReminderView[] }>(hidden, "/api/reminders", [REMINDERS_CHANGED]);
  const { post, toggle } = useTaskActions(setData as (o: Overview) => void, setMessage);
  const [text, setText] = useState("");
  const [project, setProject] = useState("");
  const [due, setDue] = useState("");

  const cancelReminder = async (r: ReminderView) => {
    await fetch("/api/reminders/done", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: r.id }) }).catch(() => {});
    setMessage({ ok: true, text: `リマインダー「${r.text}」を取り消しました。` });
    void reminders.load();
  };

  return (
    <Page title="TASKS" sub="やること（脳のチェックボックス）とリマインダー" hidden={hidden} message={message}>
      <Card title="ADD" sub="やることを追加">
        <form
          className="settings__stack"
          onSubmit={(e) => {
            e.preventDefault();
            if (!text.trim()) return;
            void post({ action: "add", text, project: project || undefined, due: due || undefined }, "ToDo を追加しました。");
            setText("");
            setDue("");
          }}
        >
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="例：数学の課題を出す" />
          <div className="settings__inline">
            <select value={project} onChange={(e) => setProject(e.target.value)} aria-label="プロジェクト">
              <option value="">（プロジェクトなし）</option>
              {data?.projects.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name}
                </option>
              ))}
            </select>
            <input type="date" value={due} onChange={(e) => setDue(e.target.value)} aria-label="期限" />
            <button type="submit" className="ghost-btn">
              追加
            </button>
          </div>
        </form>
      </Card>

      <Card title="REMINDERS" sub="時間になったら知らせます">
        <ul className="page-todos">
          {reminders.data?.reminders.length ? (
            reminders.data.reminders.map((r) => (
              <li key={r.id} className="page-todo">
                <span>
                  <time>{r.label}</time> {r.text}
                </span>
                <button type="button" className="ghost-btn" onClick={() => void cancelReminder(r)}>
                  取消
                </button>
              </li>
            ))
          ) : (
            <Empty>予定されているリマインダーはありません。「30 分後に教えて」と話しかけると追加できます。</Empty>
          )}
        </ul>
      </Card>

      <Card title="TODO" sub={data ? `未完了 ${data.todos.length}` : undefined} wide>
        {data && !data.configured && <Empty>脳（Obsidian）が接続されていません。</Empty>}
        <ul className="page-todos">
          {data?.todos.length ? data.todos.map((t) => <TodoItem key={t.path + t.text} t={t} onToggle={toggle} />) : data?.configured && <Empty>未完了の ToDo はありません。</Empty>}
        </ul>
      </Card>

      {data && data.done.length > 0 && (
        <Card title="DONE" sub="完了したもの（チェックを外すと戻せます）" wide>
          <ul className="page-todos">
            {[...data.done].reverse().slice(0, 20).map((t) => (
              <TodoItem key={t.path + t.text} t={t} onToggle={toggle} />
            ))}
          </ul>
        </Card>
      )}
    </Page>
  );
});

/* ---------- CALENDAR ---------- */

export const CalendarPage = memo(function CalendarPage({ hidden }: { hidden: boolean }) {
  const { data, message, setMessage, load } = useLoad<CalendarResponse>(hidden, "/api/calendar/events?days=14", [CALENDAR_CHANGED]);
  const today = new Intl.DateTimeFormat("sv-SE").format(new Date());
  const [title, setTitle] = useState("");
  const [date, setDate] = useState(today);
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");

  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    try {
      await call("/api/calendar/events", {
        method: "POST",
        body: JSON.stringify({ title, start: start ? `${date}T${start}` : date, end: start && end ? `${date}T${end}` : undefined, allDay: !start }),
      });
      setMessage({ ok: true, text: `「${title}」を追加しました。` });
      setTitle("");
      window.dispatchEvent(new Event(CALENDAR_CHANGED));
      void load();
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : "追加できませんでした。" });
    }
  };

  const remove = async (ev: CalendarEventView) => {
    if (!window.confirm(`「${ev.title}」（${ev.dayLabel} ${ev.rangeLabel}）を削除しますか？`)) return;
    try {
      await call(`/api/calendar/events?id=${encodeURIComponent(ev.id)}`, { method: "DELETE" });
      setMessage({ ok: true, text: `「${ev.title}」を削除しました。` });
      window.dispatchEvent(new Event(CALENDAR_CHANGED));
      void load();
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : "削除できませんでした。" });
    }
  };

  // 日ごとにまとめる
  const days = new Map<string, CalendarEventView[]>();
  for (const ev of data?.events ?? []) days.set(ev.dayLabel, [...(days.get(ev.dayLabel) ?? []), ev]);

  return (
    <Page title="CALENDAR" sub="Google カレンダー（今日から 2 週間）" hidden={hidden} message={message}>
      {data && !data.connected ? (
        <Card title="NOT LINKED" wide>
          <Empty>{data.configured ? (data.reason ?? "Google カレンダーに接続されていません。") : "Google カレンダーが設定されていません（GOOGLE_CLIENT_ID / SECRET）。"}</Empty>
          {data.configured && (
            <a className="ghost-btn" href="/api/calendar/connect">
              <Icon name="calendar" size={13} /> Google カレンダーに接続
            </a>
          )}
        </Card>
      ) : (
        <>
          <Card title="ADD" sub="予定を追加（時刻を空にすると終日）">
            <form className="settings__stack" onSubmit={(e) => void add(e)}>
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例：歯医者" />
              <div className="settings__inline">
                <input type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="日付" />
                <input type="time" value={start} onChange={(e) => setStart(e.target.value)} aria-label="開始" />
                <input type="time" value={end} onChange={(e) => setEnd(e.target.value)} aria-label="終了" />
              </div>
              <button type="submit" className="ghost-btn">
                追加
              </button>
            </form>
          </Card>
          <Card title="SCHEDULE" sub="2 週間の予定" wide>
            {days.size === 0 && <Empty>予定はありません。</Empty>}
            {[...days].map(([day, events]) => (
              <div key={day} className="page-day">
                <b>{day}</b>
                <ul className="page-todos">
                  {events.map((ev) => (
                    <li key={ev.id} className="page-todo">
                      <span>
                        <time>{ev.rangeLabel}</time> {ev.title}
                        {ev.location && <em> @{ev.location}</em>}
                      </span>
                      <button type="button" className="ghost-btn" onClick={() => void remove(ev)} aria-label={`${ev.title} を削除`}>
                        削除
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </Card>
        </>
      )}
    </Page>
  );
});

/* ---------- MEMORY ---------- */

interface MemoryData {
  entries: { date: string; text: string }[];
  profile: string;
  /** MEMORY AI の索引に入っている段落の数 */
  indexed?: number;
  error?: string;
}

export const MemoryPage = memo(function MemoryPage({ hidden }: { hidden: boolean }) {
  const { data, setData, message, setMessage } = useLoad<MemoryData>(hidden, "/api/memory");
  const [text, setText] = useState("");

  const change = async (method: "POST" | "DELETE", body: Record<string, unknown>, done: string) => {
    try {
      setData(await call<MemoryData>("/api/memory", { method, body: JSON.stringify(body) }));
      setMessage({ ok: true, text: done });
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : "保存できませんでした。" });
    }
  };

  const days = new Map<string, string[]>();
  for (const e of data?.entries ?? []) days.set(e.date, [...(days.get(e.date) ?? []), e.text]);

  return (
    <Page
      title="MEMORY"
      sub={`F.R.I.D.A.Y. が覚えていること（脳の「記憶.md」）${data?.indexed ? ` ・ MEMORY AI 索引 ${data.indexed} 段落` : ""}`}
      hidden={hidden}
      message={message}
    >
      <Card title="REMEMBER" sub="覚えてほしいことを追加">
        <form
          className="settings__inline"
          onSubmit={(e) => {
            e.preventDefault();
            if (!text.trim()) return;
            void change("POST", { text }, "覚えました。");
            setText("");
          }}
        >
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="例：ユーザーは辛いものが苦手" />
          <button type="submit" className="ghost-btn">
            追加
          </button>
        </form>
      </Card>
      <Card title="PROFILE" sub="プロフィール（Obsidian で編集）">
        <div className="md page-md">{data?.profile ? <Markdown text={data.profile} /> : <Empty>プロフィールはまだありません。</Empty>}</div>
      </Card>
      <Card title="MEMORIES" sub={data ? `${data.entries.length} 件（間違いは × で消せます）` : undefined} wide>
        {days.size === 0 && <Empty>まだ何も覚えていません。</Empty>}
        {[...days].map(([date, items]) => (
          <div key={date} className="page-day">
            <b>{date}</b>
            <ul className="page-todos">
              {items.map((t) => (
                <li key={t} className="page-todo">
                  <span>{t}</span>
                  <button type="button" className="ghost-btn" aria-label="この記憶を消す" onClick={() => void change("DELETE", { date, text: t }, "記憶を 1 件消しました。")}>
                    ×
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </Card>
    </Page>
  );
});

/* ---------- FILES ---------- */

interface FileItem {
  path: string;
  folder: string;
  title: string;
}

export const FilesPage = memo(function FilesPage({ hidden }: { hidden: boolean }) {
  const { data, message, setMessage } = useLoad<{ files: FileItem[] }>(hidden, "/api/files");
  const [open, setOpen] = useState<{ path: string; text: string } | null>(null);

  const view = async (f: FileItem) => {
    try {
      setOpen(await call<{ path: string; text: string }>(`/api/files?path=${encodeURIComponent(f.path)}`));
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : "読み込めませんでした。" });
    }
  };

  const folders = new Map<string, FileItem[]>();
  for (const f of data?.files ?? []) folders.set(f.folder, [...(folders.get(f.folder) ?? []), f]);

  return (
    <Page title="FILES" sub="F.R.I.D.A.Y. が書いた文書・投稿案・振り返り・日記" hidden={hidden} message={message}>
      <Card title="LIBRARY" sub={data ? `${data.files.length} 件` : undefined}>
        {folders.size === 0 && <Empty>まだ文書はありません。「〇〇の企画書を書いて」と頼んでみてください。</Empty>}
        {[...folders].map(([folder, files]) => (
          <div key={folder} className="page-day">
            <b>{folder}</b>
            <ul className="page-todos">
              {files.map((f) => (
                <li key={f.path} className="page-todo" data-active={open?.path === f.path || undefined}>
                  <button type="button" className="page-file" onClick={() => void view(f)}>
                    <Icon name="doc" size={13} /> {f.title}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </Card>
      <Card title="VIEW" sub={open?.path}>
        {open ? (
          <>
            <div className="md page-md">
              <Markdown text={open.text} />
            </div>
            <button type="button" className="ghost-btn" onClick={() => void navigator.clipboard?.writeText(open.text)}>
              コピー
            </button>
          </>
        ) : (
          <Empty>左の一覧から文書を選んでください。</Empty>
        )}
      </Card>
    </Page>
  );
});
