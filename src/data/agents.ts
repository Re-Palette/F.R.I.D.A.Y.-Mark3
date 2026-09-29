/**
 * ダッシュボードに表示する Agent カードの定義（クライアント用・表示専用）。
 * 実際に動作するかどうかは /api/status の結果で決まる。
 */
import type { AgentId } from "@/core/types";
import type { IconName } from "@/components/icons";

export type AgentPhase = "live" | "ready" | "soon";

export interface AgentCardDef {
  key: string;
  id: AgentId;
  title: string;
  engine: string;
  tags: string[];
  icon: IconName;
  /** live: 今回実装済み / ready: 次に実装予定 / soon: 将来 */
  phase: AgentPhase;
  /** オービット上の配置スロット（位置は CSS で重ならないよう計算） */
  slot: "top" | "tl" | "tr" | "ml" | "mr" | "bl" | "br" | "bottom";
}

export const AGENT_CARDS: AgentCardDef[] = [
  { key: "chat", id: "chat", title: "CHAT AI", engine: "Gemini Flash", tags: ["Fast", "Natural", "Always here"], icon: "chat", phase: "live", slot: "top" },
  { key: "search", id: "search", title: "SEARCH AI", engine: "Google Search", tags: ["News", "Research", "Information"], icon: "search", phase: "live", slot: "tl" },
  { key: "writing", id: "writing", title: "WRITING AI", engine: "Document Agent", tags: ["Document", "Report", "Creative"], icon: "doc", phase: "live", slot: "tr" },
  { key: "vault", id: "memory", title: "MEMORY", engine: "Obsidian Vault", tags: ["Knowledge", "Notes", "Long-term"], icon: "vault", phase: "soon", slot: "ml" },
  { key: "automation", id: "automation", title: "AUTOMATION", engine: "Nightly Diary", tags: ["Schedule", "Task", "Workflow"], icon: "automation", phase: "live", slot: "mr" },
  { key: "analysis", id: "analysis", title: "ANALYSIS AI", engine: "Weekly Review", tags: ["Data", "Strategy", "Decision"], icon: "analysis", phase: "live", slot: "bl" },
  { key: "sns", id: "sns", title: "SNS AI", engine: "Post & Trend", tags: ["SNS Analysis", "Trend", "Marketing"], icon: "share", phase: "live", slot: "br" },
  { key: "memai", id: "memory", title: "MEMORY AI", engine: "Vector DB", tags: ["Context", "Recall", "Connect"], icon: "brain", phase: "soon", slot: "bottom" },
];
