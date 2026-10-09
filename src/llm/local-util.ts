/**
 * ローカル AI（LM Studio・Ollama）で共通に使う小さな部品。ほかのファイルに依存しない（テストでもそのまま読める）。
 */

/** この PC の中を指す URL か（外部の URL は使わない） */
export function isLoopbackUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    return u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]" || u.hostname === "::1";
  } catch {
    return false;
  }
}

/** 考えている途中の文（<think>…</think>）を取り除く。塊の途中でタグが切れても扱える */
export class ThinkFilter {
  private inThink = false;
  private pending = "";
  push(text: string): string {
    let s = this.pending + text;
    this.pending = "";
    let out = "";
    while (s) {
      if (this.inThink) {
        const end = s.indexOf("</think>");
        if (end < 0) {
          this.pending = s.slice(-7); // 閉じタグの書きかけを残す
          return out;
        }
        s = s.slice(end + 8);
        this.inThink = false;
        continue;
      }
      const start = s.indexOf("<think>");
      if (start < 0) {
        // 開きタグの書きかけかもしれない末尾は保留
        const lt = s.lastIndexOf("<");
        if (lt >= 0 && "<think>".startsWith(s.slice(lt))) {
          out += s.slice(0, lt);
          this.pending = s.slice(lt);
        } else out += s;
        return out;
      }
      out += s.slice(0, start);
      s = s.slice(start + 7);
      this.inThink = true;
    }
    return out;
  }
  flush(): string {
    const rest = this.inThink ? "" : this.pending;
    this.pending = "";
    return rest;
  }
}

