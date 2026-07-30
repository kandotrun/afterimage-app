# 6.9-inch日本語screenshot

提出画像はself-hosted macOSのiPhone 16 Pro Max / iOS 26 simulatorで、Debug-onlyの決定的fixtureをUI testから撮影する。fixtureは公園の夕暮れを題材にした合成動画表現、合成の場所名、文字起こし、映像解析を含み、network、Apple ID、実ユーザーsession、写真ライブラリ、private mediaへ接続しない。

## 生成

macOSでXcode 26、iOS 26 runtime、XcodeGenが利用できることを確認してから実行する。

```bash
npm ci
npm run screenshots:app-store
```

既定出力は`artifacts/app-store/screenshots/`。`AFTERIMAGE_SCREENSHOT_DEVICE_NAME`で端末名、`AFTERIMAGE_SCREENSHOT_OUTPUT_DIR`で出力先を変更できる。端末は`manifest.json`に列挙したApple accepted 6.9-inch portrait dimensionsのいずれかを実際に出力する必要がある。

automationはUI testで3 sceneを個別launchし、ready accessibility identifierを待って撮影する。PNGは不透明なRGBへflattenし、verifierがsignature、IHDR寸法、portrait、alpha channel、manifestのfilenameを検査する。workflow artifactにはPNG、xcresult、build log、verification reportを含める。
simulatorのstatus barは9:41、Wi-Fi、battery 100%へ固定し、job終了時にoverrideを解除する。

## 内容

1. `01-private-timeline.png`: 非公開タイムライン、合成動画、代々木公園、天気、日次要約
2. `02-memory-detail.png`: 合成動画の再生画面、場所、時刻、文字起こし
3. `03-ai-analysis.png`: 同じ合成動画の映像解析、scene timeline、文字起こしとの対応

画像をApp Store Connectへ登録する前に、切れ、誤字、時刻やlocaleの揺れ、debug overlay、単なる色ベタ、実データ、alpha channelがないことを目視する。LinuxでPNGをfabricateしたり既存画像をresizeして完了扱いにしない。
