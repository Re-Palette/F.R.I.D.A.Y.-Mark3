/**
 * プロジェクトと ToDo（Obsidian の脳のノートから読む・書く）。
 *
 *   プロジェクト/<名前>.md … 1 プロジェクト 1 ノート。進捗は「progress: 60」の行、無ければチェックボックスの完了率
 *   FRIDAY/ToDo.md       … プロジェクトに属さない ToDo
 *   ToDo は Obsidian のチェックボックス「- [ ] やること（期限: 2026-10-01）」。完了は「- [x]」
 */
import { invalidate, swr } from "@/lib/swr";
import { BRAIN_DIR, isBrainConfigured, listNotes, readNote, updateNote } from "@/memory/github-brain";

export const TODO_PATH = `${BRAIN_DIR}/ToDo.md`;
export const PROJECT_DIR = "プロジェクト/";
const CACHE_KEY = "tasks-overview";
const COLORS = ["#2fd6a3", "#3d8bff", "#9b6bff", "#e0885a", "#ff5f8f", "#f2c94c", "#56ccf2", "#a3d977"];

export interface Task {
  text: string;
  done: boolean;
  due?: string;
  /** 所属プロジェクト（ToDo.md のものは無し） */
  project?: string;
  path: string;
}

export interface Project {
  name: string;
  path: string;
  /** 0〜100 */
  progress: number;
  /** progress が「progress: 60」の行で指定されているか（false ならチェックボックスの完了率） */
  manual: boolean;
  open: number;
  done: number;
  /** 次にやること（未完了の最初の ToDo） */
  next?: string;
  status?: string;
  color: string;
  initial: string;
}

export interface TasksOverview {
  projects: Project[];
  /** 未完了の ToDo（期限の近い順） */
  todos: Task[];
  /** 完了した ToDo（振り返り用。最大 40 件） */
  done: Task[];
}

const CHECKBOX = /^(\s*[-*+]\s+\[)([ xX])(\]\s+)(.+)$/;
const DUE = /[（(]\s*期限[:：]\s*(\d{4}-\d{2}-\d{2})\s*[)）]|📅\s*(\d{4}-\d{2}-\d{2})/;
const PROGRESS = /^\s*(?:progress|進捗)\s*[:：]\s*(\d{1,3})\s*%?\s*$/im;

function parseTasks(text: string, path: string, project?: string): Task[] {
  const tasks: Task[] = [];
  for (const line of text.split("\n")) {
    const m = CHECKBOX.exec(line);
    if (!m) continue;
    const raw = m[4].trim();
    const due = DUE.exec(raw);
    const body = raw.replace(DUE, "").trim();
    if (body) tasks.push({ text: body, done: m[2] !== " ", due: due ? (due[1] ?? due[2]) : undefined, project, path });
  }
  return tasks;
}

const projectName = (path: string, text: string) =>
  /^#\s+(.+)$/m.exec(text)?.[1].trim() || path.slice(PROJECT_DIR.length).replace(/\.md$/, "");

function parseProject(path: string, text: string, index: number): { project: Project; tasks: Task[] } {
  const name = projectName(path, text);
  const tasks = parseTasks(text, path, name);
  const done = tasks.filter((t) => t.done).length;
  const open = tasks.length - done;
  const manual = PROGRESS.exec(text);
  const progress = manual ? Math.min(100, Number(manual[1])) : tasks.length ? Math.round((done / tasks.length) * 100) : 0;
  // 「## 今の状況」の最初の行を状況として使う
  const status = /##\s*今の状況\s*\n+([^\n#][^\n]*)/.exec(text)?.[1].replace(/^[-*]\s*/, "").trim() || undefined;
  return {
    project: {
      name,
      path,
      progress,
      manual: Boolean(manual),
      open,
      done,
      next: tasks.find((t) => !t.done)?.text,
      status,
      color: COLORS[index % COLORS.length],
      initial: [...name][0]?.toUpperCase() ?? "?",
    },
    tasks,
  };
}

async function loadOverview(): Promise<TasksOverview> {
  const files = await listNotes();
  const projectFiles = files.filter((f) => f.path.startsWith(PROJECT_DIR) && !/はじめに\.md$/.test(f.path)).slice(0, 30);
  const todoFile = files.find((f) => f.path === TODO_PATH);
  const [projectTexts, todoText] = await Promise.all([
    Promise.all(projectFiles.map((f) => readNote(f).catch(() => ""))),
    todoFile ? readNote(todoFile).catch(() => "") : Promise.resolve(""),
  ]);
  const projects: Project[] = [];
  const todos: Task[] = parseTasks(todoText, TODO_PATH);
  projectFiles.forEach((f, i) => {
    const { project, tasks } = parseProject(f.path, projectTexts[i], i);
    projects.push(project);
    todos.push(...tasks);
  });
  const open = todos.filter((t) => !t.done).sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999"));
  return { projects, todos: open, done: todos.filter((t) => t.done).slice(-40) };
}

/** 一覧（1 分以内は前回の結果、1 時間以内なら前回の結果を返しつつ裏で取り直す） */
export function getTasksOverview(): Promise<TasksOverview> {
  if (!isBrainConfigured()) return Promise.resolve({ projects: [], todos: [], done: [] });
  return swr(CACHE_KEY, 60_000, 60 * 60_000, loadOverview);
}

/** 書き込んだ後: 次の読み込みで必ず新しい内容を使う */
async function afterWrite(): Promise<void> {
  invalidate(CACHE_KEY);
  await listNotes(true).catch(() => {});
}

/* ---------- 書き込み ---------- */

const norm = (s: string) => s.replace(/[\s、。，．,.!！?？「」『』（）()・…ー〜\-#*_>`[\]|:：/]/g, "").toLowerCase();

function bigrams(s: string): Set<string> {
  const t = norm(s);
  const out = new Set<string>();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  if (t.length === 1) out.add(t);
  return out;
}

/** 0〜1 の似ている度合い */
function similarity(a: string, b: string): number {
  if (norm(a) === norm(b)) return 1;
  if (norm(a) && norm(b) && (norm(a).includes(norm(b)) || norm(b).includes(norm(a)))) return 0.9;
  const x = bigrams(a);
  const y = bigrams(b);
  if (!x.size || !y.size) return 0;
  let hit = 0;
  for (const g of x) if (y.has(g)) hit++;
  return (2 * hit) / (x.size + y.size);
}

async function findProject(name: string | undefined): Promise<Project | undefined> {
  if (!name?.trim()) return undefined;
  const { projects } = await loadOverview();
  let best: Project | undefined;
  let score = 0;
  for (const p of projects) {
    const s = similarity(p.name, name);
    if (s > score) [best, score] = [p, s];
  }
  return score >= 0.5 ? best : undefined;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** ToDo を追加する（プロジェクトが分かればそのノートの「## ToDo」に、無ければ FRIDAY/ToDo.md に） */
export async function addTodo(input: { text?: unknown; project?: unknown; due?: unknown }): Promise<Task> {
  const text = String(input.text ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
  if (!text) throw new Error("やることの内容が分かりませんでした。");
  const due = typeof input.due === "string" && DATE.test(input.due.trim()) ? input.due.trim() : undefined;
  const project = await findProject(typeof input.project === "string" ? input.project : undefined);
  const line = `- [ ] ${text}${due ? `（期限: ${due}）` : ""}`;

  if (project) {
    await updateNote(
      project.path,
      (current) => {
        const body = current ?? `# ${project.name}\n`;
        if (/^##\s*ToDo\s*$/im.test(body)) {
          // 「## ToDo」の最後の行のあとに足す
          const lines = body.split("\n");
          const start = lines.findIndex((l) => /^##\s*ToDo\s*$/i.test(l));
          let end = start + 1;
          while (end < lines.length && !/^#{1,2}\s/.test(lines[end])) end++;
          while (end > start + 1 && !lines[end - 1].trim()) end--;
          lines.splice(end, 0, line);
          return lines.join("\n");
        }
        return `${body.trimEnd()}\n\n## ToDo\n${line}\n`;
      },
      `F.R.I.D.A.Y.: ToDo を追加（${project.name}）`,
    );
  } else {
    await updateNote(
      TODO_PATH,
      (current) => `${(current ?? "# ToDo\n\nF.R.I.D.A.Y. が会話で頼まれた「やること」をここに書き足します。終わったら [x] にしてください。\n").trimEnd()}\n${line}\n`,
      "F.R.I.D.A.Y.: ToDo を追加",
    );
  }
  await afterWrite();
  return { text, done: false, due, project: project?.name, path: project?.path ?? TODO_PATH };
}

/** 一番似ている未完了の ToDo を完了にする */
export async function completeTodo(input: { text?: unknown }): Promise<Task> {
  const query = String(input.text ?? "").trim();
  if (!query) throw new Error("どのやることか分かりませんでした。");
  const { todos } = await loadOverview();
  let best: Task | undefined;
  let score = 0;
  for (const t of todos) {
    const s = similarity(t.text, query);
    if (s > score) [best, score] = [t, s];
  }
  if (!best || score < 0.45) throw new Error("そのやることが見つかりませんでした。");
  const target = best;
  let changed = false;
  await updateNote(
    target.path,
    (current) =>
      (current ?? "")
        .split("\n")
        .map((l) => {
          const m = CHECKBOX.exec(l);
          if (changed || !m || m[2] !== " " || norm(m[4].replace(DUE, "")) !== norm(target.text)) return l;
          changed = true;
          return `${m[1]}x${m[3]}${m[4]}`;
        })
        .join("\n"),
    `F.R.I.D.A.Y.: ToDo を完了（${target.text}）`,
  );
  if (!changed) throw new Error("そのやることが見つかりませんでした。");
  await afterWrite();
  return { ...target, done: true };
}

/** プロジェクトの進捗（%）を「progress: 60」の行で記録する */
export async function setProgress(input: { project?: unknown; progress?: unknown }): Promise<Project> {
  const project = await findProject(typeof input.project === "string" ? input.project : undefined);
  if (!project) throw new Error("そのプロジェクトのノートが見つかりませんでした。");
  const value = Math.round(Number(input.progress));
  if (!Number.isFinite(value) || value < 0 || value > 100) throw new Error("進捗は 0〜100 の数字で教えてください。");
  await updateNote(
    project.path,
    (current) => {
      const body = current ?? `# ${project.name}\n`;
      if (PROGRESS.test(body)) return body.replace(PROGRESS, `progress: ${value}`);
      // 見出しの直後に入れる
      const lines = body.split("\n");
      const h = lines.findIndex((l) => /^#\s/.test(l));
      lines.splice(h >= 0 ? h + 1 : 0, 0, "", `progress: ${value}`);
      return lines.join("\n");
    },
    `F.R.I.D.A.Y.: 進捗を更新（${project.name} ${value}%）`,
  );
  await afterWrite();
  return { ...project, progress: value, manual: true };
}

/** 画面のチェックボックスから、ToDo を完了／未完了にする（ノートと本文を指定する） */
export async function setTodoDone(input: { path?: unknown; text?: unknown; done?: unknown }): Promise<void> {
  const path = String(input.path ?? "");
  const text = String(input.text ?? "");
  const done = input.done === true;
  if (!(path === TODO_PATH || path.startsWith(PROJECT_DIR)) || !text) throw new Error("どのやることか分かりませんでした。");
  let changed = false;
  await updateNote(
    path,
    (current) =>
      (current ?? "")
        .split("\n")
        .map((l) => {
          const m = CHECKBOX.exec(l);
          if (changed || !m || norm(m[4].replace(DUE, "")) !== norm(text) || (m[2] !== " ") === done) return l;
          changed = true;
          return `${m[1]}${done ? "x" : " "}${m[3]}${m[4]}`;
        })
        .join("\n"),
    `F.R.I.D.A.Y.: ToDo を${done ? "完了" : "未完了"}に（${text}）`,
  );
  if (!changed) throw new Error("そのやることが見つかりませんでした。");
  await afterWrite();
}
