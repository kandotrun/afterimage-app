# App Review Notes 日本語原稿

この原稿は `AUTH_CHALLENGE`、`ACCOUNT_DELETION`、`AI_CONSENT`、法務URL、実機smoke、Release archiveがすべてverifiedになったリリース候補だけに使用する。角括弧の証跡欄を埋める前にASCへ貼り付けない。

## Sign in with Apple

本アプリはSign in with Appleのみでアカウントを作成します。審査用Apple IDの資格情報をReview Notesへ記載する必要はありません。認証要求は毎回新しいchallenge/nonceを使用し、backendで期限と一回消費を検証します。

認証証跡: `[AUTH_CHALLENGE evidence URL / build / commit]`

## 権限

- カメラ: アプリ内で動画を撮影するときだけ要求します。拒否しても写真ライブラリから動画を選べます。
- マイク: 撮影動画へ音声を記録するときだけ要求します。拒否時の動作は審査手順で確認できます。
- 写真: PhotosPickerでユーザーが選択した動画だけを取り込みます。全ライブラリを列挙しません。
- 位置情報: アプリ使用中、その日の天気取得に利用します。動画に埋め込まれた撮影場所は記憶のmetadataとして保存されます。拒否しても動画の保存と再生は利用できます。
- 通知: 日次reminderを有効にする明示操作の後で要求します。拒否しても主要機能は利用できます。

権限拒否証跡: `[REAL_DEVICE_SMOKE permission evidence]`

## AI同意

初回の外部AI送信前に、Sonioxへ動画ファイル全体（映像・音声）、Alibaba Cloud Qwenへ文字起こし・映像解析テキスト・撮影日時を送る目的を説明し、明示的なAI同意を求めます。同意しなくても撮影、端末上のHEVC最適化、非公開タイムライン、再生、個別削除、アカウント削除を利用できます。同意撤回後は新規の文字起こし、解析、要約、MCP取得を停止します。AIエージェントにはユーザーが個別に許可した動画だけを読み取り可能にします。

同意証跡: `[AI_CONSENT evidence URL / test result]`

## アカウント削除

アカウントメニューから「アカウントを削除」を選び、影響範囲を示す最終確認後に削除できます。削除はowner-scopedで、session、media、thumbnail、文字起こし、解析、要約、位置・天気、MCP token、外部processor上の処理、Apple token revokeを対象にします。部分失敗は再試行されます。

削除証跡: `[ACCOUNT_DELETION evidence URL / cleanup read-back]`

## 審査手順

1. アプリをfresh installし、Sign in with Appleを完了します。
2. 「＋」からアプリ内撮影を選び、カメラ・マイクの説明と拒否／許可動作を確認します。
3. 「＋」から写真ライブラリを選び、短い動画を取り込みます。
4. background upload完了後、タイムラインの動画を開いて再生します。
5. AI説明を読み、同意前は外部処理が開始されないこと、同意後に文字起こし・解析・検索が表示されることを確認します。
6. 動画のAI共有を明示的に有効化し、無効化後にMCP経由で取得できないことを確認します。
7. 動画を個別削除し、タイムラインから消えることを確認します。
8. アカウントメニューからアカウント削除を実行し、login画面へ戻ることを確認します。

審査build: `[version (build)]`

検証端末/OS: `[device / iOS]`

既知制約: `[none または具体的内容]`

Privacy Policy: `https://afterimage.2-38.com/privacy`

Support: `https://afterimage.2-38.com/support`

Terms: `https://afterimage.2-38.com/terms`
