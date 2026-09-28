# F.R.I.D.A.Y. Mark3

自分専用の AI アシスタント／個人用 AI OS。

**Phase 1（現在）: 会話 AI（Chat Agent）のみ実装。**
Gemini Flash 系モデルとストリーミングで自然に会話できます。
Search / Writing / Analysis / Memory / SNS / Automation の各 Agent は UI 上の表示のみで、今後のフェーズで追加します。

---

## セットアップ

```bash
npm install
cp .env.example .env.local   # GEMINI_API_KEY を設定
npm run dev                  # http://localhost:3000
```

API キーは [Google AI Studio](https://aistudio.google.com/apikey) で発行してください。

### 環境変数（`.env.local`）

| 変数 | 必須 | 既定値 | 説明 |
| --- | --- | --- | --- |
| `GEMINI_API_KEY` | ✅ | — | Gemini API キー。サーバー側でのみ使用し、ブラウザには渡しません |
| `GEMINI_MODEL` | | `gemini-flash-latest` | 会話モデル。常に最新 Flash を指すエイリアスが既定。固定したい場合は `gemini-3.8-flash` などを指定 |
| `GEMINI_THINKING_LEVEL` | | `low` | `low` / `medium` / `high` / `off`。体感速度優先で `low`。モデルが非対応なら自動で外して再試行 |
| `GEMINI_TEMPERATURE` | | `0.8` | |
| `GEMINI_MAX_OUTPUT_TOKENS` | | `2048` | |
| `CHAT_CONTEXT_MAX_MESSAGES` | | `24` | Gemini に渡す直近の会話の最大件数 |
| `CHAT_CONTEXT_MAX_CHARS` | | `24000` | Gemini に渡す会話の最大文字数 |
| `ELEVENLABS_API_KEY` | | — | ElevenLabs の API キー（読み上げを ElevenLabs の声にする場合） |
| `ELEVENLABS_VOICE_ID` | | — | 使う声の Voice ID |
| `ELEVENLABS_SPEED` | | `1.15` | 話す速さ（0.7〜1.2） |
| `ELEVENLABS_MODEL` | | `eleven_flash_v2_5` | 音声モデル（音質重視なら `eleven_multilingual_v2`） |
| `BRAIN_GITHUB_TOKEN` | | — | Obsidian の脳（GitHub リポジトリ）用のトークン。対象リポジトリのみ・Contents: Read and write |
| `BRAIN_REPO` | | — | 脳のリポジトリ（`owner/repo`） |
| `GOOGLE_CLIENT_ID` | | — | Google カレンダー連携用の OAuth クライアント ID |
| `GOOGLE_CLIENT_SECRET` | | — | 同 クライアント シークレット（サーバー側でのみ使用） |
| `GOOGLE_CALENDAR_ID` | | `primary` | 読み書きするカレンダー |
| `FRIDAY_TIMEZONE` | | `Asia/Tokyo` | 「今日」の判断に使うタイムゾーン |

`.env.local` は `.gitignore` 済みです。API キーをソースコードに書いたりコミットしたりしないでください。

---

## 構成

```
src/
├─ app/
│  ├─ page.tsx / layout.tsx / globals.css   UI（Next.js App Router）
│  └─ api/
│     ├─ chat/route.ts      POST 会話（NDJSON ストリーミング）
│     ├─ calendar/          Google カレンダー（connect / callback / disconnect / events）
│     └─ status/route.ts    GET  Agent の稼働状態
├─ core/
│  ├─ friday.ts             F.R.I.D.A.Y. Core：入力検証 → Router → Agent → ストリーム
│  ├─ router.ts             Agent Router（現在は常に Chat Agent）と Agent レジストリ
│  └─ types.ts              共有型（クライアント／サーバー両用）
├─ agents/
│  ├─ types.ts              Agent 共通インターフェース
│  └─ chat/
│     ├─ index.ts           Chat Agent（Gemini Flash）
│     └─ persona.ts         F.R.I.D.A.Y. の人格（system instruction）
├─ llm/
│  └─ gemini.ts             Gemini REST + SSE クライアント（SDK 不使用）
├─ memory/
│  ├─ context.ts            短期記憶：会話ウィンドウの切り出し（件数・文字数上限）
│  ├─ long-term.ts          長期記憶インターフェース（脳が未設定なら Noop）
│  ├─ obsidian.ts           Obsidian の脳：関連ノートの検索・保存
│  └─ github-brain.ts       脳（GitHub リポジトリ）の読み書き・初期化
├─ integrations/
│  └─ google-calendar.ts    Google カレンダー（OAuth・予定の読み書き）
├─ lib/                     設定読み込み・エラー定義・暗号化 Cookie
├─ hooks/useChat.ts         会話ループの状態管理（ストリーム受信・停止・再試行）
├─ components/              Dashboard / Core / Orbit / Conversation / Composer ほか
└─ data/                    Agent カード定義・右パネルのサンプルデータ
```

### 会話の流れ

```
Composer ──POST /api/chat──▶ Core (friday.ts)
                               ├─ sanitizeHistory   入力検証
                               ├─ buildConversationWindow   短期記憶（上限付き）
                               ├─ routeRequest      Agent Router
                               └─ chatAgent.run
                                    ├─ LongTermMemory.recall  Obsidian の脳から関連ノート
                                    ├─ buildSystemInstruction 人格
                                    └─ streamGemini ──SSE──▶ Gemini
◀── NDJSON: meta → delta… → memory… → done / error ──
                               └─ after(): 会話ログ・記憶を脳に保存（返答後）
```

- **ストリーミング**: Gemini の `streamGenerateContent?alt=sse` を逐次パースし、そのまま NDJSON でブラウザへ流します。
- **滑らかな表示**: Gemini は数十文字の塊で届くため、ブラウザ側で「塊が届く間隔」を学習し、次の塊が届く頃にちょうど出し切る速度で文字を流します（経過時間ベースなので端末のフレームレートに依存しません）。
- **接続のウォームアップ**: 入力中に `/api/warm` を呼び、サーバーから Gemini への TLS 接続を事前に確立しておきます（送信時の接続待ちを省く）。
- **起動時チェック**: `/api/status` が Gemini に軽量な問い合わせ（models.get、トークン消費なし）を行い、API キーやモデル名の誤りを話しかける前に表示します。
- **自動再試行**: Gemini の混雑 (5xx) や瞬断は、表示を始める前なら自動で最大 2 回再試行します。
- **割り込み**: 応答中でも次の発言を送れます（今の応答を止めて次へ）。Esc で停止。
- **会話履歴**: セッション中はブラウザ（`sessionStorage`）に保持し、送信ごとにサーバーへ渡します。Gemini に渡す量はサーバー側で件数・文字数の上限をかけます。
- **短期記憶と長期記憶の分離**: `memory/context.ts`（今の会話）と `memory/long-term.ts`（Obsidian の脳）を別モジュールにしています。

### Obsidian の脳（長期記憶）

```
Obsidian（PC / スマホ） ⇄ Obsidian Git ⇄ GitHub 非公開リポジトリ ⇄ F.R.I.D.A.Y.
```

- `BRAIN_GITHUB_TOKEN` と `BRAIN_REPO` を設定すると接続されます（HUB の MEMORY カードが ONLINE）。
- 空のリポジトリなら、最初の接続時に `README.md`・`FRIDAY/プロフィール.md`・`FRIDAY/記憶.md` などを自動で作ります。
- **思い出す**: 返答の前に、プロフィールと最近の記憶は毎回、それ以外のノートは会話に関係する段落だけを探して渡します。
  探す時間は文字の会話で最大 1.5 秒、音声で最大 0.7 秒。間に合わなければ記憶なしで返答します（ノートは SHA ごとにキャッシュ）。
- **覚える**: 覚えるべきことがあると、F.R.I.D.A.Y. は返答の末尾に `<memory>…</memory>` を付けます。
  サーバーがこれを取り除いて（画面・読み上げには出ない）、返答を返し終えたあと `記憶.md` に追記します。追加の API 呼び出しはありません。
- 会話は `FRIDAY/会話ログ/YYYY-MM-DD.md` に日ごとに残ります。
- Obsidian で自分が書いたノートも、次の会話から自動的に参考にされます。

### Google カレンダー

- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` を設定すると、画面右の SCHEDULE に「Google カレンダーに接続」ボタンが出ます。
- 接続すると、Google から受け取った更新用トークンを **暗号化して HttpOnly Cookie に保存** します（その端末で有効。ブラウザの JavaScript からは読めません）。
- **読む**: 返答の前に今日から 7 日分の予定を取得して渡します（脳の検索と同時に行い、時間内に取れなければ予定なしで返答）。SCHEDULE には今日の予定を表示します。
- **書く**: 「明日 15 時に打ち合わせを入れて」と頼むと、F.R.I.D.A.Y. が返答の末尾に `<calendar>{…}</calendar>` を付け、サーバーが取り除いて Google カレンダーに登録します。
  登録できなかったときは返答の中でも知らせます（音声でも読み上げ）。予定の変更・削除は未対応。
- 権限は `calendar.events`（予定の読み書き）だけを求めます。

### 音声会話

- 入力欄の **VOICE MODE** をオンにすると「フライデー」の呼びかけを待ちます（画面を開いている間）。
- 「フライデー、〇〇」と続けて言えばそのまま送信。「フライデー」だけなら効果音のあと次の一言を聞き取ります。
- 返答は届いた文から一文ずつ読み上げます。
- 読み上げ後 8 秒間は呼びかけなしで続けて話せます。黙っていれば待機に戻ります。
- **割り込み**: 返答の読み上げ中・考え中でも、話し始めればすぐ読み上げと生成を止めてそちらを聞きます。
  スピーカーから出た自分の声は「いま読み上げている文章」と照合して無視します（ヘッドホンだとより確実）。
- マイクボタン：呼びかけなしで、その場で 1 回聞き取ります（読み上げ中なら割り込み）。
- 音声で話しかけたときは、記号や箇条書きを使わない短い話し言葉で返答するよう指示しています。
- **ElevenLabs の声（任意）**: `ELEVENLABS_API_KEY` と `ELEVENLABS_VOICE_ID` を設定すると、返答を ElevenLabs の声で読み上げます。
  一文ずつ音声を作り、再生中に次の文を先読みします。キー誤り・利用枠切れなどのときは自動でブラウザの声に切り替えます。
- 音声認識はブラウザ標準の Web Speech API を使用（追加料金なし）。PC の Chrome / Edge 推奨。
  Chrome の音声認識は音声を Google のサーバーで文字にします。

### エラー処理

| コード | 状況 |
| --- | --- |
| `MISSING_API_KEY` | `GEMINI_API_KEY` 未設定（UI にも OFFLINE バナーを表示） |
| `INVALID_API_KEY` | キーが無効・権限なし |
| `MODEL_NOT_FOUND` | `GEMINI_MODEL` が存在しない |
| `RATE_LIMITED` | レート制限（再試行ボタンあり） |
| `SAFETY_BLOCKED` | 安全フィルターでブロック |
| `NETWORK_ERROR` / `UPSTREAM_ERROR` | 通信エラー・Gemini 側エラー（再試行ボタンあり） |

どのエラーでも画面は壊れず、該当メッセージ内にエラー内容を表示します。

---

## 拡張ガイド

### 新しい Agent を追加する（例: Search Agent）

1. `src/agents/search/index.ts` に `Agent` インターフェース（`src/agents/types.ts`）を実装
2. `src/core/router.ts` の `registry` に登録し、`routeRequest` で振り分け条件を追加
   （トリガーワードではなく、軽量モデルによる意図分類で判定する想定）
3. `src/data/agents.ts` の該当カードの `phase` を `"live"` に

### 長期記憶の仕組みを差し替える

`src/memory/long-term.ts` の `LongTermMemory`（`recall` / `save`）を実装したクラスを `getLongTermMemory()` で返せば、
Chat Agent は取得した記憶を system instruction に含めて応答します（将来の Memory AI / ベクトル検索など）。

### 人格を調整する

`src/agents/chat/persona.ts` を編集してください。

---

## 今回のスコープ外

- 検索・文書作成・分析・SNS・Automation の各 Agent
- 音声入力・ファイル添付・画像生成
- 右パネルの天気・プロジェクトは **SAMPLE** 表示のみ（予定は Google カレンダー接続時に実データ）
- Claude API / OpenAI API は使用していません
