import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => readFileSync(path.join(root, relativePath), "utf8");

function extractDeclaration(source, pattern, label) {
  pattern.lastIndex = 0;
  const match = pattern.exec(source);
  assert.ok(match, `missing declaration: ${label}`);

  let openingBrace = -1;
  let mode = "code";
  let blockCommentDepth = 0;
  for (let index = match.index; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1];
    if (mode === "lineComment") {
      if (current === "\n") mode = "code";
      continue;
    }
    if (mode === "blockComment") {
      if (current === "/" && next === "*") {
        blockCommentDepth += 1;
        index += 1;
      } else if (current === "*" && next === "/") {
        blockCommentDepth -= 1;
        index += 1;
        if (blockCommentDepth === 0) mode = "code";
      }
      continue;
    }
    if (mode === "string") {
      if (current === "\\") {
        index += 1;
      } else if (current === "\"") {
        mode = "code";
      }
      continue;
    }
    if (current === "/" && next === "/") {
      mode = "lineComment";
      index += 1;
    } else if (current === "/" && next === "*") {
      mode = "blockComment";
      blockCommentDepth = 1;
      index += 1;
    } else if (current === "\"") {
      mode = "string";
    } else if (current === "{") {
      openingBrace = index;
      break;
    }
  }
  assert.notEqual(openingBrace, -1, `missing opening brace: ${label}`);

  let depth = 0;
  mode = "code";
  blockCommentDepth = 0;
  for (let index = openingBrace; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1];
    if (mode === "lineComment") {
      if (current === "\n") mode = "code";
      continue;
    }
    if (mode === "blockComment") {
      if (current === "/" && next === "*") {
        blockCommentDepth += 1;
        index += 1;
      } else if (current === "*" && next === "/") {
        blockCommentDepth -= 1;
        index += 1;
        if (blockCommentDepth === 0) mode = "code";
      }
      continue;
    }
    if (mode === "string") {
      if (current === "\\") {
        index += 1;
      } else if (current === "\"") {
        mode = "code";
      }
      continue;
    }
    if (current === "/" && next === "/") {
      mode = "lineComment";
      index += 1;
    } else if (current === "/" && next === "*") {
      mode = "blockComment";
      blockCommentDepth = 1;
      index += 1;
    } else if (current === "\"") {
      mode = "string";
    } else if (current === "{") {
      depth += 1;
    } else if (current === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(match.index, index + 1);
      }
    }
  }
  assert.fail(`unbalanced declaration: ${label}`);
}

function requireMatch(source, pattern, message) {
  assert.match(source, pattern, message);
}

function validateUploadCompletion(declaration, label) {
  requireMatch(
    declaration,
    /case\s+\.success:\s*[\s\S]*?(?:offerReminderInviteAfterSuccessfulUpload|celebrateUploadCompletion)\(\)/,
    `${label} must offer the reminder invitation after upload success`,
  );
}

function validateSchedulerPermission(declaration) {
  requireMatch(
    declaration,
    /center\.requestAuthorization\(options:\s*\[\.alert,\s*\.sound\]\)/,
    "requestPermission must invoke UNUserNotificationCenter requestAuthorization",
  );
}

function validateReminderSheet(declaration) {
  requireMatch(
    declaration,
    /\bScrollView\s*\{/,
    "ReminderInviteSheet must own its accessibility Dynamic Type ScrollView",
  );
}

const extractionFixture = `
func intended() {
  let text = "{ decoy }"
  if true { print(text) }
}
func unrelated() {
  requestAuthorization()
}
`;
const intendedFixture = extractDeclaration(
  extractionFixture,
  /\bfunc\s+intended\s*\(/,
  "balanced extraction fixture",
);
assert.doesNotMatch(intendedFixture, /requestAuthorization/);
assert.match(
  extractDeclaration(extractionFixture, /\bfunc\s+unrelated\s*\(/, "unrelated fixture"),
  /requestAuthorization/,
);

const appModel = read("ios/Sources/App/AppModel.swift");
const scheduler = read("ios/Sources/Notifications/DailyPostReminderScheduler.swift");
const timeline = read("ios/Sources/Features/Timeline/TimelineView.swift");
const photoMemory = read("ios/Sources/Features/Memory/PhotoMemoryView.swift");
const videoMemory = read("ios/Sources/Features/Memory/VideoMemoryView.swift");
const dailyPlayback = read("ios/Sources/Features/Memory/DailyPlaybackView.swift");
const memoryDetail = read("ios/Sources/Features/Memory/MemoryDetailView.swift");
const transcriptSheetSource = read("ios/Sources/Features/Memory/TranscriptSheet.swift");
const cameraPlayback = read("ios/Sources/Features/Camera/CameraCapturePlayback.swift");
const cameraComponents = read("ios/Sources/Features/Camera/CameraCaptureComponents.swift");
const weatherBadge = read("ios/Sources/Features/Timeline/DailyWeatherBadge.swift");
const weatherDescriber = read(
  "ios/Sources/Features/Timeline/WeatherConditionDescriber.swift",
);
const dayStorySection = read("ios/Sources/Features/Timeline/DayStorySection.swift");
const appRoot = read("ios/Sources/App/afterimageApp.swift");
const policyTests = read("ios/Tests/PR39AccessibilityPolicyTests.swift");
const weatherTests = read("ios/Tests/WeatherConditionDescriberTests.swift");
const aiConnectionView = read("ios/Sources/Features/Settings/AIConnectionView.swift");
const aiConnectionUITests = read("ios/UITests/AIConnectionNavigationUITests.swift");
const packageJson = JSON.parse(read("package.json"));
const catalog = JSON.parse(read("ios/Resources/Localizable.xcstrings"));
const koreanInfo = read("ios/Resources/Localization/ko.lproj/InfoPlist.strings");
const swiftSources = readdirSync(path.join(root, "ios/Sources"), {
  recursive: true,
  withFileTypes: true,
})
  .filter((entry) => entry.isFile() && entry.name.endsWith(".swift"))
  .map((entry) => readFileSync(path.join(entry.parentPath, entry.name), "utf8"))
  .join("\n");

const processUpload = extractDeclaration(
  appModel,
  /\bprivate\s+func\s+process\s*\(/,
  "AppModel.process",
);
const resumeUpload = extractDeclaration(
  appModel,
  /\bfunc\s+resumeBackgroundUploadIfNeeded\s*\(/,
  "AppModel.resumeBackgroundUploadIfNeeded",
);
validateUploadCompletion(processUpload, "AppModel.process");
validateUploadCompletion(resumeUpload, "AppModel.resumeBackgroundUploadIfNeeded");

const acceptedDeletionCleanup = extractDeclaration(
  appModel,
  /\bprivate\s+func\s+clearPersistedSessionForAcceptedDeletion\s*\(/,
  "AppModel.clearPersistedSessionForAcceptedDeletion",
);
assert.doesNotMatch(
  acceptedDeletionCleanup,
  /offerReminderInviteAfterSuccessfulUpload/,
  "accepted deletion cleanup must close before the reminder declaration",
);

const offerInvite = extractDeclaration(
  appModel,
  /\bprivate\s+func\s+offerReminderInviteAfterSuccessfulUpload\s*\(/,
  "AppModel.offerReminderInviteAfterSuccessfulUpload",
);
for (const pattern of [
  /reminderInviteDefaults\.bool\(forKey:\s*Self\.reminderInviteOfferedKey\)/,
  /guard\s+!wasOffered\s+else\s*\{\s*return\s*\}/,
  /postReminderScheduler\.authorizationStatus\(\)/,
  /ReminderInvitePolicy\.shouldOffer\(/,
  /reminderInviteDefaults\.set\(true,\s*forKey:\s*Self\.reminderInviteOfferedKey\)/,
  /reminderInvite\s*=\s*true/,
]) {
  requireMatch(offerInvite, pattern, "reminder offer must keep one-time and authorization guards");
}
const celebrateUpload = extractDeclaration(
  appModel,
  /\bprivate\s+func\s+celebrateUploadCompletion\s*\(/,
  "AppModel.celebrateUploadCompletion",
);
requireMatch(
  celebrateUpload,
  /offerReminderInviteAfterSuccessfulUpload\(\)/,
  "upload completion animation must delegate to the guarded reminder invitation",
);

const reminderPolicy = extractDeclaration(
  scheduler,
  /\benum\s+ReminderInvitePolicy\b/,
  "ReminderInvitePolicy",
);
requireMatch(reminderPolicy, /!wasOffered/, "reminder policy must reject repeat offers");
requireMatch(
  reminderPolicy,
  /authorizationStatus\s*==\s*\.notDetermined/,
  "reminder policy must offer only before an OS authorization decision",
);

const acceptInvite = extractDeclaration(
  appModel,
  /\bfunc\s+acceptReminderInvite\s*\(/,
  "AppModel.acceptReminderInvite",
);
const declineInvite = extractDeclaration(
  appModel,
  /\bfunc\s+declineReminderInvite\s*\(/,
  "AppModel.declineReminderInvite",
);
requireMatch(
  acceptInvite,
  /postReminderScheduler\.requestPermission\(\)/,
  "explicit accept must request notification permission",
);
assert.doesNotMatch(
  declineInvite,
  /requestPermission|requestAuthorization/,
  "decline must not prompt for OS notification permission",
);
assert.equal(
  [...appModel.matchAll(/postReminderScheduler\.requestPermission\(\)/g)].length,
  1,
  "AppModel must request permission only from the explicit accept declaration",
);
for (const [label, pattern] of [
  ["AppModel.bootstrap", /\bfunc\s+bootstrap\s*\(/],
  ["AppModel.signIn", /\bfunc\s+signIn\s*\(/],
]) {
  assert.doesNotMatch(
    extractDeclaration(appModel, pattern, label),
    /requestPermission|requestAuthorization/,
    `${label} must not request notification permission`,
  );
}

const requestPermission = extractDeclaration(
  scheduler,
  /\bfunc\s+requestPermission\s*\(/,
  "DailyPostReminderScheduler.requestPermission",
);
validateSchedulerPermission(requestPermission);
const schedulerAuthorization = extractDeclaration(
  scheduler,
  /\bprivate\s+func\s+isAuthorized\s*\(/,
  "DailyPostReminderScheduler.isAuthorized",
);
assert.doesNotMatch(
  schedulerAuthorization,
  /requestAuthorization/,
  "automatic reminder refresh must not show an OS permission prompt",
);
requireMatch(
  schedulerAuthorization,
  /case\s+\.notDetermined,\s*\.denied:\s*return\s+false/,
  "automatic reminder refresh must treat notDetermined as unauthorized",
);

const timelineView = extractDeclaration(
  timeline,
  /\bstruct\s+TimelineView\s*:\s*View\b/,
  "TimelineView",
);
requireMatch(
  timelineView,
  /\.sheet\(isPresented:\s*\$model\.reminderInvite\)\s*\{[\s\S]*?ReminderInviteSheet\(/,
  "TimelineView must present ReminderInviteSheet from AppModel state",
);
const reminderSheet = extractDeclaration(
  timeline,
  /\bprivate\s+struct\s+ReminderInviteSheet\s*:\s*View\b/,
  "ReminderInviteSheet",
);
validateReminderSheet(reminderSheet);
requireMatch(reminderSheet, /\.interactiveDismissDisabled\(\)/);
for (const key of [
  "notification.invite.title",
  "notification.invite.body",
  "notification.invite.accept",
  "notification.invite.decline",
]) {
  assert.ok(reminderSheet.includes(key), `ReminderInviteSheet missing copy key: ${key}`);
}

const cameraReview = extractDeclaration(
  cameraComponents,
  /\bstruct\s+CameraCaptureReviewView\s*:\s*View\b/,
  "CameraCaptureReviewView",
);
requireMatch(
  cameraReview,
  /dynamicTypeSize\.isAccessibilitySize/,
  "camera review must adapt at accessibility Dynamic Type sizes",
);
requireMatch(
  cameraReview,
  /AnyLayout\(VStackLayout\(/,
  "camera review actions must become vertical at accessibility Dynamic Type sizes",
);

const photoView = extractDeclaration(
  photoMemory,
  /\bstruct\s+PhotoMemoryView\s*:\s*View\b/,
  "PhotoMemoryView",
);
for (const pattern of [
  /\.accessibilityElement\(children:\s*\.ignore\)/,
  /"accessibility\.photo_at"/,
  /\.accessibilityAddTraits\(\.isImage\)/,
  /\.accessibilityAction\s*\{\s*onSingleTap\(\)\s*\}/,
]) {
  requireMatch(photoView, pattern, "photo page must be a VoiceOver image with an action");
}

const memoryDetailView = extractDeclaration(
  memoryDetail,
  /\bstruct\s+MemoryDetailView\s*:\s*View\b/,
  "MemoryDetailView",
);
requireMatch(
  memoryDetailView,
  /\.confirmationDialog\("この残像を削除しますか？"/,
  "memory deletion title must use localized generic copy",
);
requireMatch(
  memoryDetailView,
  /Text\("サーバーに保存された写真・動画も完全に削除され、元に戻せません。"\)/,
  "memory deletion detail must accurately describe permanent server deletion",
);
assert.doesNotMatch(memoryDetailView, /\bR2\b/);

const transcriptSheet = extractDeclaration(
  transcriptSheetSource,
  /\bstruct\s+TranscriptSheet\s*:\s*View\b/,
  "TranscriptSheet",
);
requireMatch(
  transcriptSheet,
  /\.navigationTitle\("ことば"\)/,
  "transcript sheet title must use the unified ことば narration",
);
assert.doesNotMatch(transcriptSheet, /\.navigationTitle\("文字起こし"\)/);

const videoView = extractDeclaration(
  videoMemory,
  /\bstruct\s+VideoMemoryView\s*:\s*View\b/,
  "VideoMemoryView",
);
for (const pattern of [
  /PlayerChromeAccessibilityPolicy\.shouldAutoHide\(/,
  /UIAccessibility\.isVoiceOverRunning/,
  /UIAccessibility\.isSwitchControlRunning/,
  /"playback\.scrub"/,
  /"playback\.position_accessibility"/,
]) {
  requireMatch(videoView, pattern, "VideoMemoryView accessibility behavior must stay local");
}
assert.ok(
  [...videoView.matchAll(/\.accessibilityHidden\(true\)/g)].length >= 2,
  "VideoMemoryView must hide both duplicate time labels",
);

const transcriptPanel = extractDeclaration(
  dailyPlayback,
  /\bprivate\s+func\s+transcriptPanel\s*\(/,
  "DailyPlaybackView.transcriptPanel",
);
requireMatch(
  transcriptPanel,
  /HStack[\s\S]*?\.accessibilityElement\(children:\s*\.combine\)[\s\S]*?CaptureLocationChip[\s\S]*?ScrollView/,
  "only the transcript header may be combined so its link and scroll remain reachable",
);
assert.doesNotMatch(
  transcriptPanel,
  /\.background\([^)]*\)[\s\S]*?\.accessibilityElement\(children:\s*\.combine\)/,
  "the whole transcript panel must not be one combined accessibility element",
);

const dailyControls = extractDeclaration(
  dailyPlayback,
  /\bprivate\s+var\s+controls\s*:\s*some\s+View\b/,
  "DailyPlaybackView.controls",
);
for (const pattern of [
  /"playback\.scrub"/,
  /"playback\.position_accessibility"/,
]) {
  requireMatch(dailyControls, pattern, "daily playback scrubber must expose label and mm:ss value");
}
assert.ok(
  [...dailyControls.matchAll(/\.accessibilityHidden\(true\)/g)].length >= 2,
  "daily playback must hide both duplicate time labels",
);

const recordingDuration = extractDeclaration(
  cameraPlayback,
  /\bstruct\s+RecordingDurationView\s*:\s*View\b/,
  "RecordingDurationView",
);
for (const pattern of [
  /"camera\.accessibility\.recording_duration"/,
  /Duration\.seconds\(/,
  /\.units\(allowed:\s*\[\.minutes,\s*\.seconds\],\s*width:\s*\.wide\)/,
  /\.accessibilityAddTraits\(\.updatesFrequently\)/,
]) {
  requireMatch(recordingDuration, pattern, "recording duration must expose a localized spoken value");
}

const weatherView = extractDeclaration(
  weatherBadge,
  /\bstruct\s+DailyWeatherBadge\s*:\s*View\b/,
  "DailyWeatherBadge",
);
for (const pattern of [
  /WeatherConditionDescriber\.key\(forSymbol:\s*weather\.symbolName\)/,
  /"weather\.summary\.accessibility_with_condition"/,
  /\.frame\(width:\s*78,\s*height:\s*14,\s*alignment:\s*\.trailing\)[\s\S]*?\.padding\(\.vertical,\s*15\)[\s\S]*?\.contentShape\(\.rect\)/,
]) {
  requireMatch(weatherView, pattern, "weather badge must announce condition and keep a 44pt legal link");
}
requireMatch(weatherDescriber, /symbolName\.contains\("bolt"\)/);
requireMatch(weatherTests, /testDescribesCommonConditions/);
requireMatch(weatherTests, /testUnknownSymbolsHaveNoDescription/);

const dayStoryHero = extractDeclaration(
  dayStorySection,
  /\bprivate\s+struct\s+DayStoryHero\s*:\s*View\b/,
  "DayStoryHero",
);
requireMatch(
  dayStoryHero,
  /\.black\.opacity\(0\.78\)/,
  "timeline hero gradient must retain accessible caption contrast",
);

for (const pattern of [
  /testReminderInviteIsOfferedOnlyOnceBeforeAuthorization/,
  /testPlayerChromeDoesNotAutoHideForAssistiveAccess/,
]) {
  requireMatch(policyTests, pattern, "missing pure PR39 accessibility policy coverage");
}

assert.match(
  packageJson.scripts["check:ios"],
  /node scripts\/verify-ios-pr39-port-contract\.mjs/,
  "check:ios must run the selected PR39 port contract",
);

const localizedValue = (key, locale) =>
  catalog.strings[key]?.localizations?.[locale]?.stringUnit?.value;
const expectedValues = {
  "notification.daily_post.body": {
    ja: "今日はまだ何も残していません。今日のワンシーンを動画で残してみませんか？",
    en: "Nothing from today yet. Capture one moment on video before the day ends.",
    "zh-Hans": "今天还没有留下任何记录。用视频记下今天的一个瞬间吧。",
    ko: "오늘은 아직 아무것도 남기지 않았어요. 오늘의 한 장면을 동영상으로 남겨 보실래요?",
  },
  "notification.invite.title": {
    ja: "おやすみ前のお知らせ",
    en: "A gentle nightly nudge",
    "zh-Hans": "睡前的小提醒",
    ko: "잠들기 전 알림",
  },
  "notification.invite.body": {
    ja: "夜10時ごろ、今日をひと言残すお誘いを届けます。通知はいつでもオフにできます。",
    en: "Around 10 p.m., we'll invite you to keep one moment from the day. You can turn this off anytime.",
    "zh-Hans": "晚上10点左右，我们会邀请你留下今天的一个瞬间。随时可以关闭。",
    ko: "밤 10시쯤, 오늘의 한 장면을 남기도록 초대해 드립니다. 언제든지 끌 수 있습니다.",
  },
  "notification.invite.accept": {
    ja: "通知を受け取る",
    en: "Turn On Reminders",
    "zh-Hans": "接收通知",
    ko: "알림 받기",
  },
  "notification.invite.decline": {
    ja: "今はしない",
    en: "Not Now",
    "zh-Hans": "暂不需要",
    ko: "나중에",
  },
  "api.asset_not_found": {
    ja: "残像が見つかりませんでした。",
    en: "This afterimage could not be found.",
    "zh-Hans": "找不到这条残像。",
    ko: "이 잔상을 찾을 수 없습니다.",
  },
  "upload.stage.uploading": {
    ja: "あなたの残像として保存しています",
    en: "Saving to your afterimage",
    "zh-Hans": "正在保存为你的残像",
    ko: "내 잔상으로 저장하는 중",
  },
  "サーバーに保存された写真・動画も完全に削除され、元に戻せません。": {
    ja: "サーバーに保存された写真・動画も完全に削除され、元に戻せません。",
    en: "Photos and videos stored on the server will be permanently deleted. This cannot be undone.",
    "zh-Hans": "服务器上保存的照片和视频也会被永久删除，且无法恢复。",
    ko: "서버에 저장된 사진과 동영상도 완전히 삭제되며 되돌릴 수 없습니다.",
  },
  "この残像を削除しますか？": {
    ja: "この残像を削除しますか？",
    en: "Delete this afterimage?",
    "zh-Hans": "要删除这条残像吗？",
    ko: "이 잔상을 삭제할까요?",
  },
  "最初の残像を残そう": {
    ja: "最初の残像を残そう",
    en: "Leave your first afterimage",
    "zh-Hans": "留下你的第一道残像",
    ko: "첫 잔상을 남겨보세요",
  },
};
for (const [key, translations] of Object.entries(expectedValues)) {
  for (const [locale, expected] of Object.entries(translations)) {
    assert.equal(localizedValue(key, locale), expected, `${key} has incorrect ${locale} copy`);
  }
}

assert.equal(localizedValue("action.retry", "en"), "Try Again");
assert.equal(localizedValue("camera.action.retry", "ja"), "もう一度");
assert.equal(localizedValue("upload.stage.importing", "ko"), "기억을 받아오는 중");
assert.equal(localizedValue("daily.playback.subtitle", "ja"), "この動画のことば");
assert.equal(localizedValue("transcript.pending_title", "ja"), "ことばを書き起こしています");
assert.equal(localizedValue("transcript.failed_title", "ja"), "ことばを残せませんでした");
assert.equal(localizedValue("privacy.ai.title", "ja"), "AI処理への同意");
assert.equal(
  localizedValue("privacy.ai.introduction", "ja"),
  "撮影・保存・再生・削除は同意なしで使えます。AI機能と、あなたが許可した連携だけが、明示的な同意後に始まります。",
);
assert.equal(
  localizedValue("privacy.ai.purpose", "ja"),
  "AI機能と、あなたが許可した連携を提供するために使用します。広告や追跡には使いません。",
);
assert.equal(
  localizedValue("privacy.ai.existing_data", "ja"),
  "同意を撤回すると新しいAI処理と外部連携を停止します。既存のデータは非公開のまま残り、個別削除またはアカウント削除で消去できます。",
);
for (const key of [
  "privacy.ai.destination_title",
  "privacy.ai.mcp",
  "privacy.ai.qwen",
  "privacy.ai.soniox",
]) {
  assert.equal(catalog.strings[key], undefined, `removed implementation detail key remains: ${key}`);
}
assert.ok(
  aiConnectionUITests.includes('XCTAssertTrue(app.staticTexts["AI処理への同意"].exists)')
    && aiConnectionUITests.includes('XCTAssertFalse(app.staticTexts["送信先と送信データ"].exists)')
    && aiConnectionUITests.includes('label CONTAINS[c] %@')
    && aiConnectionUITests.includes('"Soniox"')
    && aiConnectionUITests.includes('"Alibaba Cloud Qwen"')
    && aiConnectionUITests.includes('"MCP client / AIエージェント"'),
  "AI consent UI test must keep the main settings copy high-level",
);
assert.equal(
  localizedValue("mcp.connection.description", "ja"),
  "あなたが個別に許可した動画・文字起こし・解析を、接続したAIエージェントへ読み取り専用で渡します。写真や動画を書き換える権限はありません。",
);
assert.ok(
  aiConnectionView.includes('L10n.string("mcp.connection.description")')
    && aiConnectionView.includes('L10n.string("mcp.connection.read_only")'),
  "MCP connection screen must use localized, capability-accurate read-only disclosure",
);
assert.ok(
  !aiConnectionView.includes("動画の文字起こしだけを、あなたが許可したAIエージェントへ安全に渡します。"),
  "MCP connection screen must not claim transcript-only access when video tools exist",
);
assert.match(
  koreanInfo,
  /NSPhotoLibraryUsageDescription" = "[^"]*비공개 기억[^"]*afterimage[^"]*";/,
  "Korean photo library copy must use 기억 while preserving the product brand",
);

const deadKeys = [
  "R2上の写真・動画も完全に削除されます。",
  "memory.kind.photo",
  "memory.kind.video",
  "ことばを残しています…",
  "ことばを残せませんでした",
  "このafterimageを削除しますか？",
  "再試行",
  "写真に残した瞬間",
  "映像と音で残した記憶",
  "最初のafterimageを残そう",
];
for (const key of deadKeys) {
  assert.ok(!swiftSources.includes(key), `catalog key is still referenced by Swift source: ${key}`);
  assert.equal(catalog.strings[key], undefined, `demonstrably dead catalog key remains: ${key}`);
}

const userFacingCatalogValues = Object.values(catalog.strings)
  .flatMap((entry) => Object.values(entry.localizations ?? {}))
  .map((localization) => localization.stringUnit?.value ?? "")
  .join("\n");
assert.doesNotMatch(userFacingCatalogValues, /\bR2\b/, "user-facing copy must not expose R2");
assert.throws(
  () =>
    validateSchedulerPermission(
      requestPermission.replace("requestAuthorization", "authorizationStatus"),
    ),
  /requestPermission must invoke/,
);
assert.throws(
  () =>
    validateUploadCompletion(
      processUpload.replace(
        /(?:offerReminderInviteAfterSuccessfulUpload|celebrateUploadCompletion)\(\)/,
        "reminderInvite = true",
      ),
      "mutated AppModel.process",
    ),
  /must offer/,
);
assert.throws(
  () => validateReminderSheet(reminderSheet.replace("ScrollView", "VStack")),
  /must own/,
);

console.log("iOS PR39 selected-port contract: PASS");
