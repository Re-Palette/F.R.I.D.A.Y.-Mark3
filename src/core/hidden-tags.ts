/**
 * 返答に含まれる隠しタグ（<memory>…</memory>、<calendar>…</calendar> など）を取り除き、中身を取り出す。
 * ストリーミング中に使うため、タグの途中で塊が切れても正しく扱う（タグの可能性がある部分は次の塊まで保留）。
 * タグの中身は画面にも読み上げにも出さない。
 */
const MAX_CAPTURE_CHARS = 1000;
const MAX_PER_TAG = 3;

/** text の末尾が、どれかの tag の先頭部分と一致する最大の長さ（例: "…<mem" と "<memory>" → 4） */
function partialSuffix(text: string, tags: string[]): number {
  const lower = text.toLowerCase();
  let best = 0;
  for (const tag of tags) {
    for (let n = Math.min(lower.length, tag.length - 1); n > best; n--) {
      if (lower.endsWith(tag.slice(0, n))) {
        best = n;
        break;
      }
    }
  }
  return best;
}

export class TagFilter<T extends string> {
  private buf = "";
  private open: T | null = null;
  private inner = "";
  private readonly opens: string[];
  readonly captures: Record<T, string[]>;

  constructor(private readonly names: readonly T[]) {
    this.opens = names.map((n) => `<${n}>`);
    this.captures = Object.fromEntries(names.map((n) => [n, []])) as unknown as Record<T, string[]>;
  }

  /** 塊を受け取り、表示してよいテキストを返す */
  push(chunk: string): string {
    this.buf += chunk;
    let out = "";
    while (this.buf) {
      const lower = this.buf.toLowerCase();
      if (!this.open) {
        // 一番手前にある開きタグを探す
        let at = -1;
        let name: T | null = null;
        this.names.forEach((n, i) => {
          const j = lower.indexOf(this.opens[i]);
          if (j >= 0 && (at < 0 || j < at)) {
            at = j;
            name = n;
          }
        });
        if (name) {
          out += this.buf.slice(0, at);
          this.buf = this.buf.slice(at + (name as string).length + 2);
          this.open = name;
          this.inner = "";
          continue;
        }
        const hold = partialSuffix(this.buf, this.opens);
        out += this.buf.slice(0, this.buf.length - hold);
        this.buf = this.buf.slice(this.buf.length - hold);
        break;
      }
      const close = `</${this.open}>`;
      const j = lower.indexOf(close);
      if (j >= 0) {
        this.capture(this.open, this.inner + this.buf.slice(0, j));
        this.buf = this.buf.slice(j + close.length);
        this.open = null;
        continue;
      }
      const hold = partialSuffix(this.buf, [close]);
      this.inner += this.buf.slice(0, this.buf.length - hold);
      this.buf = this.buf.slice(this.buf.length - hold);
      break;
    }
    return out;
  }

  /** ストリームの終わり。保留していた普通の文字を返す（閉じられていないタグは捨てる） */
  flush(): string {
    const rest = this.open ? "" : this.buf;
    this.buf = "";
    this.open = null;
    this.inner = "";
    return rest;
  }

  private capture(name: T, raw: string) {
    const list = this.captures[name];
    const text = raw.trim().slice(0, MAX_CAPTURE_CHARS);
    if (text && list.length < MAX_PER_TAG && !list.includes(text)) list.push(text);
  }
}

/** <memory> の中身を、記憶として保存する 1 文に整える */
export function toFact(raw: string): string {
  return raw.replace(/\s+/g, " ").replace(/^[-・*\s]+/, "").trim().slice(0, 200);
}
