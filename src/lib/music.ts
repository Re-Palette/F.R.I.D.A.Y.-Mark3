/**
 * 音楽の操作（画面・サーバー両用。依存なし）。
 *   Amazon Music：Chrome 拡張機能（extension/）が Web プレーヤー（music.amazon.co.jp）のタブを操作する（画面側で実行）
 *   Spotify：接続していればサーバーが Spotify Web API で操作する
 */

export type MusicKind = "track" | "playlist" | "album" | "artist";

export interface MusicCommand {
  action: "play" | "pause" | "resume" | "next" | "previous" | "volume" | "shuffle";
  /** play: 探す言葉（無ければ、止めた所から再開） */
  query?: string;
  kind?: MusicKind;
  /** volume: 0〜100、または "up" / "down" */
  value?: number | "up" | "down";
  /** shuffle: オン / オフ */
  on?: boolean;
}

/** いま流れている曲（Amazon Music のタブ・Spotify から） */
export interface NowPlaying {
  playing: boolean;
  title?: string;
  artist?: string;
  device?: string;
  volume?: number;
  shuffle?: boolean;
}

/** 画面からサーバーへ渡す、Amazon Music の状態（音楽の話のときだけ） */
export interface AmazonMusicState {
  /** 拡張機能が入っているか（入っていなければ操作できない） */
  ext: boolean;
  /** Amazon Music のタブで流れている曲（タブが無ければ null） */
  now?: NowPlaying | null;
}

/** 音楽について話しているか（「〇〇かけて」「次の曲」「音量」「Amazon Music」など） */
export function asksForMusic(text: string): boolean {
  return /spotify|スポティファイ|amazon ?music|アマゾンミュージック|アマミュ|音楽|曲|BGM|ＢＧＭ|プレイリスト|アルバム|かけて|流して|再生|一時停止|止めて|音量|ボリューム|シャッフル|スキップ|聴きたい|聞きたい|再開|続きから|ミュート/i.test(
    text,
  );
}

/**
 * すぐに実行できる、短い音楽の操作（「止めて」「次の曲」「音量下げて」など）。
 * これだけの発言なら、AI に聞かずに画面で直接 Amazon Music を操作する（声で素早く操作できるように）。
 * 「止めて」「ストップ」だけのときは、F.R.I.D.A.Y. を止めたいだけかもしれないので、音楽が流れているときだけ使う（ifPlaying）。
 */
export function quickMusicCommand(text: string): { cmd: MusicCommand; ifPlaying?: boolean } | null {
  const s = text
    .replace(/[\s、。,.!！?？〜~]/g, "")
    .replace(/(ください|ちょうだい|お願い|おねがい)$/, "")
    .replace(/^(音楽|曲|BGM|ＢＧＭ|アマゾンミュージック|AmazonMusic)(を|は)?/i, (m) => `${m.replace(/(を|は)$/, "")}:`);
  const music = s.includes(":");
  const body = s.replace(/^[^:]*:/, "");
  if (/^(一時停止|ポーズ)(して)?$/.test(body)) return { cmd: { action: "pause" } };
  if (/^(止めて|とめて|停止(して)?|ストップ(して)?)$/.test(body)) return { cmd: { action: "pause" }, ifPlaying: !music };
  if (/^(再開|続きから|続きを?流して|続きを?かけて)(して)?$/.test(body) || (music && /^(再生|流して|かけて)(して)?$/.test(body)))
    return { cmd: { action: "resume" } };
  if (/^(次の曲|次|スキップ|曲を?飛ばして|曲を?スキップ)(に|へ)?(して|いって)?$/.test(body)) return { cmd: { action: "next" } };
  if (/^(前の曲|ひとつ前の曲|一つ前の曲)(に|へ)?(して|戻して|いって)?$|^曲を?戻して$/.test(body)) return { cmd: { action: "previous" } };
  if (/^(音量|ボリューム|音)を?(上げて|大きくして|大きく)$/.test(body)) return { cmd: { action: "volume", value: "up" } };
  if (/^(音量|ボリューム|音)を?(下げて|小さくして|小さく)$/.test(body)) return { cmd: { action: "volume", value: "down" } };
  return null;
}
