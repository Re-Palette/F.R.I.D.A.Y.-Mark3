/**
 * 「前回の結果をすぐ返し、古ければ裏で取り直す」キャッシュ（stale-while-revalidate）。
 * 返答前に外部サービス（GitHub・Google など）を待たないためのもの。サーバー専用。
 *
 *   fresh 以内 … キャッシュをそのまま返す
 *   maxAge 以内 … キャッシュを返しつつ、裏で取り直す
 *   それより古い / 無い … 取得を待つ
 */
interface Entry<T> {
  value?: T;
  at: number;
  pending?: Promise<T>;
}

const store = new Map<string, Entry<unknown>>();

export async function swr<T>(key: string, fresh: number, maxAge: number, load: () => Promise<T>): Promise<T> {
  const entry = (store.get(key) as Entry<T> | undefined) ?? { at: 0 };
  store.set(key, entry);
  const age = Date.now() - entry.at;

  const refresh = () => {
    entry.pending ??= load()
      .then((value) => {
        entry.value = value;
        entry.at = Date.now();
        return value;
      })
      .finally(() => {
        entry.pending = undefined;
      });
    return entry.pending;
  };

  if (entry.value !== undefined && age < fresh) return entry.value;
  if (entry.value !== undefined && age < maxAge) {
    refresh().catch(() => {}); // 裏で取り直す（失敗しても古い値で続ける）
    return entry.value;
  }
  return refresh();
}

/** キャッシュにある値を待たずに返す（無ければ undefined） */
export function peek<T>(key: string): T | undefined {
  return (store.get(key) as Entry<T> | undefined)?.value;
}

/** 書き込んだ直後の値をキャッシュに入れる（読み直しを待たずに新しい値を使うため） */
export function prime<T>(key: string, value: T): void {
  store.set(key, { value, at: Date.now() });
}

/** key が prefix で始まるキャッシュを捨てる（書き込んだ直後など） */
export function invalidate(prefix: string): void {
  for (const key of store.keys()) if (key.startsWith(prefix)) store.delete(key);
}

/**
 * 「まず最新を取りに行き、間に合わなければ前回の値」で返すキャッシュ（予定など、古いままだと困るもの用）。
 *
 *   fresh 以内 … キャッシュをそのまま返す（すぐ）
 *   それ以外 … 取り直しを始め、wait まで待つ。間に合えば最新、間に合わなければ前回の値（無ければ取れるまで待つ）
 *   取り直しに失敗 … 前回の値があればそれ、無ければ失敗を投げる
 * 取り直しは裏で最後まで走り、次の呼び出しのためにキャッシュを新しくする。at は値を取った時刻。
 */
export async function latest<T>(key: string, fresh: number, wait: number, load: () => Promise<T>): Promise<{ value: T; at: number }> {
  const entry = (store.get(key) as Entry<T> | undefined) ?? { at: 0 };
  store.set(key, entry);
  if (entry.value !== undefined && Date.now() - entry.at < fresh) return { value: entry.value, at: entry.at };

  entry.pending ??= load()
    .then((value) => {
      entry.value = value;
      entry.at = Date.now();
      return value;
    })
    .finally(() => {
      entry.pending = undefined;
    });
  const pending = entry.pending.then((value) => ({ value, at: entry.at }));
  if (entry.value === undefined) return pending; // 前回の値が無いので、取れるまで待つ

  const stale = { value: entry.value, at: entry.at };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<{ value: T; at: number }>((resolve) => {
    timer = setTimeout(() => resolve(stale), wait);
  });
  try {
    return await Promise.race([pending.catch(() => stale), late]);
  } finally {
    clearTimeout(timer);
  }
}
