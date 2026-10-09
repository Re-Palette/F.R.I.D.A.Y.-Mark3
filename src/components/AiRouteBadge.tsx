"use client";

/** いまどの AI で答えているか（● ONLINE Gemini / ● OFFLINE LOCAL AI / ● SWITCHING）。小さく表示するだけ */
import { useAiRoute, type AiRouteState } from "@/lib/ai-router";

export function aiRouteLabel(s: AiRouteState): { state: "ok" | "local" | "warn" | "off"; label: string; title: string } {
  switch (s.route) {
    case "online":
      return { state: "ok", label: "ONLINE · Gemini", title: "Gemini で答えています" };
    case "offline":
      return {
        state: "local",
        label: "OFFLINE · LOCAL AI",
        title: `${s.why === "gemini" ? "Gemini が使えないため" : "インターネットに接続できないため"}、この PC のローカル AI（Ollama${s.localModel ? `・${s.localModel}` : ""}）で答えています`,
      };
    case "switching":
      return { state: "warn", label: "SWITCHING · Gemini → Local AI", title: "ローカル AI に切り替えています" };
    case "unavailable":
      return { state: "off", label: "LOCAL AI UNAVAILABLE", title: "Gemini にもローカル AI（Ollama）にも接続できません" };
    default:
      return { state: "warn", label: "CHECKING…", title: "接続を確かめています" };
  }
}

export function AiRouteBadge() {
  const { state, label, title } = aiRouteLabel(useAiRoute());
  return (
    <span className="ai-route" data-state={state} title={title} role="status">
      <i aria-hidden />
      {label}
    </span>
  );
}
