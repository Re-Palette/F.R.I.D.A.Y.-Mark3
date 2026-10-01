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
| `WEATHER_CITY` / `WEATHER_LATITUDE` / `WEATHER_LONGITUDE` | | 東京 | 天気の場所（Open-Meteo・登録不要） |
| `FRIDAY_SEARCH` | | `auto` | Web 検索。`auto`（必要なときだけ）/ `always` / `off` |
| `NEWS_TIME` / `NEWS_TOPICS` | | `07:00` / なし | 毎日のニュースの時間と興味のある分野（脳の「ニュース」ノートが優先） |
| `CRON_SECRET` | | — | 毎夜の自動日記・プッシュ通知の定期実行用の合言葉 |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | | — | プッシュ通知の鍵（SETTINGS → PUSH の「鍵を作る」で作成） |
| `VAPID_SUBJECT` | | `mailto:friday@example.com` | プッシュ通知の送り主（`mailto:自分のメール`） |
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
- **自動再試行・切り替え**: Gemini の混雑 (5xx) や瞬断は、表示を始める前なら同じモデルでもう一度試し、
  それでも混んでいれば **次のモデル（`GEMINI_MODEL` の 2 番目以降 → 予備の `GEMINI_BACKUP_MODELS`）に自動で切り替え** ます。
  混雑したモデルは 2 分間、使い切ったモデルは 10 分間避けます。検索付きの質問で混雑したときは、まず検索なしで試し直します。
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
  「打ち合わせを 16 時にずらして」「金曜の予定を消して」で変更・削除もできます（`<calendar-update>` / `<calendar-delete>`、今後 7 日の予定が対象）。
  できなかったときは返答の中でも知らせます（音声でも読み上げ）。
- 権限は `calendar.events`（予定の読み書き）だけを求めます。

### 天気・朝のあいさつ

- 天気は [Open-Meteo](https://open-meteo.com/)（API キー不要）から 15 分ごとに取得し、右パネルと会話に渡します。
- 「おはよう」と話しかけると、天気・今日の予定・脳の記憶から、その日の段取りを短く伝えます。

### Web 検索（Search AI）

- ニュース・最新情報・価格・「調べて」など、最新の情報が必要そうな発言のときだけ Gemini の Google 検索を有効にします（`src/agents/search/needs-search.ts`）。
  無料枠の検索回数を節約するためです。常に使う場合は `FRIDAY_SEARCH=always`。
- 参照したページは返答の下にリンクで表示します（読み上げはしません）。
- 検索が使えない・検索の無料枠を使い切ったときは、自動で検索なしで答えます。

### プロジェクトと ToDo

- 脳の `プロジェクト/<名前>.md` が 1 プロジェクト。右パネル CURRENT PROJECTS に表示します（`はじめに.md` は除く）。
  進捗は `progress: 60` の行があればその値、無ければチェックボックスの完了率。
- ToDo は Obsidian のチェックボックス `- [ ] やること（期限: 2026-10-03）`。プロジェクトのノートの中と `FRIDAY/ToDo.md` から集めます。
- 「〇〇を ToDo に入れて」「〇〇終わった」「NEWTONE の進捗は 6 割」と話しかけると、
  `<todo-add>` / `<todo-done>` / `<project-progress>` タグで脳のノートを書き換えます。

### リマインダー

- 「30 分後に教えて」「18 時にジムって言って」→ `<reminder>` タグで `FRIDAY/リマインダー.md` に `- [ ] 2026-09-29 18:00 ジム` を追加。
- F.R.I.D.A.Y. の画面を開いている間、時間になると効果音・声・ブラウザ通知・画面のお知らせで知らせ、`[x]` にします。
  閉じている間に過ぎたものは、次に開いたときに知らせます（12 時間以内のもの）。

### Gmail（読むだけ）

- Google カレンダーと同じ接続で、`gmail.readonly` の権限も求めます（以前に接続した場合は SCHEDULE の「再接続」から）。
- 「メール来てる？」と聞いたとき・朝のあいさつ・ニュースのまとめのときだけ、直近 3 日の未読（広告・SNS 以外）の差出人・件名・冒頭を読んで要約します。
  メールの本文全体は読まず、保存もしません。送信・削除・既読にはしません。
- Google Cloud で **Gmail API を有効** にする必要があります。

### WRITING AI（文書作成）

- 企画書・レポート・メールの下書き・投稿文などを頼むと、本文を `<document title="…">` タグの中に書き、
  返答の下に文書カードとして表示し、脳の `文書/<タイトル>.md` に保存します（読み上げは要点だけ）。
- 「さっきの企画書の予算のところを直して」→ 同じタイトルで書き直して上書き保存します。

### 振り返り（ANALYSIS AI）

- 「今週の振り返りして」→ 直近 7 日の会話ログ・日記・予定（過去分）・完了/未完了の ToDo・覚えたことを集め、
  ハイライト／できたこと／課題／気づき／来週の提案 を `振り返り/` に保存します。
- 「今日の日記書いて」でも、その日の分から日記を作ります（`日記/YYYY-MM-DD.md`）。

### 毎夜の自動日記（AUTOMATION）

- `vercel.json` の Cron で毎日 14:00 UTC（日本時間 23 時ごろ、無料プランは前後 1 時間ずれることがある）に `/api/cron/diary` を実行。
  画面を開いていなくても、その日の会話ログ・覚えたこと・ToDo から日記を書いて `日記/YYYY-MM-DD.md` に保存します。
- 環境変数 `CRON_SECRET` が必要（Vercel が `Authorization: Bearer <CRON_SECRET>` を付けて呼ぶので、それ以外は拒否）。
- 自分で書いた日記がある日は消さずに、下に「F.R.I.D.A.Y. のまとめ」を足します。記録が何も無い日は書きません。

### SNS AI

- 「インスタの投稿案を作って」「X でバズりそうな告知文」などで、媒体に合わせた 3 案（ハッシュタグ・文字数・投稿時間の提案つき）を作り、
  `SNS/` フォルダに保存します。「最近のトレンドを調べて」は Google 検索を使います。

### SETTINGS（設定画面）

- サイドバーの SETTINGS から、読み上げの速さ・返答の長さ・Web 検索・天気の場所（市区町村名で検索）・ニュースの時間と分野を変えられます。
  保存先は脳の `FRIDAY/設定.md`（と `FRIDAY/ニュース.md`）なので、どの端末でも同じ設定になります。環境変数より優先されます。
- 接続の状態（Gemini・脳・Google カレンダー・Gmail・ElevenLabs・自動日記・通知）を一覧で確認し、Google の接続・解除や通知の許可もできます。

### サイドバーの画面

| 画面 | できること |
| --- | --- |
| PROJECTS | プロジェクトごとの進捗（10% 刻みで記録）・ToDo のチェック・追加 |
| TASKS | ToDo の追加（プロジェクト・期限つき）・完了／戻す、リマインダーの一覧と取り消し |
| CALENDAR | Google カレンダーの 2 週間分の予定、追加・削除 |
| MEMORY | 覚えたことの一覧・追加・削除（間違って覚えたことを消せる）、プロフィールの表示 |
| FILES | F.R.I.D.A.Y. が書いた文書・SNS 投稿案・振り返り・日記の一覧と本文 |

### MEMORY AI（意味で思い出す）

- Gemini の埋め込み（`gemini-embedding-001`、無料枠）で、ノートの段落を 256 個の数字に変えた索引を
  脳の `.friday/embeddings.json` に保存します（Obsidian には表示されない隠しフォルダ）。
- 返答のときは発言を 1 回だけ埋め込みにして、言葉の一致と意味の近さを合わせて関係するノートを選びます
  （「麺類が食べたい」で「味噌ラーメン」のノートを思い出す、など）。間に合わなければ（0.55 秒）言葉の一致だけで探します。
- 索引づくりは返答とは別に、入力中・画面を開いたとき（10 分に 1 回まで、1 回 300 段落まで）と夜の自動日記のときに少しずつ進めます。
  会話ログ・プロフィール・記憶.md は索引に入れません（プロフィールと最近の記憶は毎回そのまま渡すため）。

### 3D ホログラム・手で操作（HAND）

- HOME 中央のリアクターの内側に、three.js の 3D ホログラム（光る線の地球儀・点の雲・傾いたリング・スキャン線・中心のコア）を表示します。
  考え中・返答中は回転が速くなり、F.R.I.D.A.Y. が話している間は脈打ちます。ドラッグで回す・ホイールで拡大・ダブルクリックで元に戻せます。
  HOME 以外の画面や、タブが裏にある間は描画を止めます。WebGL が使えない環境では従来の円盤のままです。
- HOME 右下の「HAND」をオンにすると、パソコンのカメラで手を読み取って操作できます（MediaPipe Hand Landmarker）。
  つまんで動かす → 回す／両手でつまんで広げる → 拡大・縮小／グーを長めに → 元に戻す。
  認識はブラウザの中だけで行い、カメラの映像はどこにも送りません。HOME を離れるとカメラを止めます。
  認識用の wasm は `npm run build` の前に `scripts/copy-mediapipe.mjs` が `public/mediapipe/` にコピーし、モデルは Google から読み込みます。

### HOME（ミニマル HUD）

- 主役は中央の F.R.I.D.A.Y. CORE。細い線の HUD（点線の輪・外向きの三角・斜めの括弧・太いオレンジの輪）の中心で、
  光る太陽と線でつながった光の点の網（canvas 2D）が状態で動きを変えます：
  STANDBY（ゆっくり呼吸）／LISTENING（網が波打つ）／THINKING（渦を巻く）／SEARCHING（光の帯が走査）／
  PROCESSING（縮んで広がる）／RESPONDING（中心から光の波）。外側の大きな輪は、待機中は止まり、働いている間だけ回ります。
  作ったホログラムはコアの中心に浮かびます。
- 画面全体を光るオレンジの枠と上のバーで囲みます。上のバーに F.R.I.D.A.Y.・メニューのアイコン（ほかの画面へ）・日付と時刻。
- 上：タブ AGENTS / NOTES / TASKS / CONTEXT。AGENTS はエージェント一覧を小窓で開き、ほかは MEMORY / TASKS / CHAT へ。
- 左：SYSTEM STATUS（この端末の CPU＝画面の処理の重さ・メモリ・保存領域・通信）／CURRENT MODE／
  短いバー（AI・脳・カレンダー・音声・応答時間・文脈）／左下に現在地。
- 右：レーダー／VOICE ACTIVITY（直近 1 分のうち聞く・考える・話すをしていた割合と流れる波）／NOTIFICATIONS（近い順に 3 件）。
- 下：ACTIVITY LIVE（直近 2 時間の会話の量・文脈の使用量・MSG / RT / CTX / MODE）。話しかけると、ここが RESPONSE パネルに変わり、
  ① 要約（返事の本文）→ ② 関連 Web ページ（SOURCES）の順に表示します。× で閉じ、次に話しかけるとまた開きます。
- 入力欄は HOME では 1 行のコンパクトな形（マイク・入力・送信・VOICE MODE）。
- 数字はすべて実データ（取れないものは「—」）。スマホ・タブレットでは縦に並べます。
- 軽さ：光りは drop-shadow を使わず太く薄い線を重ねて表現し、動くもの（輪・レーダー・波）は要素ごと transform で動かして
  毎フレームの描き直しを起こしません。コアの光と太陽は前もって描いた絵を貼るだけにしています。
  それでも描画が追いつかない端末（3 秒ごとの計測で 2 回続けて 20fps 未満）では、自動で輪の回転を止め、コアを低い解像度・少ないコマ数にします。

### 「〇〇の 3D ホログラムを作って」

- 会話で頼むと、返答の隠しタグ `<hologram>対象</hologram>` を受けて画面が `/api/hologram` を 2 回呼びます。
  1 回目（`step: "research"`）は Google 検索で見た目（比率・部品と配置・数・特徴的な形）を調べた設計メモを作り、
  拡大表示の右側に「REFERENCE」として要点と参考ページを出します。2 回目はそのメモに忠実に、
  Gemini が箱・球・楕円体・円柱・円錐・輪・カプセルに加え、回転体（lathe）・なめらかな管（tube）・押し出し板（extrude）を組み合わせて
  設計図（JSON、最大 160 部品）を作ります（`src/integrations/hologram.ts`）。
- 見た目は縁ほど光る面（フレネル）・走査線・光のにじみ（ブルーム）・表面の光の粒・投影台の光の筒（`src/components/hologram-visuals.ts`）。
  重いパソコンでは光のにじみを自動で切ります。
- できたものは画面いっぱいの拡大表示で浮かび、ドラッグ・ホイール・手の動き（HAND）でそのまま回したり拡大したりできます。
  「小さくする」で中央のリアクターの中に戻り、名前の札を押すと再び拡大、「ホログラムを消して」かボタンで地球儀に戻ります。
- 形は立体の組み合わせなので、ロケット・車・飛行機・ロボット・建物・DNA・瓶や花瓶などは得意、顔や文字などの細かい形は大まかになります。

### Web ページを開く・閉じる

- 「YouTube 開いて」「YouTube で〇〇流して」「〇〇を Google で検索して」「〇〇までの道順を地図で」などで、新しいタブにページを開きます
  （返答に付けた隠しタグ `<open-url>` を画面側で実行。http(s) の URL だけ開きます）。
- 「閉じて」で最後に開いたタブ、「全部閉じて」で F.R.I.D.A.Y. が開いたタブをすべて閉じます。自分で開いたタブは閉じられません。
- 拡張機能なしでは、ブラウザの決まりで次の制限があります。
  - 音声で頼むとポップアップとして止められることがある（画面の「開く」ボタンで開けます）
  - YouTube・Google など、開いた側とのつながりを切るページ（Cross-Origin-Opener-Policy）は閉じられない
- Chrome 拡張機能「F.R.I.D.A.Y. Tabs」（`extension/`）を入れると、どちらも解消します。
  SETTINGS → BROWSER の「拡張機能をダウンロード」（`npm run build` の前に `scripts/pack-extension.mjs` が ZIP を作成）→
  `chrome://extensions` でデベロッパー モードをオン →「パッケージ化されていない拡張機能を読み込む」で展開したフォルダを選びます。
  拡張機能は F.R.I.D.A.Y. のサイト（`f-r-i-d-a-y-mark3.vercel.app` と localhost）からの依頼だけを受け、自分で開いたタブだけを閉じます。
  別の URL で公開する場合は `extension/manifest.json` の `matches` を書き換えてください。

### プッシュ通知（アプリを閉じていても通知）

- SETTINGS → PUSH の「この端末で受け取る」で、その端末（パソコン・Android・ホーム画面に追加した iPhone）を宛先に登録します。
  宛先は脳の `.friday/push.json` に保存されます（Obsidian には表示されません）。
- `.github/workflows/friday-cron.yml` が 5 分ごとに `/api/cron/push` を呼び、
  時間が来たリマインダー（通知したら完了にする）と、ニュースの時間を過ぎたその日の見出し（1 日 1 回）を送ります。
  GitHub の定期実行は混雑時に 5〜15 分ほど遅れることがあります。
- 必要な設定:
  1. Vercel に `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`（「鍵を作る」で表示される値。鍵が未設定のときだけ作れます）と `CRON_SECRET`。
  2. このアプリの GitHub リポジトリの Settings → Secrets and variables → Actions に `FRIDAY_URL`（公開 URL）と `CRON_SECRET`（Vercel と同じ値）。
     ワークフローは既定のブランチ（main）にあるときだけ動きます。未設定なら何もせず終わります。

### スマホ

- ブラウザの「ホーム画面に追加」で、アプリのように全画面で開けます（`/manifest.webmanifest`、アイコンは `public/icons/`）。
- 幅 1000px 未満では、天気・予定・プロジェクトを HUB のカードの下に並べます。

### 毎日のニュース

- 設定した時間（既定 7:00）を過ぎてから **その日最初に話しかけたとき**、まず発言に答えてから、今日の主なニュース 3 本と「興味のある分野」ごとのニュースを検索してまとめて伝えます。
  その日に伝えたかは Cookie（端末ごと）で覚えます。「今日のニュースは？」と聞けばいつでもまとめます。
- 時間と分野は脳の `FRIDAY/ニュース.md`（`## 時間` / `## 興味のある分野`）に保存。Obsidian で書き換えても、
  「ニュースの時間を 7 時半にして」「興味にサッカーを追加して」と話しかけても変えられます（`<news-settings>` タグ）。

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

- 画像・ファイルの添付、画像生成
- 音声入力・ファイル添付・画像生成
- 右パネルのプロジェクトは **SAMPLE** 表示のみ
- Claude API / OpenAI API は使用していません
