/**
 * ARQO の AI 会社（48 名の AI 社員）とのつながり。
 *
 * 会社側は MCP（Model Context Protocol）を HTTP で話すので、ここはその
 * クライアント。読み取りは返答の前に集めて下に渡し、操作は隠しタグ
 * （company-actions.ts）から呼ぶ。
 *
 * 承認が要る操作（外部へのメール送信・公開・支出・本番反映）は会社側で
 * 必ず止まる。F.R.I.D.A.Y. は承認を実行する権限を持っていないので、
 * どう頼まれても外へは出ない。承認は陽大がダッシュボードで行う。
 */

const TIMEOUT_MS = 12_000;

export interface CompanyConfig {
  url: string;
  token: string;
  /**
   * 会社側が Vercel の「Deployment Protection（Vercel Authentication）」で
   * 守られている場合、ブラウザのログインを持たないこちらの通信は
   * アプリに届く前にログイン画面に差し替えられる。Vercel が用意している
   * 自動化用の抜け道（Protection Bypass for Automation）の合言葉をここに
   * 入れると、守りを外さないままこの通信だけが通る。
   * 守りが無い会社なら空でよい。
   */
  bypass: string;
}

export function getCompanyConfig(): CompanyConfig | null {
  const url = (process.env.COMPANY_URL ?? "").trim().replace(/\/+$/, "");
  const token = (process.env.COMPANY_TOKEN ?? "").trim();
  const bypass = (process.env.COMPANY_BYPASS ?? "").trim();
  return url && token ? { url, token, bypass } : null;
}

export function companyConnected(): boolean {
  return getCompanyConfig() !== null;
}

/** MCP の tools/call を 1 回。失敗は投げる（呼び出し側が一言に変える） */
async function callTool(
  name: string,
  args: Record<string, unknown> = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const config = getCompanyConfig();
  if (!config) throw new Error("AI 会社に接続されていません。");

  const timer = AbortSignal.timeout(TIMEOUT_MS);
  const response = await fetch(`${config.url}/api/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.token}`,
      // HTTP ヘッダは ISO-8859-1 しか通らない。日本語（全角カッコを含む）を
      // 入れると fetch が投げる。会社側の表示名は会社側の既定に任せる。
      "x-friday-actor": "FRIDAY (Mark3)",
      ...(config.bypass
        ? {
            "x-vercel-protection-bypass": config.bypass,
            // 守りを通った印をこちらに残さない（通信ごとに合言葉で通る）
            "x-vercel-set-bypass-cookie": "false",
          }
        : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
    signal: signal ? AbortSignal.any([signal, timer]) : timer,
    cache: "no-store",
  });

  // アプリではなく Vercel のログイン画面が答えた場合（HTML が返る）。
  // 「トークンが違う」と誤診しないよう、本当の理由を伝える。
  if (!(response.headers.get("content-type") ?? "").includes("json")) {
    throw new Error(
      "会社の入口（Vercel のアクセス保護）で止められました。COMPANY_BYPASS の設定が必要です。",
    );
  }

  if (!response.ok) {
    if (response.status === 401) throw new Error("会社への接続トークンが拒否されました。");
    if (response.status === 503) throw new Error("会社側で外部エージェント用のアクセスが未設定です。");
    throw new Error(`会社に接続できませんでした（${response.status}）。`);
  }

  const body = (await response.json()) as {
    result?: { content?: { text?: string }[]; isError?: boolean };
    error?: { message?: string };
  };
  if (body.error) throw new Error(body.error.message ?? "会社がリクエストを拒否しました。");

  const text = body.result?.content?.[0]?.text ?? "null";
  const value = JSON.parse(text) as unknown;
  if (body.result?.isError) {
    const message = (value as { error?: string })?.error ?? "会社側でエラーが起きました。";
    throw new Error(message);
  }
  return value;
}

/* ── 読み取り ─────────────────────────────────────────────────────────────── */

interface Status {
  canWork: boolean;
  why: string | null;
  model: string;
  allowance: { used: number; budget: number; remaining: number; exhausted: boolean } | null;
  needsCeo: { title: string; requestedBy: string; impact: string; risk: string; kind: string }[];
  inFlight: { agent: string; objective: string }[];
  tasks: { active: number; blocked: number; total: number };
  blocked: { title: string; agent: string; reason?: string }[];
  reportsAwaitingReview: number;
  jobsToday: { id: string; ok: boolean; detail: string }[];
}

export interface CompanyBrief {
  text: string;
  /** 陽大の判断を待っている件数（先に伝えるべきもの） */
  needsCeo: number;
}

/**
 * 返答の前に集める会社の状況を、そのまま下に渡せる日本語に組む。
 *
 * 全部を渡さないのは意図的。副社長が「会社どう？」に答えるのに必要なのは、
 * 止まっているもの・陽大の判断を待っているもの・会社が動けるかどうかで、
 * 400 件の活動ログではない。
 */
export async function companyBrief(signal?: AbortSignal): Promise<CompanyBrief | null> {
  if (!companyConnected()) return null;

  const s = (await callTool("company_status", {}, signal)) as Status;
  const lines: string[] = [];

  lines.push(
    s.canWork
      ? `AI 会社は稼働中（モデル: ${s.model}）。タスク ${s.tasks.total} 件のうち進行中 ${s.tasks.active} 件、止まっているもの ${s.tasks.blocked} 件。`
      : `AI 会社は動いていない。理由: ${s.why ?? "不明"}`,
  );

  if (s.allowance) {
    lines.push(
      `本日の API 枠: ${s.allowance.used} / ${s.allowance.budget}` +
        (s.allowance.exhausted ? "（使い切った。太平洋時間の0時に戻る）" : ""),
    );
  }

  if (s.needsCeo.length > 0) {
    lines.push("", `【陽大の判断を待っているもの ${s.needsCeo.length} 件】`);
    for (const a of s.needsCeo) {
      lines.push(`- ${a.title}（${a.requestedBy} / リスク${a.risk}）承認すると: ${a.impact}`);
    }
    lines.push("※ 承認は陽大がダッシュボードで行う。F.R.I.D.A.Y. には実行権限が無い。");
  }

  if (s.inFlight.length > 0) {
    lines.push("", "【いま動いているもの】");
    for (const r of s.inFlight) lines.push(`- ${r.agent}: ${r.objective}`);
  }

  if (s.blocked.length > 0) {
    lines.push("", "【止まっているもの】");
    for (const t of s.blocked) lines.push(`- ${t.title}（${t.agent}）: ${t.reason ?? "理由未記録"}`);
  }

  if (s.reportsAwaitingReview > 0) {
    lines.push("", `未読のレポートが ${s.reportsAwaitingReview} 件ある。`);
  }

  if (s.jobsToday.length > 0) {
    lines.push("", "【今日の定期実行】");
    for (const j of s.jobsToday) lines.push(`- ${j.id}: ${j.ok ? "完了" : "未完"} ${j.detail}`);
  }

  return { text: lines.join("\n"), needsCeo: s.needsCeo.length };
}

/* ── 操作 ─────────────────────────────────────────────────────────────────── */

export async function instructCompany(instruction: string, signal?: AbortSignal): Promise<string> {
  const v = (await callTool("instruct_company", { instruction }, signal)) as {
    started?: boolean;
    status?: string;
    text?: string;
  };
  if (v.started) return "会社に指示を伝えた（COO が分解して担当へ振る）";
  return v.text?.slice(0, 160) ?? (v.status ?? "指示を伝えた");
}

export async function advanceCompanyWork(signal?: AbortSignal): Promise<string> {
  const v = (await callTool("advance_work", {}, signal)) as {
    status?: string;
    detail?: string;
    advanced?: { agent: string; taskId: string }[];
  };
  const who = (v.advanced ?? []).map((a) => a.agent).join("、");
  return who ? `${v.detail ?? ""}（${who}）` : (v.detail ?? v.status ?? "");
}

/* ── 意図判定 ─────────────────────────────────────────────────────────────── */

const ASKS =
  /(AI)?会社|社員|部署|役員|承認待ち|決裁|タスクボード|進捗どう|COO|ARQO\s*の?(状況|会社)|うちの会社|会社の(状況|様子|進捗)/;

/** 会社の話をしているときだけ状況を集める（無料枠と待ち時間の節約） */
export function asksForCompany(text: string): boolean {
  return ASKS.test(text);
}
