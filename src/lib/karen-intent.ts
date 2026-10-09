/**
 * K.A.R.E.N. への指示の読み取り（この端末で決まった形だけを見分ける。依存なし・テストでそのまま読める）。
 *
 * 1 つの発言を「、」「そして」などで区切り、順番に操作にする。
 *   「球体を作って、青くして、少し大きくして」→ 球体を足す → 青にする → 1.1 倍
 * 何を作るか分からないとき（「3D ホログラムを作成して」「この商品の 3D モデル」）は決めつけずに聞き返す。
 * 制作の指示でないもの（質問・雑談）は chat として AI（K.A.R.E.N. の人格）に渡す。
 * 道具がまだ無いもの（Web サイトのデザイン・アニメーション制作など）は unsupported として、未実装だと伝える。
 */

export type Shape = "sphere" | "box" | "cylinder" | "cone" | "torus";

export type KarenOp =
  /** 〇〇の 3D モデル・ホログラムを作る（既存のモデルを探し、無ければ部品で組み立てる） */
  | { kind: "create-model"; subject: string }
  /** 基本の形を足す */
  | { kind: "add-primitive"; shape: Shape }
  | { kind: "color"; color: string; label: string }
  | { kind: "scale"; factor: number }
  | { kind: "rotate"; axis: "x" | "y" | "z"; deg: number }
  | { kind: "move"; axis: "x" | "y" | "z"; amount: number }
  | { kind: "delete" }
  | { kind: "clear" }
  | { kind: "reset-view" }
  | { kind: "save" }
  | { kind: "export" }
  | { kind: "render" }
  | { kind: "turntable"; on: boolean }
  /** 道具がまだ無い制作（未実装と伝える） */
  | { kind: "unsupported"; what: string }
  | { kind: "cancel" }
  /** 待機（中央の球）に戻る */
  | { kind: "idle" }
  /** 次の制作を始める（何を作るか聞く） */
  | { kind: "next" }
  /** 足りない情報を聞き返す */
  | { kind: "ask"; question: string };

export interface KarenParse {
  /** 制作・編集の操作（順番に実行する） */
  ops: KarenOp[];
  /** 制作・編集ではない（質問・雑談）→ AI に渡す */
  chat: boolean;
}

const SHAPES: [RegExp, Shape, string][] = [
  [/(球体|球|スフィア|sphere)/i, "sphere", "球体"],
  [/(立方体|箱|ボックス|キューブ|cube|box)/i, "box", "立方体"],
  [/(円柱|シリンダー|cylinder)/i, "cylinder", "円柱"],
  [/(円錐|コーン|cone)/i, "cone", "円錐"],
  [/(トーラス|ドーナツ型?|リング状|torus)/i, "torus", "トーラス"],
];

export const SHAPE_LABEL: Record<Shape, string> = { sphere: "球体", box: "立方体", cylinder: "円柱", cone: "円錐", torus: "トーラス" };

const COLORS: [RegExp, string, string][] = [
  [/(水色|シアン|cyan)/i, "#2ee6ff", "水色"],
  [/(青|ブルー|blue)/i, "#2f7bff", "青"],
  [/(紺|ネイビー)/i, "#1f3c99", "紺"],
  [/(白|ホワイト|white)/i, "#f2f7ff", "白"],
  [/(黒|ブラック|black)/i, "#2a2f38", "黒"],
  [/(灰色|グレー|gray|grey)/i, "#8a94a6", "グレー"],
  [/(緑|グリーン|green)/i, "#2fd27a", "緑"],
  [/(紫|パープル|purple)/i, "#9b5cff", "紫"],
  [/(ピンク|pink)/i, "#ff6fb5", "ピンク"],
  [/(赤|レッド|red)/i, "#ff4040", "赤"],
  [/(オレンジ|橙|orange)/i, "#ff8a1f", "オレンジ"],
  [/(黄|イエロー|yellow)/i, "#ffd33d", "黄色"],
  [/(金|ゴールド|gold)/i, "#d4af37", "金色"],
  [/(銀|シルバー|silver)/i, "#c0c8d4", "銀色"],
];

const CREATE = /(作って|つくって|作成|生成|作りたい|つくりたい|作る|つくる|作れ|作ろう|モデリングして|組み立てて|用意して|出して|見せて)/;
const EDIT_VERB = /(して|にして|させて|しろ|に変え|に変更|お願い)/;

/** 区切る（「、」「。」「そして」「それから」「あと」「で、」） */
function clauses(text: string): string[] {
  return text
    .replace(/(そして|それから|そのあと|その後|次に|あとは|あと、)/g, "、")
    .split(/[、。,，\n]|(?<=て)\s+/)
    .map((c) => c.trim())
    .filter(Boolean);
}

/** 「〇〇の 3D ホログラム／モデル」「〇〇を作って」から〇〇を取り出す */
function subjectOf(c: string): string {
  let s = c.replace(/^(k\.?a\.?r\.?e\.?n\.?|カレン)[、,\s]*/i, "");
  // 作る言葉より前だけを見る
  const verb = CREATE.exec(s);
  if (verb) s = s.slice(0, verb.index);
  const strip = (x: string) =>
    x
      .trim()
      .replace(/(を|に|で|は)$/, "")
      .replace(/(の)?(3D|３D|３Ｄ|立体)?(で)?$/i, "")
      .replace(/(の)?(3D|３D|３Ｄ|立体)?(ホログラム|モデル|シーン|オブジェクト|データ)$/i, "")
      .trim();
  for (let i = 0; i < 4; i++) {
    const next = strip(s);
    if (next === s) break;
    s = next;
  }
  return s.replace(/^(新しい|あたらしい|ちょっと|ひとつ|一つ|1つ)/, "").trim();
}

function scaleOf(c: string): number | null {
  const times = /([0-9０-９.]+)\s*倍/.exec(c);
  if (times) {
    const n = Number(times[1].replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0)));
    if (Number.isFinite(n) && n > 0) return Math.min(10, Math.max(0.1, n));
  }
  const bigger = /(大きく|おおきく|でかく|拡大)/.test(c);
  const smaller = /(小さく|ちいさく|縮小|ちっちゃく)/.test(c);
  if (!bigger && !smaller) return null;
  const k = /(少し|ちょっと|やや|すこし|わずかに)/.test(c) ? 0.1 : /(もっと|かなり|すごく|うんと|とても|大幅)/.test(c) ? 0.5 : 0.25;
  return bigger ? 1 + k : 1 / (1 + k);
}

function rotateOf(c: string): KarenOp | null {
  if (!/(回して|回転|まわして|向きを変え|傾け)/.test(c)) return null;
  if (/(アニメーション|ずっと|回し続け|ターンテーブル|くるくる)/.test(c)) return null;
  const deg = /(-?[0-9０-９]+)\s*度/.exec(c);
  const n = deg ? Number(deg[1].replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0))) : 45;
  const axis = /(縦|上下|前後|x軸|X軸)/.test(c) ? "x" : /(z軸|Z軸|横に傾け)/.test(c) ? "z" : "y";
  const sign = /(左|反時計)/.test(c) ? -1 : 1;
  return { kind: "rotate", axis, deg: Math.max(-360, Math.min(360, n)) * sign };
}

function moveOf(c: string): KarenOp | null {
  if (!/(動かして|移動|ずらして|寄せて|持ち上げ|下げて|上げて)/.test(c)) return null;
  const k = /(少し|ちょっと|やや|すこし)/.test(c) ? 0.25 : /(もっと|かなり|大きく)/.test(c) ? 1 : 0.5;
  if (/(右)/.test(c)) return { kind: "move", axis: "x", amount: k };
  if (/(左)/.test(c)) return { kind: "move", axis: "x", amount: -k };
  if (/(上|持ち上げ|上げて)/.test(c)) return { kind: "move", axis: "y", amount: k };
  if (/(下)/.test(c)) return { kind: "move", axis: "y", amount: -k };
  if (/(手前|前)/.test(c)) return { kind: "move", axis: "z", amount: k };
  if (/(奥|後ろ|うしろ)/.test(c)) return { kind: "move", axis: "z", amount: -k };
  return { kind: "ask", question: "どちらに動かしますか？（右・左・上・下・手前・奥）" };
}

function colorOf(c: string): KarenOp | null {
  if (!/(色|くして|にして|に変え|に変更|に塗|塗って|カラー)/.test(c)) return null;
  for (const [re, color, label] of COLORS) if (re.test(c)) return { kind: "color", color, label };
  if (/色/.test(c)) return { kind: "ask", question: "何色にしますか？" };
  return null;
}

/** 1 つの区切りを操作にする（読めなければ null） */
function clauseOp(c: string): KarenOp | null {
  if (/^(キャンセル|中止|やめて|止めて|ストップ)/.test(c) || /(制作|作成|生成|処理)(を)?(キャンセル|中止|止めて|やめて|ストップ)/.test(c)) return { kind: "cancel" };
  if (/(待機|球に戻|最初の画面に戻|ホームに戻)/.test(c)) return { kind: "idle" };
  if (/(次の制作|次を作|新しい制作|別のを作)/.test(c)) return { kind: "next" };
  if (/(全部|すべて|全て|ぜんぶ)(の)?(オブジェクト|モデル)?(を)?(消|削除|クリア)/.test(c) || /(シーン|ワークスペース)(を)?(クリア|リセット|空に)/.test(c)) return { kind: "clear" };
  if (/(視点|カメラ|ビュー|見え方)(を)?(リセット|戻|元に)/.test(c) || /^リセット/.test(c)) return { kind: "reset-view" };
  if (/(保存|セーブ)/.test(c)) return { kind: "save" };
  if (/(エクスポート|書き出|glb|GLB|ダウンロード)/.test(c)) return { kind: "export" };
  if (/(レンダリング|レンダー|render|スクショ|画像(で|に)(保存|して|出して))/i.test(c)) return { kind: "render" };
  if (/(ターンテーブル|回転アニメーション|回し続け|くるくる回)/.test(c)) return { kind: "turntable", on: !/(止め|やめ|オフ|停止)/.test(c) };
  if (/(消して|削除|けして|取り除|なくして)/.test(c) && !CREATE.test(c)) return { kind: "delete" };

  // 道具がまだ無い制作
  if (CREATE.test(c) || /デザイン/.test(c)) {
    if (/(web|ウェブ|ホームページ|サイト|lp|ランディング)/i.test(c)) return { kind: "unsupported", what: "Web サイトのデザイン" };
    if (/(ロゴ|ポスター|バナー|イラスト|画像|絵|チラシ|デザイン)/.test(c) && !/(3D|３D|立体|ホログラム|モデル)/i.test(c)) return { kind: "unsupported", what: "2D のデザイン（画像・ロゴ・ポスターなど）" };
    if (/(アニメーション|動画|ムービー)/.test(c)) return { kind: "unsupported", what: "アニメーション・動画の制作" };
    if (/(テクスチャ|マテリアル|質感)/.test(c)) return { kind: "unsupported", what: "テクスチャ・質感の編集" };
  }

  const rotate = rotateOf(c);
  if (rotate) return rotate;
  const move = moveOf(c);
  if (move) return move;
  const scale = scaleOf(c);
  const color = colorOf(c);
  if (scale && !CREATE.test(c)) return { kind: "scale", factor: scale };

  if (CREATE.test(c)) {
    for (const [re, shape] of SHAPES) {
      // 「球体を作って」「青い立方体を作って」（「地球のモデル」などは除く）
      const m = re.exec(c);
      if (m && subjectOf(c).replace(/(青い|赤い|白い|黒い|大きい|小さい|ひとつ|一つ|1つ)/g, "").replace(/(の)?(形|かたち)/, "").trim() === m[0]) return { kind: "add-primitive", shape };
    }
    const subject = subjectOf(c);
    if (!subject || /^(何か|なにか|なんか|適当な?|もの|もの?を?)$/.test(subject)) return { kind: "ask", question: "何の 3D ホログラム（3D モデル）を作りますか？" };
    if (/^(この|その|あの|これ|それ|あれ)/.test(subject)) return { kind: "ask", question: `「${subject}」が何を指すか分かりませんでした。作りたいものの名前を教えてください（例：スニーカー、ロケット）。` };
    return { kind: "create-model", subject: subject.slice(0, 40) };
  }
  if (color && EDIT_VERB.test(c)) return color;
  if (color?.kind === "ask") return color;
  return null;
}

/** 発言を K.A.R.E.N. の操作にする */
export function parseKarenCommand(text: string): KarenParse {
  const t = text.trim();
  if (!t) return { ops: [], chat: false };
  // 質問（「〇〇ってどうやって作るの？」）は制作ではなく会話
  if (/(どうやって|どうすれば|とは|って何|ってなに|教えて|なぜ|なんで|できる？|できますか|ですか？?$|の？$)/.test(t) && !/(して|して$|しろ)$/.test(t)) {
    return { ops: [], chat: true };
  }
  const ops: KarenOp[] = [];
  for (const c of clauses(t)) {
    const op = clauseOp(c);
    if (op) {
      // 「青い球体を作って」のように、作るのと同じ区切りに色・大きさが入っていたら、続けて当てる
      ops.push(op);
      if (op.kind === "add-primitive") {
        const color = COLORS.find(([re]) => re.test(c));
        if (color) ops.push({ kind: "color", color: color[1], label: color[2] });
        if (/(大きい|大きな)/.test(c)) ops.push({ kind: "scale", factor: 1.5 });
        if (/(小さい|小さな)/.test(c)) ops.push({ kind: "scale", factor: 0.6 });
      }
    }
  }
  if (!ops.length) return { ops: [], chat: true };
  return { ops, chat: false };
}

/** 中央を制作の画面に切り替える操作か（作る・編集する）。待機に戻る・保存などは切り替えない */
export function startsCreation(op: KarenOp): boolean {
  return op.kind === "create-model" || op.kind === "add-primitive";
}

/** 画面に出す、指示の要約（「未来都市の 3D ホログラムを作成」） */
export function describeOp(op: KarenOp): string {
  switch (op.kind) {
    case "create-model":
      return `${op.subject}の 3D ホログラムを作成`;
    case "add-primitive":
      return `${SHAPE_LABEL[op.shape]}を作成`;
    case "color":
      return `${op.label}に変更`;
    case "scale":
      return op.factor >= 1 ? `${op.factor.toFixed(2)} 倍に拡大` : `${op.factor.toFixed(2)} 倍に縮小`;
    case "rotate":
      return `${op.axis.toUpperCase()} 軸に ${op.deg}° 回転`;
    case "move":
      return `${op.axis.toUpperCase()} 方向に ${op.amount > 0 ? "+" : ""}${op.amount} 移動`;
    case "delete":
      return "選んだオブジェクトを削除";
    case "clear":
      return "すべてのオブジェクトを削除";
    case "reset-view":
      return "視点をリセット";
    case "save":
      return "プロジェクトを保存";
    case "export":
      return "GLB で書き出し";
    case "render":
      return "画像を書き出し（PNG）";
    case "turntable":
      return op.on ? "回転アニメーション（ターンテーブル）開始" : "回転アニメーション停止";
    case "unsupported":
      return `${op.what}（未実装）`;
    case "cancel":
      return "制作をキャンセル";
    case "idle":
      return "待機状態に戻る";
    case "next":
      return "次の制作を開始";
    case "ask":
      return op.question;
  }
}
