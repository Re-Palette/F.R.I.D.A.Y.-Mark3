/**
 * 返答に含まれる隠しタグ（<memory>…</memory>、<document title="…">…</document> など）を取り除き、中身を取り出す。
 * ストリーミング中に使うため、タグの途中で塊が切れても正しく扱う（タグの可能性がある部分は次の塊まで保留）。
 * タグの中身は画面にも読み上げにも出さない。
 */
const DEFAULT_MAX_CHARS = 1000;
const MAX_PER_TAG = 3;
/** 開きタグの書きかけ（属性つき）を保留する上限。これを超えたらタグではないとみなして表示する */
const MAX_PENDING_OPEN = 400;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** text の末尾が、どれかの tag の先頭部分と一致する最大の長さ（例: "…<mem" と "</memory>" → 4） */
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

/** title="…" folder='…' のような属性を読む */
function parseAttrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of raw.matchAll(/([a-zA-Z][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
    out[m[1].toLowerCase()] = (m[2] ?? m[3] ?? m[4] ?? "").trim();
  }
  return out;
}

export class TagFilter<T extends string> {
  private buf = "";
  private open: T | null = null;
  private openAttrs: Record<string, string> = {};
  private inner = "";
  private readonly openRes: RegExp[];
  /** 取り出した中身（タグ名ごと） */
  readonly captures: Record<T, string[]>;
  /** 取り出した中身の属性（captures と同じ並び） */
  readonly attrs: Record<T, Record<string, string>[]>;

  constructor(
    private readonly names: readonly T[],
    private readonly limits: Partial<Record<T, number>> = {},
  ) {
    this.openRes = names.map((n) => new RegExp(`<${escape(n)}(\\s[^<>]*)?>`, "i"));
    this.captures = Object.fromEntries(names.map((n) => [n, []])) as unknown as Record<T, string[]>;
    this.attrs = Object.fromEntries(names.map((n) => [n, []])) as unknown as Record<T, Record<string, string>[]>;
  }

  /** 開きタグを書いている途中かもしれない末尾の長さ（"<docu" や '<document title="企' など） */
  private pendingOpen(): number {
    const idx = this.buf.lastIndexOf("<");
    if (idx < 0) return 0;
    const tail = this.buf.slice(idx).toLowerCase();
    if (tail.includes(">") || tail.length > MAX_PENDING_OPEN) return 0;
    const maybe = this.names.some((n) => {
      const open = `<${n}`;
      return open.startsWith(tail) || (tail.startsWith(open) && /\s/.test(tail[open.length] ?? ""));
    });
    return maybe ? this.buf.length - idx : 0;
  }

  /** 塊を受け取り、表示してよいテキストを返す */
  push(chunk: string): string {
    this.buf += chunk;
    let out = "";
    while (this.buf) {
      if (!this.open) {
        // 一番手前にある開きタグを探す
        let best: { at: number; len: number; name: T; attrs: string } | null = null;
        this.openRes.forEach((re, i) => {
          const m = re.exec(this.buf);
          if (m && (!best || m.index < best.at)) best = { at: m.index, len: m[0].length, name: this.names[i], attrs: m[1] ?? "" };
        });
        if (best) {
          const b = best as { at: number; len: number; name: T; attrs: string };
          out += this.buf.slice(0, b.at);
          this.buf = this.buf.slice(b.at + b.len);
          this.open = b.name;
          this.openAttrs = parseAttrs(b.attrs);
          this.inner = "";
          continue;
        }
        const hold = this.pendingOpen();
        out += this.buf.slice(0, this.buf.length - hold);
        this.buf = this.buf.slice(this.buf.length - hold);
        break;
      }
      const close = `</${this.open}>`;
      const j = this.buf.toLowerCase().indexOf(close);
      if (j >= 0) {
        this.capture(this.open, this.inner + this.buf.slice(0, j), this.openAttrs);
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

  private capture(name: T, raw: string, attrs: Record<string, string>) {
    const list = this.captures[name];
    const text = raw.trim().slice(0, this.limits[name] ?? DEFAULT_MAX_CHARS);
    if ((!text && !Object.keys(attrs).length) || list.length >= MAX_PER_TAG || list.includes(text)) return;
    list.push(text);
    this.attrs[name].push(attrs);
  }
}

/** <memory> の中身を、記憶として保存する 1 文に整える */
export function toFact(raw: string): string {
  return raw.replace(/\s+/g, " ").replace(/^[-・*\s]+/, "").trim().slice(0, 200);
}
