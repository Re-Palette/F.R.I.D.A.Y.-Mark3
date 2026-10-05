"use client";

/** 資料・スライドを PDF・PowerPoint で保存するボタン（作るのはブラウザの中） */
import { useState } from "react";
import type { DocKind } from "@/core/types";
import { downloadDoc } from "@/lib/doc-export";

export function DocExport({ doc, compact }: { doc: { title: string; content?: string; kind?: DocKind }; compact?: boolean }) {
  const [busy, setBusy] = useState<"pdf" | "pptx" | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!doc.kind || !doc.content) return null;
  const run = (ext: "pdf" | "pptx") => {
    setBusy(ext);
    setError(null);
    void downloadDoc(doc, ext)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "作れませんでした。"))
      .finally(() => setBusy(null));
  };
  return (
    <span className="doc-export" data-compact={compact || undefined}>
      <button type="button" className="ghost-btn" disabled={busy !== null} onClick={() => run("pdf")}>
        {busy === "pdf" ? "作成中…" : doc.kind === "slides" ? "スライド（PDF）" : "PDF を保存"}
      </button>
      {doc.kind === "slides" && (
        <button type="button" className="ghost-btn" disabled={busy !== null} onClick={() => run("pptx")}>
          {busy === "pptx" ? "作成中…" : "PowerPoint"}
        </button>
      )}
      {error && <em className="doc-export__error">{error}</em>}
    </span>
  );
}
