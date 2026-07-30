# App Store screenshots

## 初回公開版の提出画像

初回公開版では、App Store ConnectのiPhone 6.9インチ枠で受理済みの日本語スクリーンショットを次の順序で使用する。

1. `iphone-6.9/01-timeline.png`
   - 動画中心のタイムライン、撮影場所、日ごとの再生導線
2. `iphone-6.9/02-video-detail.png`
   - 動画再生、撮影場所、文字起こしと映像分析への導線
3. `iphone-6.9/03-transcript.png`
   - 日本語の文字起こし
4. `iphone-6.9/04-video-analysis.png`
   - 映像の要約とタイムライン分析

画像はすべて1320×2868pxの不透明なRGB PNGで、匿名の合成動画、合成音声、合成文字起こし、合成分析データを使用する。実ユーザーのメディア、個人情報、認証情報は使用しない。

## 再生成とrelease evidence

self-hosted macOSのiPhone 16 Pro Max / iOS 26 simulatorで、Debug-onlyの決定的fixtureをUI testから撮影する。fixtureは公園の夕暮れを題材にした合成動画表現、合成の場所名、文字起こし、映像解析を含み、network、Apple ID、実ユーザーsession、写真ライブラリ、private mediaへ接続しない。

macOSでXcode 26、iOS 26 runtime、XcodeGenが利用できることを確認してから実行する。

```bash
npm ci
npm run screenshots:app-store
```

既定出力は`artifacts/app-store/screenshots/`。`AFTERIMAGE_SCREENSHOT_DEVICE_NAME`で端末名、`AFTERIMAGE_SCREENSHOT_OUTPUT_DIR`で出力先を変更できる。端末は`manifest.json`に列挙したApple accepted 6.9-inch portrait dimensionsのいずれかを実際に出力する必要がある。

automationはUI testで次の3 sceneを個別launchし、ready accessibility identifierを待って撮影する。

1. `01-private-timeline.png`: 非公開タイムライン、合成動画、代々木公園、天気、日次要約
2. `02-memory-detail.png`: 合成動画の再生画面、場所、時刻、文字起こし
3. `03-ai-analysis.png`: 同じ合成動画の映像解析、scene timeline、文字起こしとの対応

PNGは不透明なRGBへflattenし、verifierがsignature、IHDR寸法、portrait、alpha channel、manifestのfilenameを検査する。workflow artifactにはPNG、xcresult、build log、verification reportを含める。simulatorのstatus barは9:41、Wi-Fi、battery 100%へ固定し、job終了時にoverrideを解除する。

CI生成物はrelease evidenceであり、checked-inの提出画像4枚を自動上書きしない。差し替える場合はApp Store Connectの表示順とこの文書を同時に更新する。

画像をApp Store Connectへ登録する前に、切れ、誤字、時刻やlocaleの揺れ、debug overlay、単なる色ベタ、実データ、alpha channelがないことを目視する。LinuxでPNGをfabricateしたり既存画像をresizeして完了扱いにしない。
