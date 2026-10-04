/**
 * 返答に付いた隠しタグで頼まれた、AI 会社（ARQO）への操作を実行する。
 *   <company-instruct>調べてほしいこと・やってほしいこと</company-instruct>
 *   <company-advance/>  AI 社員に、自分の担当タスクを今すぐ進めさせる
 *
 * 外部への送信・公開・支出・本番反映は会社側の承認ゲートで必ず止まる。
 * F.R.I.D.A.Y. は承認を実行する権限を持たないので、ここから外へは出ない。
 */
import type { StreamEvent } from "@/core/types";
import { advanceCompanyWork, companyConnected, instructCompany } from "@/integrations/company";

export const COMPANY_TAGS = ["company-instruct", "company-advance"] as const;
export type CompanyTag = (typeof COMPANY_TAGS)[number];

type ActionEvent = Extract<StreamEvent, { type: "action" }>;

const VERB: Record<CompanyTag, string> = {
  "company-instruct": "AI 会社へ指示",
  "company-advance": "AI 社員の作業を進行",
};

async function perform(tag: CompanyTag, body: string, signal?: AbortSignal): Promise<string> {
  if (tag === "company-advance") return advanceCompanyWork(signal);

  const instruction = body.trim();
  if (!instruction) throw new Error("指示の内容が空でした。");
  return instructCompany(instruction, signal);
}

/** 1 つずつ実行し、結果（と失敗時に本文へ足す一言）を返す */
export async function* runCompanyActions(
  captures: Record<CompanyTag, string[]>,
  signal?: AbortSignal,
): AsyncGenerator<{ event: ActionEvent; note?: string }> {
  for (const tag of COMPANY_TAGS) {
    for (const body of captures[tag]) {
      if (signal?.aborted) return;
      let error: string;
      if (!companyConnected()) error = "AI 会社に接続されていません。";
      else {
        try {
          yield { event: { type: "action", kind: tag, ok: true, label: await perform(tag, body, signal) } };
          continue;
        } catch (err) {
          error = err instanceof Error ? err.message : "AI 会社に届きませんでした。";
        }
      }
      yield {
        event: { type: "action", kind: tag, ok: false, label: body.slice(0, 60), error },
        note: `（${VERB[tag]}できませんでした。${error}）`,
      };
    }
  }
}
