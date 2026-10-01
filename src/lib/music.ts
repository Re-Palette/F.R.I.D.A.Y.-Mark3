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
