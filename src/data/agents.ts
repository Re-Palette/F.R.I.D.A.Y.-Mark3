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
  /** オービット上の配置（カード中心・ステージに対する %）と幅（ステージ幅に対する %） */
  pos: { x: number; y: number; w: number };
}

export const AGENT_CARDS: AgentCardDef[] = [
  { key: "chat", id: "chat", title: "CHAT AI", engine: "Gemini Flash", tags: ["Fast", "Natural", "Always here"], icon: "chat", phase: "live", pos: { x: 50, y: 10, w: 32 } },
  { key: "search", id: "search", title: "SEARCH AI", engine: "Web Search", tags: ["News", "Research", "Information"], icon: "search", phase: "ready", pos: { x: 25, y: 25.5, w: 25 } },
  { key: "writing", id: "writing", title: "WRITING AI", engine: "Document Agent", tags: ["Document", "Report", "Creative"], icon: "doc", phase: "soon", pos: { x: 75, y: 25.5, w: 27 } },
  { key: "vault", id: "memory", title: "MEMORY", engine: "Obsidian Vault", tags: ["Knowledge", "Notes", "Long-term"], icon: "vault", phase: "soon", pos: { x: 14.5, y: 47, w: 28 } },
  { key: "automation", id: "automation", title: "AUTOMATION", engine: "Custom Agent", tags: ["Schedule", "Task", "Workflow"], icon: "automation", phase: "soon", pos: { x: 85.5, y: 47, w: 25 } },
  { key: "analysis", id: "analysis", title: "ANALYSIS AI", engine: "Decision Support", tags: ["Data", "Strategy", "Decision"], icon: "analysis", phase: "soon", pos: { x: 22.5, y: 71, w: 28 } },
  { key: "sns", id: "sns", title: "SNS AI", engine: "Trend Agent", tags: ["SNS Analysis", "Trend", "Marketing"], icon: "share", phase: "soon", pos: { x: 77.5, y: 71, w: 26 } },
  { key: "memai", id: "memory", title: "MEMORY AI", engine: "Vector DB", tags: ["Context", "Recall", "Connect"], icon: "brain", phase: "soon", pos: { x: 50, y: 87, w: 28 } },
];
