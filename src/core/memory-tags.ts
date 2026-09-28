/**
 * 返答に含まれる <memory>…</memory> を取り除き、中身（覚えるべきこと）を取り出す。
 * ストリーミング中に使うため、タグの途中で塊が切れても正しく扱う（タグの可能性がある部分は次の塊まで保留）。
 * タグの中身は画面にも読み上げにも出さない。
 */
const OPEN = "<memory>";
const CLOSE = "</memory>";
const MAX_FACT_CHARS = 200;
const MAX_FACTS = 3;

/** text の末尾が tag の先頭部分と一致する長さ（例: "…<mem" と "<memory>" → 4） */
function partialSuffix(text: string, tag: string): number {
  const lower = text.slice(-tag.length).toLowerCase();
  for (let n = Math.min(lower.length, tag.length - 1); n > 0; n--) {
    if (lower.endsWith(tag.slice(0, n))) return n;
  }
  return 0;
}

export class MemoryTagFilter {
  private buf = "";
  private inTag = false;
  private tagText = "";
  readonly facts: string[] = [];

  /** 塊を受け取り、表示してよいテキストを返す */
  push(chunk: string): string {
    this.buf += chunk;
    let out = "";
    while (this.buf) {
      if (!this.inTag) {
        const i = this.buf.toLowerCase().indexOf(OPEN);
        if (i >= 0) {
          out += this.buf.slice(0, i);
          this.buf = this.buf.slice(i + OPEN.length);
          this.inTag = true;
          this.tagText = "";
          continue;
        }
        const hold = partialSuffix(this.buf, OPEN);
        out += this.buf.slice(0, this.buf.length - hold);
        this.buf = this.buf.slice(this.buf.length - hold);
        break;
      }
      const j = this.buf.toLowerCase().indexOf(CLOSE);
      if (j >= 0) {
        this.addFact(this.tagText + this.buf.slice(0, j));
        this.buf = this.buf.slice(j + CLOSE.length);
        this.inTag = false;
        continue;
      }
      const hold = partialSuffix(this.buf, CLOSE);
      this.tagText += this.buf.slice(0, this.buf.length - hold);
      this.buf = this.buf.slice(this.buf.length - hold);
      break;
    }
    return out;
  }

  /** ストリームの終わり。保留していた普通の文字を返す（閉じられていないタグは捨てる） */
  flush(): string {
    const rest = this.inTag ? "" : this.buf;
    this.buf = "";
    this.inTag = false;
    this.tagText = "";
    return rest;
  }

  private addFact(raw: string) {
    const fact = raw.replace(/\s+/g, " ").replace(/^[-・*\s]+/, "").trim().slice(0, MAX_FACT_CHARS);
    if (fact && this.facts.length < MAX_FACTS && !this.facts.includes(fact)) this.facts.push(fact);
  }
}
