/**
 * /privacy — プライバシーポリシー（Google の OAuth 同意画面の公開に必要。合言葉なしで表示）。
 */
import type { Metadata } from "next";

export const metadata: Metadata = { title: "プライバシーポリシー | F.R.I.D.A.Y. Mark3" };

export default function PrivacyPage() {
  return (
    <main className="privacy">
      <h1>プライバシーポリシー</h1>
      <p>F.R.I.D.A.Y. Mark3（以下「本アプリ」）は、運営者本人が個人で使うための AI アシスタントです。</p>

      <h2>Google カレンダーのデータ</h2>
      <ul>
        <li>本アプリは、利用者が許可した場合に限り、Google カレンダーの予定を読み取り、利用者が依頼した予定を追加します。</li>
        <li>読み取った予定は、その場の会話の返答を作るため、および画面に今日の予定を表示するためだけに使います。</li>
        <li>予定の内容を本アプリのサーバーに保存したり、第三者に販売・共有したりしません。</li>
        <li>Google から受け取った認証情報は、暗号化して利用者のブラウザの Cookie にのみ保存します。</li>
        <li>接続は画面上から、または Google アカウントの「サードパーティ製のアプリとサービス」からいつでも解除できます。</li>
      </ul>

      <h2>会話のデータ</h2>
      <ul>
        <li>会話の返答を作るため、入力内容と関連する予定・ノートを Google の Gemini API に送信します。</li>
        <li>長期記憶を有効にしている場合、会話の記録と覚えた内容を、利用者本人の非公開 GitHub リポジトリに保存します。</li>
      </ul>

      <h2>Google API サービスのユーザーデータに関するポリシー</h2>
      <p>
        本アプリによる Google API から受け取った情報の使用と他のアプリへの転送は、限定的使用の要件を含む Google API
        サービスのユーザーデータに関するポリシーに準拠します。
      </p>

      <p className="privacy__date">制定日：2026年9月28日</p>
    </main>
  );
}
