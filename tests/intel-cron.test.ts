/**
 * /api/cron/intel の応答（health）と、GitHub Actions の intel ジョブの失敗の判定。
 * 通信はしない：ハンドラーには偽の run を渡す。ワークフローの run の部分は、偽の curl を置いた PATH で bash に実行させる。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IntelRunResult, IntelRunStatus } from "../src/integrations/intel/collect";
const { handleIntelCron, intelHealth } = await import("../src/integrations/intel/cron");

const SECRET = "test-cron-secret";
const req = (auth?: string) => new Request("https://friday.test/api/cron/intel", { headers: auth ? { authorization: auth } : {} });
const authed = () => req(`Bearer ${SECRET}`);
const env = { CRON_SECRET: SECRET };

function spyLog() {
  const calls = { info: [] as string[], warn: [] as string[], error: [] as string[] };
  return {
    calls,
    log: {
      info: (m: string) => void calls.info.push(String(m)),
      warn: (m: string) => void calls.warn.push(String(m)),
      error: (m: string) => void calls.error.push(String(m)),
    },
  };
}

const base = (status: IntelRunStatus, extra: Partial<IntelRunResult> = {}): IntelRunResult => ({ status, sources: {}, saved: 0, stale: [], ...extra });

/* ---------- 1〜6. ハンドラーの応答・ログ ---------- */

describe("ハンドラー：HTTP の状態の番号・ok・既存の項目は変えず、health を足す", () => {
  it("1. 合言葉が無い・違う → 401（これまでどおり。health は付けない）。収集は動かさない", async () => {
    let ran = 0;
    const run = async () => (ran++, base("done"));
    const none = await handleIntelCron(authed(), { env: {}, run });
    assert.equal(none.status, 401);
    assert.deepEqual(await none.json(), { ok: false, error: "CRON_SECRET が設定されていません" });
    for (const bad of [undefined, "Bearer wrong", `Bearer ${SECRET}x`, SECRET]) {
      const r = await handleIntelCron(req(bad), { env, run });
      assert.equal(r.status, 401);
      assert.deepEqual(await r.json(), { ok: false, error: "unauthorized" });
    }
    assert.equal(ran, 0);
  });

  it("2. 正常終了（done）→ 200・ok:true・health:\"ok\"。既存の項目はそのまま。警告・エラーのログを出さない", async () => {
    const result = base("done", {
      sources: { usgs: { ok: true, count: 2 }, nhc: { ok: false, skipped: "時間切れのため次回" } },
      saved: 2,
      stale: ["nhc"],
      observations: { saved: 1, skipped: 0, failed: 0, unknown: 0, codes: [] },
    });
    const s = spyLog();
    const r = await handleIntelCron(authed(), { env, run: async () => result, log: s.log });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("cache-control"), "no-store");
    assert.deepEqual(await r.json(), { ok: true, ...result, health: "ok" });
    assert.deepEqual(s.calls, { info: [], warn: [], error: [] });
  });

  it("ok の中で done 以外（busy・disabled・not-configured・off）→ 200・health:\"ok\"。これまでどおり info だけ", async () => {
    for (const status of ["busy", "disabled", "not-configured", "off"] as const) {
      const s = spyLog();
      const r = await handleIntelCron(authed(), { env, run: async () => base(status), log: s.log });
      assert.equal(r.status, 200);
      const j = await r.json();
      assert.equal(j.ok, true);
      assert.equal(j.health, "ok");
      assert.deepEqual(s.calls.warn, []);
      assert.deepEqual(s.calls.error, []);
      assert.deepEqual(s.calls.info, [`[edith-intel] ${status}`]);
    }
  });

  it("3. 時間切れ（timeout）→ 200・ok:true（これまでどおり）・health:\"degraded\"。console.warn に状態が出る", async () => {
    const result = base("timeout", { error: "締切までに情報を保存できませんでした（その情報源は次の回に取り直します）", deferred: ["usgs"] });
    const s = spyLog();
    const r = await handleIntelCron(authed(), { env, run: async () => result, log: s.log });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true, ...result, health: "degraded" });
    assert.deepEqual(s.calls.warn, [`[edith-intel] timeout: ${result.error}`]);
    assert.deepEqual(s.calls.error, []);
    assert.deepEqual(s.calls.info, []);
  });

  it("4. 印の状態が分からない（lock-unknown）→ 200・health:\"degraded\"。status で timeout と見分けられる。lost-lock も degraded", async () => {
    for (const status of ["lock-unknown", "lost-lock"] as const) {
      const s = spyLog();
      const r = await handleIntelCron(authed(), { env, run: async () => base(status, { error: "x" }), log: s.log });
      assert.equal(r.status, 200);
      const j = await r.json();
      assert.equal(j.status, status);
      assert.notEqual(j.status, "timeout");
      assert.equal(j.ok, true);
      assert.equal(j.health, "degraded");
      assert.equal(s.calls.warn.length, 1);
      assert.match(s.calls.warn[0], new RegExp(`^\\[edith-intel\\] ${status}`));
    }
  });

  it("5. error → 500・ok:false（これまでどおり）・health:\"failed\"。console.error に出る", async () => {
    const result = base("error", { error: "GitHub でエラーが発生しました（503）" });
    const s = spyLog();
    const r = await handleIntelCron(authed(), { env, run: async () => result, log: s.log });
    assert.equal(r.status, 500);
    assert.deepEqual(await r.json(), { ok: false, ...result, health: "failed" });
    assert.deepEqual(s.calls.error, [`[edith-intel] error: ${result.error}`]);
    assert.deepEqual(s.calls.warn, []);
  });

  it("6. 予期しない例外 → 500・決まった形の JSON（status:\"error\"・health:\"failed\"）。メッセージ・スタック・秘密は応答に出さない", async () => {
    const s = spyLog();
    const run = async (): Promise<IntelRunResult> => {
      throw new TypeError(`token=ghp_SECRET123 at ${SECRET}`);
    };
    const r = await handleIntelCron(authed(), { env, run, log: s.log });
    assert.equal(r.status, 500);
    assert.equal(r.headers.get("cache-control"), "no-store");
    const text = await r.text();
    assert.deepEqual(JSON.parse(text), {
      ok: false,
      status: "error",
      sources: {},
      saved: 0,
      stale: [],
      error: "予期しない例外で止まりました（詳しくはサーバーのログ）",
      health: "failed",
    });
    assert.doesNotMatch(text, /ghp_|SECRET|TypeError|\bat\b|\.ts:/);
    // サーバーのログには種類と短いメッセージ（調べるため）。console.error で出る
    assert.equal(s.calls.error.length, 2);
    assert.match(s.calls.error[0], /予期しない例外（TypeError/);
    assert.deepEqual(s.calls.warn, []);
  });

  it("ok と HTTP の状態の番号は health に合わせる：知っている 9 つの状態の応答はこれまでと同じ（error だけ 500・ok:false）", async () => {
    const expected: Record<IntelRunStatus, { http: number; ok: boolean; health: string }> = {
      done: { http: 200, ok: true, health: "ok" },
      busy: { http: 200, ok: true, health: "ok" },
      disabled: { http: 200, ok: true, health: "ok" },
      "not-configured": { http: 200, ok: true, health: "ok" },
      off: { http: 200, ok: true, health: "ok" },
      timeout: { http: 200, ok: true, health: "degraded" },
      "lock-unknown": { http: 200, ok: true, health: "degraded" },
      "lost-lock": { http: 200, ok: true, health: "degraded" },
      error: { http: 500, ok: false, health: "failed" },
    };
    for (const [status, e] of Object.entries(expected) as [IntelRunStatus, (typeof expected)[IntelRunStatus]][]) {
      const result = base(status, { error: "x" });
      const r = await handleIntelCron(authed(), { env, run: async () => result, log: spyLog().log });
      assert.equal(r.status, e.http, status);
      assert.deepEqual(await r.json(), { ok: e.ok, ...result, health: e.health }, status);
    }
  });

  it("知らない状態（型の外から来た値）→ health:\"failed\" に合わせて 500・ok:false。console.error に出る", async () => {
    for (const status of ["mystery", "__proto__"]) {
      const result = base(status as IntelRunStatus);
      const s = spyLog();
      const r = await handleIntelCron(authed(), { env, run: async () => result, log: s.log });
      assert.equal(r.status, 500, status);
      const j = await r.json();
      assert.equal(j.ok, false);
      assert.equal(j.health, "failed");
      assert.equal(j.status, status);
      assert.deepEqual(s.calls.error, [`[edith-intel] ${status}`]);
    }
  });
});

/* ---------- 7. 状態 → health ---------- */

describe("7. intelHealth：すべての状態を分ける（状態が増えたら型チェックで分かる）", () => {
  const ALL = ["done", "busy", "disabled", "not-configured", "off", "timeout", "lock-unknown", "lost-lock", "error"] as const satisfies readonly IntelRunStatus[];
  // ALL に無い状態があれば、ここが型エラーになる（状態の一覧と分け方の書き足し忘れを防ぐ）
  type Missing = Exclude<IntelRunStatus, (typeof ALL)[number]>;
  const exhaustive: [Missing] extends [never] ? true : false = true;

  it("ok / degraded / failed の分け方", () => {
    assert.equal(exhaustive, true);
    const got = Object.fromEntries(ALL.map((s) => [s, intelHealth(s)]));
    assert.deepEqual(got, {
      done: "ok",
      busy: "ok",
      disabled: "ok",
      "not-configured": "ok",
      off: "ok",
      timeout: "degraded",
      "lock-unknown": "degraded",
      "lost-lock": "degraded",
      error: "failed",
    });
    // 知らない値（型の外から来た値）は failed（安全側）
    assert.equal(intelHealth("someday" as IntelRunStatus), "failed");
    assert.equal(intelHealth("__proto__" as IntelRunStatus), "failed");
  });
});

/* ---------- 8. ワークフロー：intel ジョブの失敗の判定を、実際に bash で動かす ---------- */

const WORKFLOW = readFileSync(join(process.cwd(), ".github/workflows/friday-cron.yml"), "utf8");

/** intel ジョブの「Collect EDITH intel」の run: | の中身（字下げを外したもの） */
function intelRunScript(): string {
  const lines = WORKFLOW.split("\n");
  const step = lines.findIndex((l) => l.trim() === "- name: Collect EDITH intel");
  assert.ok(step >= 0, "intel の手順がある");
  const runAt = lines.findIndex((l, i) => i > step && l.trim() === "run: |");
  assert.ok(runAt > step);
  const indent = lines[runAt].indexOf("run:") + 2;
  const out: string[] = [];
  for (const l of lines.slice(runAt + 1)) {
    if (l.trim() !== "" && l.length - l.trimStart().length < indent) break;
    out.push(l.slice(indent));
  }
  return out.join("\n");
}

/** 道具の場所（無ければ null） */
const which = (tool: string): string | null => {
  const r = spawnSync("/usr/bin/bash", ["-c", `command -v ${tool}`], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
};

type JsonTool = "jq" | "python3" | "node" | "none";
interface Case {
  code: string;
  body: string;
  curlExit?: number;
  env?: Record<string, string>;
}

/** 偽の curl と、決まった道具だけの PATH で、run の部分を GitHub Actions と同じ bash（-eo pipefail）で動かす */
function runWorkflow(tool: JsonTool, c: Case) {
  const dir = mkdtempSync(join(tmpdir(), "intel-wf-"));
  const bin = join(dir, "bin");
  spawnSync("mkdir", [bin]);
  for (const t of ["mktemp", "head", "tr", "cat", "rm"]) symlinkSync(which(t)!, join(bin, t));
  if (tool !== "none") symlinkSync(which(tool)!, join(bin, tool));
  const bodyFile = join(dir, "fixture-body");
  writeFileSync(bodyFile, c.body);
  const argsFile = join(dir, "curl-args");
  // 偽の curl：引数を記録し、-o のファイルに本文を書き、-w の代わりに状態の番号を出す
  writeFileSync(
    join(bin, "curl"),
    `#!/usr/bin/bash
printf '%s\\n' "$@" > "${argsFile}"
out=""
while [ $# -gt 0 ]; do
  if [ "$1" = "-o" ]; then out="$2"; shift; fi
  shift
done
[ -n "$out" ] && /usr/bin/cat "${bodyFile}" > "$out"
printf '%s' "${c.code}"
exit ${c.curlExit ?? 0}
`,
  );
  chmodSync(join(bin, "curl"), 0o755);
  const script = join(dir, "run.sh");
  writeFileSync(script, intelRunScript());
  const summary = join(dir, "summary.md");
  writeFileSync(summary, "");
  const r = spawnSync("/usr/bin/bash", ["--noprofile", "--norc", "-eo", "pipefail", script], {
    encoding: "utf8",
    // 渡す環境変数はこれだけ（ProcessEnv の型は NODE_ENV などを求めるので、型だけ合わせる）
    env: { PATH: bin, FRIDAY_URL: "https://friday.test/", CRON_SECRET: SECRET, GITHUB_STEP_SUMMARY: summary, ...c.env } as unknown as NodeJS.ProcessEnv,
  });
  return {
    exit: r.status,
    out: r.stdout,
    err: r.stderr,
    summary: readFileSync(summary, "utf8"),
    curlArgs: existsSync(argsFile) ? readFileSync(argsFile, "utf8").split("\n") : null,
  };
}

const json = (o: unknown) => JSON.stringify(o);

/** 攻撃者が書き換えた本文（行頭の命令・\r で始まる命令・stop-commands を含む） */
const INJECTED_BODY = [
  "<html>",
  "::error title=偽物::応答の本文から作られた偽の注釈",
  "::warning::偽物の警告",
  "::add-mask::ok",
  "::stop-commands::tok123",
  "ふつうの行\r::notice::偽物（\\r の後ろ）",
  "</html>",
].join("\n");

/** GitHub Actions が命令として読む行（標準出力・標準エラー。\r と \n の両方で区切って、行頭が :: のもの） */
const commandLines = (r: { out: string; err: string }) => `${r.out}\n${r.err}`.split(/\r\n|\r|\n/).filter((l) => l.startsWith("::"));

/** 本文の行は、すべて「| 」を付けたログとして表示されている */
function assertBodyShownAsLog(r: { out: string }) {
  for (const l of ["::error title=偽物::応答の本文から作られた偽の注釈", "::warning::偽物の警告", "::add-mask::ok", "::stop-commands::tok123", "::notice::偽物（\\r の後ろ）"]) {
    assert.ok(r.out.includes(`| ${l}`), `本文の行「${l}」を | 付きで表示する`);
  }
  assert.ok(r.out.includes("| <html>") && r.out.includes("| </html>"));
}
const TOOLS = (["jq", "python3", "node"] as const).filter((t) => which(t));

describe("8. ワークフロー（intel ジョブ）：HTTP 200 以外・JSON でない・failed・degraded を失敗にする", () => {
  it("使える道具の確認（この環境で、jq・python3・node のどれを試せるか）", () => {
    assert.ok(TOOLS.length >= 1, "少なくとも 1 つの道具で試す");
  });

  for (const tool of TOOLS) {
    describe(`JSON を読む道具：${tool}`, () => {
      it("health:\"ok\" → 成功（警告・エラーの注釈なし）。curl は 70 秒の上限・本文と状態の番号を分けて受け取る", () => {
        const r = runWorkflow(tool, { code: "200", body: json({ ok: true, status: "done", health: "ok" }) });
        assert.equal(r.exit, 0, r.out + r.err);
        assert.doesNotMatch(r.out, /::(warning|error)::/);
        assert.match(r.out, /HTTP 200/);
        assert.equal(r.summary, "");
        const a = r.curlArgs!;
        assert.ok(a.includes("--max-time") && a[a.indexOf("--max-time") + 1] === "70");
        assert.ok(a.includes("-o") && a.includes("-w") && a[a.indexOf("-w") + 1] === "%{http_code}");
        assert.ok(a.includes(`Authorization: Bearer ${SECRET}`));
        assert.equal(a.find((x) => x.startsWith("https://")), "https://friday.test/api/cron/intel");
      });

      for (const status of ["timeout", "lock-unknown", "lost-lock"]) {
        it(`health:"degraded"（${status}）→ ::warning:: と要約を書いてから失敗`, () => {
          const r = runWorkflow(tool, { code: "200", body: json({ ok: true, status, health: "degraded" }) });
          assert.equal(r.exit, 1);
          assert.match(r.out, new RegExp(`::warning::.*（${status}）`));
          assert.doesNotMatch(r.out, /::error::/);
          assert.match(r.summary, new RegExp(`要注意（${status}）`));
        });
      }

      it("health:\"failed\"（HTTP 200 で返った場合）→ ::error:: で失敗", () => {
        const r = runWorkflow(tool, { code: "200", body: json({ ok: false, status: "error", health: "failed" }) });
        assert.equal(r.exit, 1);
        assert.match(r.out, /::error::.*失敗しました（error）/);
      });

      it("HTTP 500（JSON）・401・504（Vercel の画面）→ ::error:: で失敗。本文は表示して調べられる", () => {
        for (const [code, body] of [
          ["500", json({ ok: false, status: "error", health: "failed", error: "GitHub でエラーが発生しました（503）" })],
          ["401", json({ ok: false, error: "unauthorized" })],
          ["504", "<html>An error occurred with your deployment FUNCTION_INVOCATION_TIMEOUT</html>"],
        ] as const) {
          const r = runWorkflow(tool, { code, body });
          assert.equal(r.exit, 1, code);
          assert.match(r.out, new RegExp(`::error::.*HTTP ${code}`));
          assert.ok(r.out.includes(body.slice(0, 30)), "本文を表示する");
          assert.match(r.summary, new RegExp(`HTTP ${code}`));
        }
      });

      it("JSON でない・配列・health が無い → 失敗", () => {
        for (const body of ["<html>ok</html>", "", "[1,2]", json({ ok: true, status: "done" })]) {
          const r = runWorkflow(tool, { code: "200", body });
          assert.equal(r.exit, 1, body);
          assert.match(r.out, /::error::/, body);
        }
      });

      it("HTTP 504 の複数行の本文に「::error・::add-mask・::stop-commands」があっても命令にならない。本物の注釈と失敗はそのまま", () => {
        const r = runWorkflow(tool, { code: "504", body: INJECTED_BODY });
        assert.equal(r.exit, 1);
        assert.deepEqual(commandLines(r), ["::error::E.D.I.T.H. の情報収集が HTTP 504 を返しました"]);
        assertBodyShownAsLog(r);
        assert.doesNotMatch(r.summary, /偽物|add-mask|stop-commands/);
      });

      it("HTTP 200 で JSON でない複数行の本文に同じ文字があっても命令にならない（パーサーのエラーの文も出さない）", () => {
        const r = runWorkflow(tool, { code: "200", body: INJECTED_BODY });
        assert.equal(r.exit, 1);
        assert.deepEqual(commandLines(r), ["::error::E.D.I.T.H. の情報収集の応答を JSON として読めませんでした"]);
        assertBodyShownAsLog(r);
        assert.doesNotMatch(r.err, /偽物|::/);
      });

      it("本文の表示は 4000 バイトまで（それより後ろは表示しない）", () => {
        const body = `${"a".repeat(3990)}\n${"b".repeat(100)}\n::error::後ろの偽物`;
        const r = runWorkflow(tool, { code: "504", body });
        assert.equal(r.exit, 1);
        assert.ok(r.out.includes(`| ${"a".repeat(3990)}`));
        assert.ok(!r.out.includes("b".repeat(10)), "4000 バイトより後ろは表示しない");
        assert.doesNotMatch(r.out, /後ろの偽物/);
        assert.deepEqual(commandLines(r), ["::error::E.D.I.T.H. の情報収集が HTTP 504 を返しました"]);
      });

      it("応答の中の文字で注釈を偽装できない（status の改行・:: は取り除く）", () => {
        const r = runWorkflow(tool, { code: "200", body: json({ ok: true, status: "timeout\n::error::偽物", health: "degraded" }) });
        assert.equal(r.exit, 1);
        const ann = r.out.split("\n").filter((l) => l.startsWith("::"));
        assert.equal(ann.length, 1, ann.join(" / "));
        assert.match(ann[0], /^::warning::/);
      });
    });
  }

  it("curl 自体が失敗（接続できない・70 秒を超えた）→ ::error:: で失敗", () => {
    const r = runWorkflow(TOOLS[0], { code: "000", body: "", curlExit: 28 });
    assert.equal(r.exit, 1);
    assert.match(r.out, /::error::.*呼び出せませんでした/);
  });

  it("JSON を読む道具が 1 つも無い → 安全側に失敗（health:ok でも成功にしない）", () => {
    const r = runWorkflow("none", { code: "200", body: json({ ok: true, status: "done", health: "ok" }) });
    assert.equal(r.exit, 1);
    assert.match(r.out, /::error::.*JSON として読めません/);
    assert.match(r.err, /jq・python3・node/);
  });

  it("JSON を読む道具が無いときも、本文の命令は実行されない（本物の注釈と失敗だけ）", () => {
    const r = runWorkflow("none", { code: "200", body: INJECTED_BODY });
    assert.equal(r.exit, 1);
    assert.deepEqual(commandLines(r), ["::error::E.D.I.T.H. の情報収集の応答を JSON として読めませんでした"]);
    assertBodyShownAsLog(r);
  });

  const SKIP_WARNING = "::warning::E.D.I.T.H. の情報収集をスキップしました（FRIDAY_URL または CRON_SECRET の secret が未設定です）";
  const SKIP_SUMMARY = "### E.D.I.T.H. の情報収集：スキップ（FRIDAY_URL または CRON_SECRET の secret が未設定）\n";

  it("FRIDAY_URL・CRON_SECRET が無い → これまでどおり成功（curl を呼ばない）。決まった文の警告と Step Summary を出す", () => {
    for (const missing of [{ FRIDAY_URL: "" }, { CRON_SECRET: "" }, { FRIDAY_URL: "", CRON_SECRET: "" }] as Record<string, string>[]) {
      const r = runWorkflow(TOOLS[0], { code: "200", body: "", env: missing });
      assert.equal(r.exit, 0);
      assert.equal(r.curlArgs, null);
      assert.deepEqual(commandLines(r), [SKIP_WARNING]);
      assert.equal(r.summary, SKIP_SUMMARY);
      assert.equal(r.err, "");
      // secret の値・URL は出さない
      for (const text of [r.out, r.err, r.summary]) {
        assert.doesNotMatch(text, new RegExp(SECRET));
        assert.doesNotMatch(text, /friday\.test/);
      }
    }
  });

  it("secret が無いとき、Step Summary が無い・空・書けない場所でも、警告を出して成功で終わる", () => {
    for (const summaryEnv of [{ GITHUB_STEP_SUMMARY: "" }, { GITHUB_STEP_SUMMARY: "/nonexistent/x/summary.md" }]) {
      const r = runWorkflow(TOOLS[0], { code: "200", body: "", env: { CRON_SECRET: "", ...summaryEnv } });
      assert.equal(r.exit, 0);
      assert.equal(r.curlArgs, null);
      assert.deepEqual(commandLines(r), [SKIP_WARNING]);
      assert.equal(r.err, "");
      assert.equal(r.summary, "");
    }
  });

  it("push ジョブは変えていない（-f 付きの curl・90 秒）。intel ジョブだけが health を見る", () => {
    const push = WORKFLOW.slice(WORKFLOW.indexOf("  push:"), WORKFLOW.indexOf("  # E.D.I.T.H. の情報収集"));
    assert.equal(
      push,
      `  push:
    runs-on: ubuntu-latest
    timeout-minutes: 3
    steps:
      - name: Send due notifications
        env:
          FRIDAY_URL: \${{ secrets.FRIDAY_URL }}
          CRON_SECRET: \${{ secrets.CRON_SECRET }}
        run: |
          if [ -z "$FRIDAY_URL" ] || [ -z "$CRON_SECRET" ]; then
            echo "FRIDAY_URL / CRON_SECRET が未設定のため何もしません"; exit 0
          fi
          curl -fsS --max-time 90 -H "Authorization: Bearer $CRON_SECRET" "\${FRIDAY_URL%/}/api/cron/push"

`,
    );
    assert.match(intelRunScript(), /--max-time 70/);
  });
});

/* ---------- 9. route.ts：ハンドラーに渡すだけ。maxDuration などの設定は変えない ---------- */

describe("9. route.ts", () => {
  const route = readFileSync(join(process.cwd(), "src/app/api/cron/intel/route.ts"), "utf8");

  it("設定（runtime・dynamic・maxDuration=60）はそのまま。GET は handleIntelCron に渡すだけ。Next.js で使えない書き出しをしない", () => {
    assert.match(route, /export const runtime = "nodejs";/);
    assert.match(route, /export const dynamic = "force-dynamic";/);
    assert.match(route, /export const maxDuration = 60;/);
    assert.match(route, /return handleIntelCron\(req\);/);
    const exported = [...route.matchAll(/export (?:const|async function|function) (\w+)/g)].map((m) => m[1]).sort();
    assert.deepEqual(exported, ["GET", "dynamic", "maxDuration", "runtime"]);
  });

  it("本物の GET（EDITH_INTEL が無い → disabled。脳にも外にも触れない）は 200・health:\"ok\"", async () => {
    const saved = { secret: process.env.CRON_SECRET, intel: process.env.EDITH_INTEL };
    process.env.CRON_SECRET = SECRET;
    delete process.env.EDITH_INTEL;
    try {
      const { GET } = await import("../src/app/api/cron/intel/route");
      const r = await GET(authed());
      assert.equal(r.status, 200);
      const j = await r.json();
      assert.equal(j.status, "disabled");
      assert.equal(j.health, "ok");
      assert.equal(j.ok, true);
    } finally {
      if (saved.secret === undefined) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = saved.secret;
      if (saved.intel !== undefined) process.env.EDITH_INTEL = saved.intel;
    }
  });
});
