import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { inflateSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFileSync(path.join(root, relative), "utf8");
const optionalRead = (relative) => {
  try {
    return read(relative);
  } catch {
    return "";
  }
};

function declaration(source, signature) {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `missing declaration: ${signature}`);
  const open = source.indexOf("{", start + signature.length);
  assert.notEqual(open, -1, `missing declaration body: ${signature}`);
  let depth = 0;
  let mode = "code";
  let escaped = false;
  for (let index = open; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (mode === "line-comment") {
      if (character === "\n") mode = "code";
      continue;
    }
    if (mode === "block-comment") {
      if (character === "*" && next === "/") {
        mode = "code";
        index += 1;
      }
      continue;
    }
    if (mode === "string") {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === "\"") {
        mode = "code";
      }
      continue;
    }
    if (character === "/" && next === "/") {
      mode = "line-comment";
      index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      mode = "block-comment";
      index += 1;
      continue;
    }
    if (character === "\"") {
      mode = "string";
      continue;
    }
    if (character === "{") depth += 1;
    if (character === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  assert.fail(`unterminated declaration: ${signature}`);
}

function declarationScope(source, startPattern, label) {
  const match = startPattern.exec(source);
  assert.ok(match, `missing declaration: ${label}`);
  return declaration(source, match[0]);
}

const project = read("ios/project.yml");
const info = read("ios/Resources/Info.plist");
const entitlements = read("ios/Resources/afterimage.entitlements");
const dayStory = read("ios/Sources/Features/Timeline/DayStorySection.swift");
const [dayStorySection, dayStoryHero = ""] = dayStory.split("private struct DayStoryHero");
const weatherBadge = read("ios/Sources/Features/Timeline/DailyWeatherBadge.swift");
const weatherTemperatureFormatter = read(
  "ios/Sources/Features/Timeline/DailyWeatherTemperatureFormatter.swift",
);
const timeline = read("ios/Sources/Features/Timeline/TimelineView.swift");
const appModel = read("ios/Sources/App/AppModel.swift");
const memoryDetail = read("ios/Sources/Features/Memory/MemoryDetailView.swift");
const memorySearch = (() => {
  try {
    return read("ios/Sources/Features/Search/MemorySearchView.swift");
  } catch {
    return "";
  }
})();
const captureLocationChip = read("ios/Sources/Features/Memory/CaptureLocationChip.swift");
const apiClient = read("ios/Sources/Networking/APIClient.swift");
const apiModels = read("ios/Sources/Models/APIModels.swift");
const mediaImporter = read("ios/Sources/Import/MediaImporter.swift");
const backgroundUploadManager = read("ios/Sources/Upload/BackgroundUploadManager.swift");
const appRoot = read("ios/Sources/App/afterimageApp.swift");
const uploadPreviewPlayer = (() => {
  try {
    return read("ios/Sources/Features/Timeline/UploadPreviewPlayer.swift");
  } catch {
    return "";
  }
})();
const privacy = read("ios/Resources/PrivacyInfo.xcprivacy");
const login = read("ios/Sources/Features/Auth/LoginView.swift");
const appleAuthorizationButton = optionalRead(
  "ios/Sources/Features/Auth/ChallengeBoundAppleSignInButton.swift",
);
const appleAuthPolicy = optionalRead("ios/Sources/Security/AppleAuthRequestPolicy.swift");
const authLifecycle = optionalRead("ios/Sources/Security/AuthGenerationGate.swift");
const keychainSessionStore = read("ios/Sources/Security/KeychainSessionStore.swift");
const aiConsentPolicy = optionalRead("ios/Sources/Privacy/AIConsentPolicy.swift");
const accountDeletionCleanupStore = optionalRead(
  "ios/Sources/Privacy/AccountDeletionCleanupStore.swift",
);
const postReminderScheduler = read(
  "ios/Sources/Notifications/DailyPostReminderScheduler.swift",
);
const accountDeletionPolicy = optionalRead(
  "ios/Sources/Features/Settings/AccountDeletionPolicy.swift",
);
const settings = optionalRead("ios/Sources/Features/Settings/SettingsView.swift");
const appIconContents = read("ios/Resources/Assets.xcassets/AppIcon.appiconset/Contents.json");
const brandMarkContents = read("ios/Resources/Assets.xcassets/BrandMark.imageset/Contents.json");
const appIcon = readFileSync(
  path.join(root, "ios/Resources/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png"),
);
const sourceRoot = path.join(root, "ios/Sources");
const swift = readdirSync(sourceRoot, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".swift"))
  .map((entry) => readFileSync(path.join(entry.parentPath, entry.name), "utf8"))
  .join("\n");

assert.match(project, /PRODUCT_NAME:\s*afterimage/);
assert.match(project, /IPHONEOS_DEPLOYMENT_TARGET:\s*["']?26\.0/);
assert.match(project, /path:\s*Resources\/PrivacyInfo\.xcprivacy\s*\n\s+buildPhase:\s*resources/);
assert.match(info, /<key>NSLocationWhenInUseUsageDescription<\/key>/);
assert.match(info, /<key>NSCameraUsageDescription<\/key>/);
assert.match(info, /<key>NSMicrophoneUsageDescription<\/key>/);
assert.match(entitlements, /<key>com\.apple\.developer\.weatherkit<\/key>\s*<true\/>/);
assert.match(weatherBadge, /\.symbolRenderingMode\(\.hierarchical\)/);
assert.match(weatherBadge, /\.tint\(\.secondary\)/);
assert.match(
  weatherTemperatureFormatter,
  /numberFormatStyle:\s*\.number\.precision\(\.fractionLength\(0\)\)/,
  "weather temperatures must be formatted without fractional digits",
);
assert.match(
  weatherBadge,
  /DailyWeatherTemperatureFormatter\.string\(celsius:\s*celsius\)/,
  "weather badge must use the whole-degree temperature formatter",
);
assert.match(privacy, /<key>NSPrivacyTracking<\/key>\s*<false\/>/);
for (const category of [
  "NSPrivacyCollectedDataTypePreciseLocation",
  "NSPrivacyCollectedDataTypeAudioData",
  "NSPrivacyCollectedDataTypeName",
  "NSPrivacyCollectedDataTypeEmailAddress",
  "NSPrivacyCollectedDataTypeUserID",
  "NSPrivacyCollectedDataTypePhotosorVideos",
  "NSPrivacyCollectedDataTypeOtherUserContent",
]) {
  assert.ok(privacy.includes(category), `missing privacy declaration: ${category}`);
}
const userDefaultsAccess = privacy.match(
  /<dict>\s*<key>NSPrivacyAccessedAPIType<\/key>\s*<string>NSPrivacyAccessedAPICategoryUserDefaults<\/string>\s*<key>NSPrivacyAccessedAPITypeReasons<\/key>\s*<array>([\s\S]*?)<\/array>\s*<\/dict>/,
)?.[1];
assert.ok(userDefaultsAccess, "missing UserDefaults required-reason declaration");
assert.match(userDefaultsAccess, /<string>CA92\.1<\/string>/);
assert.ok(!swift.includes("#available"), "iOS 26-only app must not carry legacy availability branches");
assert.match(
  apiModels,
  /struct AssetCreationQuotaDetails:[\s\S]*?let limit: Int[\s\S]*?let remaining: Int[\s\S]*?let resetsAt: Date/,
  "asset quota errors must decode limit, remaining slots, and the rolling-window reset time",
);
assert.match(
  apiModels,
  /case assetCreationQuotaExceeded\(limit: Int, remaining: Int, resetsAt: Date\)/,
  "asset quota errors must retain structured details for localized presentation",
);
assert.match(
  apiModels,
  /resetsAt\.formatted\(date: \.numeric, time: \.standard\)/,
  "asset quota errors must show the exact reset timestamp, including seconds",
);
assert.match(
  apiClient,
  /\.assetCreationQuotaExceeded\([\s\S]*?limit:[\s\S]*?remaining:[\s\S]*?resetsAt:/,
  "APIClient must map structured asset quota details into a user-facing error",
);
assert.ok(!swift.includes("ultraThinMaterial"), "iOS 26-only app must not carry a Material fallback");
assert.match(
  dayStory,
  /Color\(\.tertiarySystemFill\)[\s\S]*?\.aspectRatio\(4\.0\s*\/\s*3\.0,\s*contentMode:\s*\.fit\)[\s\S]*?\.overlay\s*\{[\s\S]*?AuthenticatedThumbnail\(asset:\s*asset\)/,
  "day story hero must use an intrinsic-size-free container",
);
assert.match(
  dayStory,
  /Color\(\.tertiarySystemFill\)[\s\S]*?\.frame\(width:\s*64,\s*height:\s*64\)[\s\S]*?\.overlay\s*\{[\s\S]*?AuthenticatedThumbnail\(asset:\s*asset\)/,
  "day story strip cells must use an intrinsic-size-free container",
);
assert.doesNotMatch(
  dayStory,
  /AuthenticatedThumbnail\(asset:\s*asset\)[\s\S]{0,240}?\.aspectRatio\([\s\S]{0,40}?contentMode:\s*\.fill\)/,
  "thumbnail aspect ratios must not participate in layout sizing",
);
assert.doesNotMatch(
  swift,
  /opensMaps:\s*false/,
  "every displayed capture location must link to Apple Maps",
);
assert.ok(
  swift.includes("MKReverseGeocodingRequest"),
  "capture locations must resolve to a user-readable place name",
);
assert.doesNotMatch(
  captureLocationChip,
  /coordinateLabel/,
  "capture location chips must not expose raw coordinates",
);
assert.match(
  captureLocationChip,
  /L10n\.string\("capture\.location\.open_maps"\)/,
  "capture location chips must keep a readable Maps fallback while geocoding",
);
assert.match(
  captureLocationChip,
  /CapturePlaceNamePresentation\.label\([\s\S]*resolvedPlace: resolvedPlace/,
  "capture location chips must not reuse a resolved name for a different location",
);
assert.match(
  swift,
  /private var requestWaiters: \[CheckedContinuation<Void, Never>\]/,
  "reverse geocoding requests must be serialized to avoid request bursts",
);
assert.match(
  swift,
  /failedUntil/,
  "failed reverse geocoding requests must use a retry backoff",
);
assert.match(
  swift,
  /isCoordinatePair/,
  "MapKit fallback names must not reintroduce raw coordinate pairs",
);
assert.match(
  dayStorySection,
  /story\.hero\.location[\s\S]*?CaptureLocationChip\(location:\s*location\)/,
  "timeline location must be a standalone Apple Maps link",
);
assert.doesNotMatch(
  dayStoryHero,
  /CaptureLocationChip/,
  "timeline location link must not be nested inside the hero NavigationLink",
);
assert.match(
  dayStorySection,
  /if let summary = dailySummary\?\.summary[\s\S]*?Text\(verbatim:\s*summary\)[\s\S]*?\.lineLimit\(3\)/,
  "the generated daily summary must be shown above the hero and capped at three lines",
);
assert.doesNotMatch(
  dayStorySection,
  /story\.quote/,
  "raw transcript quotes must not be rendered in the timeline",
);
assert.match(apiModels, /struct DailySummaryResponse:\s*Codable,\s*Equatable,\s*Sendable/);
assert.match(apiModels, /let sourceVisualAnalysisCount:\s*Int/);
assert.match(apiClient, /components\.path\s*=\s*"\/v1\/days\/summary"/);
for (const symbol of [
  "struct MemorySearchPage: Codable, Equatable, Sendable",
  "struct MemorySearchResult: Codable, Identifiable, Hashable, Sendable",
  "struct MemorySearchView: View",
  "MemorySearchPolicy.query",
]) {
  assert.ok(swift.includes(symbol), `missing Mage iOS contract symbol: ${symbol}`);
}
assert.match(apiClient, /components\.path\s*=\s*"\/v1\/memories\/search"/);
assert.match(timeline, /Button\s*\{\s*isShowingMemorySearch\s*=\s*true[\s\S]*?Image\(systemName:\s*"magnifyingglass"\)/);
assert.match(timeline, /\.sheet\(isPresented:\s*\$isShowingMemorySearch\)\s*\{\s*MemorySearchView\(\)\s*\}/);
assert.match(memorySearch, /Task\.sleep\(for:\s*\.milliseconds\(300\)\)/);
assert.match(memorySearch, /searchTask\?\.cancel\(\)/);
assert.match(memorySearch, /paginationTask\?\.cancel\(\)/);
assert.match(memorySearch, /result\.match\.kind/);
assert.match(memorySearch, /result\.match\.text/);
assert.match(memorySearch, /result\.match\.startMs/);
assert.match(memorySearch, /result\.visualSummary/);
assert.match(memorySearch, /nextCursor\s*=\s*page\.nextCursor/);
assert.match(memorySearch, /MemoryDetailView\([\s\S]*?asset:\s*result\.asset,[\s\S]*?standalone:\s*true,[\s\S]*?initialSeekMs:\s*result\.match\.startMs/);
assert.match(memoryDetail, /MemoryPagerPolicy\.assets\([\s\S]*?standalone:\s*standalone/);
for (const symbol of [
  "struct VideoAnalysisResponse: Codable, Equatable, Sendable",
  "struct VideoAnalysisSheet: View",
  "VideoAnalysisPollingPolicy.shouldPoll",
  "MemorySeekPolicy.seconds",
]) {
  assert.ok(swift.includes(symbol), `missing Mage iOS contract symbol: ${symbol}`);
}
assert.match(apiClient, /"\/v1\/assets\/\\\(assetID\)\/analysis"/);
assert.match(swift, /Task\.sleep\(for:\s*\.seconds\([5-9]\)\)/);
assert.match(swift, /controller\.scrubBegan\(\)[\s\S]*?controller\.scrub\(to:\s*seconds\)[\s\S]*?controller\.scrubEnded\(\)/);
assert.match(swift, /@Binding var requestedSeek: MemorySeekRequest\?/);
assert.match(swift, /MemorySeekRequest\(assetID:\s*currentAsset\.id,\s*startMs:\s*startMs\)/);
assert.match(
  timeline,
  /\.photosPicker\([\s\S]*?isPresented:\s*\$isShowingLibrary[\s\S]*?photoLibrary:\s*\.shared\(\)[\s\S]*?\)/,
  "media picker must be presented outside the menu and provide stable photo library item identifiers",
);
assert.match(
  timeline,
  /if\s+let\s+upload\s*=\s*model\.upload[\s\S]*UploadStatusBar\([\s\S]*?upload:\s*upload,[\s\S]*?isPreviewPlaybackAllowed:/,
  "active imports and uploads must use the bottom upload status bar",
);
assert.match(
  uploadPreviewPlayer,
  /AVQueuePlayer[\s\S]*AVPlayerLooper/,
  "the upload preview must loop the staged local video without controls",
);
assert.match(
  uploadPreviewPlayer,
  /player\.isMuted\s*=\s*true[\s\S]*player\.preventsDisplaySleepDuringVideoPlayback\s*=\s*false/,
  "the upload preview must stay silent without preventing display sleep",
);
assert.match(
  uploadPreviewPlayer,
  /videoGravity\s*=\s*\.resizeAspectFill/,
  "the 16:9 upload preview must crop aspect-fill",
);
assert.match(
  uploadPreviewPlayer,
  /FileManager\.default\.fileExists\(atPath:\s*preview\.mediaURL\.path\)[\s\S]*isPrepared\s*=\s*true/,
  "a missing staged file must keep the preview placeholder visible",
);
assert.match(
  uploadPreviewPlayer,
  /func\s+stop\(\)[\s\S]*looper\?\.disableLooping\(\)[\s\S]*looper\s*=\s*nil[\s\S]*player\.removeAllItems\(\)/,
  "the upload preview must detach stale player items and loop observers",
);
assert.match(
  backgroundUploadManager,
  /struct\s+UploadPreviewDescriptor[\s\S]*generationID:\s*UUID[\s\S]*assetID:\s*String[\s\S]*mediaURL:\s*URL[\s\S]*contentType:\s*String/,
  "the preview descriptor must bind staged media to its upload generation and asset",
);
assert.match(
  backgroundUploadManager,
  /var\s+currentPreviewDescriptor:\s*UploadPreviewDescriptor\?[\s\S]*!cancellationRequested[\s\S]*contentType\.hasPrefix\("video\/"\)[\s\S]*mediaURL\.isFileURL/,
  "cancelled, non-video, and remote media must never become an upload preview",
);
assert.match(
  uploadPreviewPlayer,
  /@Environment\(\\\.scenePhase\)[\s\S]*@Environment\(\\\.accessibilityReduceMotion\)[\s\S]*scenePhase\s*==\s*\.active/,
  "the upload preview must stop decoding while inactive and honor Reduce Motion",
);
assert.match(
  timeline,
  /UploadDock\([\s\S]*previewPlaybackAllowed:[\s\S]*cameraRoute\s*==\s*nil[\s\S]*!isShowingMemorySearch[\s\S]*!isShowingSettings/,
  "covered timeline surfaces must pause the upload preview",
);
assert.match(
  appModel,
  /preview:\s*manager\.currentPreviewDescriptor/,
  "a relaunched background upload must restore its generation-scoped preview descriptor",
);
assert.match(
  appModel,
  /enum\s+UploadHandoffGate[\s\S]*Task\.checkCancellation\(\)/,
  "the upload handoff gate must reject a cancelled task",
);
assert.match(
  appModel,
  /let\s+context\s*=\s*try\s+await\s+api\.backgroundUploadContext\(\)[\s\S]{0,220}?guard\s+context\.ownerID\s*==\s*operationScope\.ownerID[\s\S]{0,160}?try\s+UploadHandoffGate\.checkCancellation\(\)[\s\S]*BackgroundUploadManager\.shared\.startUpload\(/,
  "cancellation must be checked after the final await and before background upload handoff",
);
assert.match(
  appModel,
  /case\s+\.success:\s*self\.upload\?\.beginFinalizing\(\)\s*await\s+self\.postReminderScheduler\.recordPost\(\)/,
  "successful background upload must detach the staged preview before post-upload awaits",
);
assert.match(
  appModel,
  /enum\s+UploadCancellationCleanup[\s\S]*Task\.detached[\s\S]*await\s+cleanup\.value/,
  "remote asset cleanup must run independently from the cancelled upload task",
);
assert.match(
  appModel,
  /if\s+let\s+remoteAssetID[\s\S]*await\s+UploadCancellationCleanup\.run[\s\S]*api\.deleteAsset\(assetID:\s*remoteAssetID\)/,
  "pre-handoff cancellation must use cancellation-independent remote cleanup",
);
assert.match(
  timeline,
  /Menu\s*\{[\s\S]*?Button\([\s\S]*?camera\.source\.record[\s\S]*?Button\([\s\S]*?camera\.source\.library[\s\S]*?isShowingLibrary\s*=\s*true[\s\S]*?\}\s*label:\s*\{\s*Image\(systemName:\s*"plus"\)[\s\S]*?\}\s*\.buttonStyle\(\.glassProminent\)\s*\.buttonBorderShape\(\.circle\)/,
  "upload source menu must trigger the external picker from an icon-only circular prominent glass button",
);
assert.doesNotMatch(
  mediaImporter,
  /PHAsset\.fetchAssets/,
  "media import must not request full photo library access",
);
assert.doesNotMatch(
  timeline,
  /upload\.duplicates\.hint_(?:title|detail)/,
  "upload dock must not show a permanent duplicate-upload hint",
);
assert.match(timeline, /matching:\s*\.videos/, "media picker must show only videos");
assert.doesNotMatch(timeline, /matching:[^\n]*\.images/, "media picker must not show images");
assert.match(timeline, /\.accessibilityLabel\("動画を追加"\)/, "media picker label must describe video-only selection");
assert.doesNotMatch(timeline, /写真や動画を(?:追加|選ぶ)/, "timeline copy must describe video-only selection");
assert.match(
  timeline,
  /\.task\s*\{\s*await model\.recordTodayWeather\(\)\s*\}/,
  "initial timeline display must record missing daily weather",
);
assert.match(
  timeline,
  /Button\("再読み込み"[\s\S]{0,240}?refreshTimelineReportingFailure\(\)[\s\S]{0,120}?recordTodayWeather\(\)/,
  "account-menu reload must record missing daily weather after refreshing assets",
);
assert.match(
  appModel,
  /func loadMoreIfNeeded\(after asset: Asset\)[\s\S]{0,1200}?loadDailyWeather\(for: additions,\s*authScope:\s*authScope\)[\s\S]{0,120}?recordTodayWeather\(\)/,
  "pagination must record missing daily weather after appending visible assets",
);
assert.match(
  backgroundUploadManager,
  /private\s+lazy\s+var\s+backgroundSession:\s*URLSession/,
  "the background session must be created lazily after UIKit provides its relaunch completion handler",
);
assert.match(
  backgroundUploadManager,
  /func\s+handleBackgroundSessionEvents[\s\S]*systemCompletionHandler\s*=[\s\S]*_\s*=\s*backgroundSession/,
  "UIKit relaunch completion handler must be stored before the background session is recreated",
);
assert.match(
  backgroundUploadManager,
  /urlSessionDidFinishEvents[\s\S]*pendingSystemCompletionScope\s*=\s*scope[\s\S]*scheduleCurrentTransfers\(ifCurrent:\s*scope\)/,
  "UIKit background events must not be completed before replacement transfer tasks are scheduled",
);
assert.match(
  backgroundUploadManager,
  /private\s+func\s+handleTransferFailure[\s\S]*BackgroundUploadRetryPolicy\.disposition/,
  "background transfer failures must apply the bounded retry policy",
);
assert.match(
  backgroundUploadManager,
  /private\s+var\s+progressHandler:\s*\(@MainActor/,
  "progress callbacks must be isolated to the main actor",
);
assert.match(
  backgroundUploadManager,
  /private\s+func\s+reportProgress[\s\S]*Task\s*\{\s*@MainActor[\s\S]*lock\.withLock[\s\S]*isActiveCurrentLocked\(scope\)[\s\S]*progressHandler\?\(/,
  "progress scope validation and callback delivery must be linearized on the main actor",
);
assert.match(
  backgroundUploadManager,
  /reportProgress[\s\S]*Task\s*\{\s*@MainActor[\s\S]*max\([\s\S]*currentProgressLocked\(\)[\s\S]*lastDeliveredProgress/,
  "progress delivery must recompute the latest value and reject regressions on the main actor",
);
assert.match(
  backgroundUploadManager,
  /resumePendingUpload[\s\S]*retryAfterFailure:\s*Bool\s*=\s*false[\s\S]*if\s+retryAfterFailure,\s*isPausedAfterFailure/,
  "only an explicit foreground retry may clear a persisted terminal pause",
);
assert.match(
  appModel,
  /bootstrap\(\)[\s\S]*resumeBackgroundUploadIfNeeded\([\s\S]{0,120}?retryAfterFailure:\s*false,[\s\S]{0,120}?adoptLegacyOwner:\s*true/,
  "background bootstrap must reattach without clearing terminal retry bounds",
);
assert.match(
  appRoot,
  /scenePhase\s*==\s*\.active[\s\S]*resumeBackgroundUploadIfNeeded\(retryAfterFailure:\s*false\)/,
  "automatic foreground activation must not clear a terminal pause",
);
assert.match(
  appModel,
  /func\s+retryBackgroundUpload\(\)\s+async[\s\S]*resumeBackgroundUploadIfNeeded\(retryAfterFailure:\s*true\)/,
  "only the explicit retry action may rearm a terminal upload",
);
const signOutBody = declarationScope(appModel, /func signOut\(\) async/, "AppModel.signOut");
assert.match(
  signOutBody,
  /beginAuthGeneration\([\s\S]*guard\s+cleanupSucceeded[\s\S]*revokeSession\(\)[\s\S]*clearLocalSession\(ifCurrent:/,
  "sign-out must not revoke or clear credentials before remote upload cleanup succeeds",
);
const beginAuthBody = declarationScope(
  appModel,
  /private func beginAuthGeneration\(/,
  "AppModel.beginAuthGeneration",
);
assert.match(
  beginAuthBody,
  /let\s+activeUploadTask\s*=\s*uploadTask[\s\S]*activeUploadTask\?\.cancel\(\)[\s\S]*cancelAllAndWaitForCleanup\([\s\S]*await\s+activeUploadTask\.value/,
  "sign-out must await pre-handoff upload cancellation and remote cleanup before revoking credentials",
);
assert.doesNotMatch(
  appModel,
  /haptics\.notify\(/,
  "AppModel must use the HapticEngine.play API",
);
assert.match(
  appModel,
  /if\s+didHandOff,\s*!wasCancelled,\s*BackgroundUploadManager\.shared\.requiresExplicitRetry\s*\{[\s\S]{0,160}?backgroundUploadNeedsRetry\s*=\s*true/,
  "an exhausted initial background upload must expose the explicit retry action",
);
const scheduleAfterInspecting = declaration(
  backgroundUploadManager,
  "private func scheduleAfterInspecting(",
);
assert.match(
  scheduleAfterInspecting,
  /guard\s+let\s+session\s*=\s*storedSession\s*\?\?\s*\(try\?\s*KeychainSessionStore\(\)\.load\(\)\)/,
  "replacement transfers must wait for Keychain bootstrap instead of failing without a session",
);
assert.match(
  scheduleAfterInspecting,
  /BackgroundUploadAuthorizationPolicy\.canUse\([\s\S]*owner:\s*state\.authContext,[\s\S]*current:\s*session\.context/,
  "replacement transfers must reject credentials from another account context",
);
assert.match(
  backgroundUploadManager,
  /finalizeCurrentItem[\s\S]*deferredForCredentials[\s\S]*completeSystemEventsIfPossible\(\)/,
  "finalization must wait for Keychain bootstrap and release UIKit background events",
);
assert.match(
  backgroundUploadManager,
  /finalizeCurrentItem[\s\S]*retryNotBeforeByTransfer\[retryDescription\][\s\S]*Task\.sleep[\s\S]*deferredForBackoff/,
  "finalization must rebuild a persisted backoff timer after process relaunch",
);
assert.match(
  backgroundUploadManager,
  /private\s+func\s+finalizationFailed[\s\S]*BackgroundUploadRetryPolicy\.disposition/,
  "ambiguous finalization failures must apply the bounded retry policy",
);
assert.match(
  backgroundUploadManager,
  /struct\s+BackgroundUploadTaskIdentity[\s\S]*generationID:\s*UUID[\s\S]*init\?\(description:/,
  "every URLSession task must carry a parseable upload generation",
);
assert.match(
  backgroundUploadManager,
  /struct\s+BackgroundUploadState[\s\S]*generationID:\s*UUID[\s\S]*pausedAfterFailure:\s*Bool[\s\S]*cancellationRequested:\s*Bool[\s\S]*retryAttemptsByTransfer:\s*\[String:\s*Int\][\s\S]*retryNotBeforeByTransfer:\s*\[String:\s*Date\][\s\S]*var\s+currentItem:/,
  "the upload generation, terminal state, retry attempts, and retry deadlines must survive process relaunch",
);
assert.match(
  backgroundUploadManager,
  /private\s+override\s+init\(\)[\s\S]*retryAttemptsByTransfer\s*=\s*state\.retryAttemptsByTransfer[\s\S]*retryNotBeforeByTransfer\s*=\s*state\.retryNotBeforeByTransfer/,
  "retry state must be restored after process relaunch",
);
assert.match(
  backgroundUploadManager,
  /private\s+func\s+saveStateLocked\(\)[\s\S]*state\.retryAttemptsByTransfer\s*=\s*retryAttemptsByTransfer[\s\S]*state\.retryNotBeforeByTransfer\s*=\s*retryNotBeforeByTransfer/,
  "every state save must include current retry attempts and deadlines",
);
assert.match(
  backgroundUploadManager,
  /parsed\.generationID\s*==\s*state\.generationID/,
  "URLSession callbacks must reject tasks from another upload generation",
);
assert.match(
  backgroundUploadManager,
  /urlSessionDidFinishEvents[\s\S]*guard\s+!isPausedAfterFailure/,
  "a terminal failure must pause automatic background rescheduling",
);
assert.match(
  backgroundUploadManager,
  /urlSessionDidFinishEvents[\s\S]*finalizationRetryTask\s*==\s*nil/,
  "background events must be released instead of reopening finalization during backoff",
);
assert.match(
  backgroundUploadManager,
  /private\s+var\s+finalizationRetryTask:\s*Task<Void, Never>\?/,
  "delayed finalization retries must be tracked and cancellable",
);
assert.match(
  backgroundUploadManager,
  /finalizationFailed\(error,\s*scope:\s*scope,\s*taskID:\s*taskID\)/,
  "finalization failures must stay bound to the upload scope and task that produced them",
);
assert.match(
  backgroundUploadManager,
  /retryFinalizationIfCurrent[\s\S]*isActiveCurrentLocked\(scope\)[\s\S]*finalizeCurrentItem\(ifCurrent:\s*scope\)/,
  "a delayed finalization retry must not finalize another upload scope",
);
assert.match(
  backgroundUploadManager,
  /retryFinalizationIfCurrent[\s\S]*finalizationRetryID\s*==\s*retryID/,
  "an obsolete delayed retry must not clear or supersede a newer retry generation",
);
assert.match(
  backgroundUploadManager,
  /finalizationSucceeded[\s\S]*isActiveCurrentLocked\(scope\)/,
  "a finalization callback must not report success after cancellation or for another upload generation",
);
assert.match(
  backgroundUploadManager,
  /finalizationFailed[\s\S]*isActiveCurrentLocked\(scope\)[\s\S]*applyFailureLocked\(ifCurrent:\s*scope\)/,
  "a finalization callback must not report failure after cancellation or for another upload generation",
);
assert.match(
  backgroundUploadManager,
  /finalizationFailed[\s\S]*retryScheduled[\s\S]*completeSystemEventsIfPossible\(\)/,
  "a delayed finalization retry must release UIKit background events before backoff",
);
assert.doesNotMatch(
  backgroundUploadManager,
  /private\s+func\s+completeSystemEventsIfPossible\(\)[\s\S]{0,500}?!isFinalizing/,
  "UIKit background-session completion must not wait on authenticated finalization requests",
);
assert.match(
  backgroundUploadManager,
  /if\s+action\.finalize[\s\S]{0,180}?finalizeCurrentItem\(ifCurrent:\s*scope\)[\s\S]{0,120}?completeSystemEventsIfPossible\(\)/,
  "starting authenticated finalization must promptly release UIKit background-session events",
);
const cancelAllBody = declarationScope(
  backgroundUploadManager,
  /func cancelAll\(/,
  "BackgroundUploadManager.cancelAll",
);
assert.match(
  cancelAllBody,
  /state\.cancellationRequested\s*=\s*true[\s\S]*finishCancellation\(ifCurrentGeneration:\s*generationID\)/,
  "cancellation cleanup must remain bound to the generation that requested it",
);
assert.match(
  cancelAllBody,
  /finalizationTask\?\.cancel\(\)[\s\S]*finishCancellation\(ifCurrentGeneration:/,
  "cancellation must stop generation-scoped authenticated finalization",
);
const finishCancellationBody = declarationScope(
  backgroundUploadManager,
  /private func finishCancellation\(/,
  "BackgroundUploadManager.finishCancellation",
);
assert.match(
  finishCancellationBody,
  /deleteAsset\(assetID:\s*assetID\)[\s\S]*finishCancellationCleanup/,
  "remote deletion must complete before cancellation cleanup is finalized",
);
const finishCancellationCleanupBody = declarationScope(
  backgroundUploadManager,
  /private func finishCancellationCleanup\(/,
  "BackgroundUploadManager.finishCancellationCleanup",
);
assert.match(
  finishCancellationCleanupBody,
  /removeStagedFiles[\s\S]*clearStateLocked\(\)/,
  "cancellation state must remain persisted until authenticated remote deletion succeeds",
);
const cancelAndWaitBody = declarationScope(
  backgroundUploadManager,
  /func cancelAllAndWaitForCleanup\(/,
  "BackgroundUploadManager.cancelAllAndWaitForCleanup",
);
assert.match(
  cancelAndWaitBody,
  /withCheckedContinuation[\s\S]*cancelAll\(context:\s*context,\s*cleanupCompletion:/,
  "sign-out must be able to await generation-scoped remote cancellation cleanup",
);
assert.match(
  backgroundUploadManager,
  /reportProgress[\s\S]*isActiveCurrentLocked\(scope\)[\s\S]*progressHandler/,
  "progress callbacks must be captured under the lock and scoped to one upload generation",
);
assert.match(
  appRoot,
  /@Environment\(\\\.scenePhase\)/,
  "the app must observe foreground activation to reconnect a pending upload",
);
for (const symbol of [
  "GlassEffectContainer",
  ".glassEffect",
  "CHHapticEngine",
  "SignInWithAppleButton",
  "PhotosPicker",
  "loadTransferable",
  "FileHandle",
  "AVVideoCodecType.hevc",
  "maximumBitRate: 3_000_000",
  "PumpCancellationRelay",
  "AVAssetReaderTrackOutput(track: audioTrack, outputSettings: nil)",
  "AVAssetWriterInput(mediaType: .audio, outputSettings: nil",
  "CGImageDestinationLossyCompressionQuality",
  "partUrlTemplate",
  "replacingOccurrences(of: \"{partNumber}\"",
  "/upload/complete",
  "AVPlayer",
  "AVPlayerLayer",
  "navigationTransition",
  "matchedTransitionSource",
  "/playback",
  "resolver.isAPIOrigin(url)",
  "/v1/auth/session",
  "CLLocationUpdate.liveUpdates",
  "WeatherService.shared",
  "AVCaptureMovieFileOutput",
  "AVCaptureVideoPreviewLayer",
  "AVCaptureDevice.RotationCoordinator",
]) {
  assert.ok(swift.includes(symbol), `missing iOS contract symbol: ${symbol}`);
}

assert.ok(!swift.includes("AVEncoderBitRateKey"), "audio must never be re-encoded");

const appleBinding = declaration(appleAuthPolicy, "enum AppleAuthRequestPolicy");
assert.match(appleBinding, /SHA256\.hash/);
assert.match(appleBinding, /request\.nonce\s*=\s*binding\.hashedNonce/);
assert.doesNotMatch(appleBinding, /UserDefaults|print\(|NSLog|Logger/);
const appleChallengeModel = declaration(apiModels, "struct AppleAuthChallenge");
assert.match(appleChallengeModel, /Decodable/);
assert.doesNotMatch(appleChallengeModel, /\bCodable\b/);
const appleAttemptState = declaration(appleAuthPolicy, "struct AppleAuthAttemptState");
assert.match(appleAttemptState, /mutating\s+func\s+consume/);
assert.match(appleAttemptState, /mutating\s+func\s+finish/);
assert.doesNotMatch(appleAttemptState, /nonce:\s*String/);

const appleButton = declaration(
  appleAuthorizationButton,
  "struct ChallengeBoundAppleSignInButton: View",
);
assert.match(appleButton, /SignInWithAppleButton/);
assert.match(appleButton, /AppleAuthRequestPolicy\.configure/);
assert.match(appleButton, /attemptState\.finish\(\)/);
assert.match(login, /ChallengeBoundAppleSignInButton/);

const apiChallenge = declaration(apiClient, "func appleAuthChallenge() async throws");
assert.match(apiChallenge, /"\/v1\/auth\/apple\/challenge"/);
const apiSignIn = declaration(apiClient, "func signIn(");
assert.match(apiSignIn, /challengeId/);
assert.match(apiSignIn, /"\/v1\/auth\/apple"/);
const apiConsent = declaration(apiClient, "func aiConsent() async throws");
assert.match(apiConsent, /"\/v1\/privacy\/ai"/);
const apiUpdateConsent = declaration(apiClient, "func updateAIConsent(");
assert.match(apiUpdateConsent, /"\/v1\/privacy\/ai"/);
const accountDeletionReauthorization = declaration(
  apiClient,
  "struct AccountDeletionReauthorization",
);
assert.match(accountDeletionReauthorization, /authorizationCode/);
assert.match(accountDeletionReauthorization, /identityToken/);
assert.match(accountDeletionReauthorization, /challengeId/);
const apiDeleteAccount = declaration(apiClient, "func deleteAccount(");
assert.match(apiDeleteAccount, /"\/v1\/account"/);
assert.match(apiDeleteAccount, /AccountDeletionReauthorization/);

const authGate = declaration(authLifecycle, "actor AuthGenerationGate");
assert.match(authGate, /invalidatedGenerations/);
assert.match(authGate, /terminationTasks/);
assert.match(authGate, /terminatedGenerations/);
assert.match(authGate, /guard\s+!invalidatedGenerations\.contains/);
assert.match(authGate, /func\s+invalidate/);
const sessionExpiredHandler = declaration(
  appModel,
  "private func handleIfSessionExpired",
);
assert.doesNotMatch(
  sessionExpiredHandler,
  /private func handleIfSessionExpired[^\{]*\basync\b/,
  "session-expiration detection must remain synchronous so show(error:) compiles",
);
assert.match(sessionExpiredHandler, /invalidatesSession\s*==\s*true/);
const showError = declaration(appModel, "private func show(error:");
assert.match(showError, /if\s+handleIfSessionExpired\(error\)\s*\{\s*return\s*\}/);
const createMCPToken = declaration(appModel, "func createMCPToken(");
assert.match(
  createMCPToken,
  /return\s+try\s+await\s+withSessionInvalidation/,
  "createMCPToken must return the API response after its consent guard",
);
const sessionStore = declaration(keychainSessionStore, "final class KeychainSessionStore");
const compareAndSwapClear = declaration(sessionStore, "func clear(ifCurrent");
assert.match(compareAndSwapClear, /SessionCASPolicy\.canClear/);

const retryPolicy = declaration(backgroundUploadManager, "enum BackgroundUploadRetryPolicy");
assert.match(retryPolicy, /httpStatus\s*==\s*401[\s\S]*\.expireSession/);
const transferFailure = declaration(
  backgroundUploadManager,
  "private func handleTransferFailure(",
);
assert.match(transferFailure, /case\s+\.expireSession/);
assert.match(transferFailure, /AuthGenerationGate\.shared\.invalidate/);

const consentPolicy = declaration(aiConsentPolicy, "enum AIConsentPolicy");
assert.match(consentPolicy, /currentVersion/);
assert.match(consentPolicy, /canTransferExternally/);
assert.match(consentPolicy, /canEnableAgentAccess/);
const settingsView = declaration(settings, "struct SettingsView: View");
const updateAIConsent = declaration(appModel, "func updateAIConsent(");
const setAgentAccess = declaration(appModel, "func setAgentAccess(");
for (const consentBoundary of [
  consentPolicy,
  settingsView,
  updateAIConsent,
  setAgentAccess,
]) {
  assert.doesNotMatch(
    consentBoundary,
    /UserDefaults/,
    "AI consent authority must remain server-backed",
  );
}
const assetDecoding = declaration(apiModels, "extension Asset");
assert.match(
  assetDecoding,
  /agentAccessEnabled\s*=\s*try[\s\S]*\?\?\s*false/,
);

const deletionPolicy = declaration(accountDeletionPolicy, "enum AccountDeletionPolicy");
assert.match(deletionPolicy, /backendAccepted/);
assert.match(deletionPolicy, /localCleanupFailed/);
const deleteAccount = declaration(appModel, "func deleteAccount() async");
assert.match(deleteAccount, /api\.deleteAccount\(reauthorization:\s*reauthorization\)/);
assert.match(deleteAccount, /finishAcceptedAccountDeletionCleanup/);
assert.match(deleteAccount, /clearLocalSession/);
const reauthenticateAndDelete = declaration(
  appModel,
  "func reauthenticateAndDeleteAccount(",
);
assert.doesNotMatch(reauthenticateAndDelete, /api\.signIn\(/);
assert.match(
  reauthenticateAndDelete,
  /pendingAccountDeletionReauthorization\s*=\s*AccountDeletionReauthorization\([\s\S]*authorizationCode:\s*authorizationCode,[\s\S]*identityToken:\s*identityToken,[\s\S]*challengeId:\s*challengeID[\s\S]*deleteAccount\(\)/,
);
const acceptedDeletionCleanup = declaration(
  appModel,
  "private func finishAcceptedAccountDeletionCleanup(",
);
assert.match(acceptedDeletionCleanup, /discardAfterAccountDeletionAndWait/);
assert.match(acceptedDeletionCleanup, /LocalMediaFileCleanup\.purge/);
assert.match(acceptedDeletionCleanup, /clearPersistedSessionForAcceptedDeletion/);
const bootstrap = declaration(appModel, "func bootstrap() async");
assert.match(
  bootstrap,
  /accountDeletionCleanupStore\.pendingGenerationID[\s\S]*finishAcceptedAccountDeletionCleanup\(\)[\s\S]*sessionStore\.load\(\)/,
);
const deletionCleanupStore = declaration(
  accountDeletionCleanupStore,
  "final class AccountDeletionCleanupStore",
);
assert.doesNotMatch(deletionCleanupStore, /token|accountID|consent/i);
const removeReminderNotifications = declaration(
  postReminderScheduler,
  "private func removePendingReminders() async",
);
assert.match(removeReminderNotifications, /removePendingNotificationRequests/);
assert.match(removeReminderNotifications, /removeDeliveredNotifications/);
assert.match(settingsView, /account\.delete\.scope/);
assert.match(settingsView, /ChallengeBoundAppleSignInButton/);
const accountSettingsSection = declaration(settings, "private var accountSection");
assert.match(
  accountSettingsSection,
  /Section\s*\{[\s\S]*\}\s*header:\s*\{\s*Text\(L10n\.string\("account\.settings\.title"\)\)/,
  "footer-bearing account section must use the explicit content/header/footer initializer",
);

const legalPolicy = declaration(apiClient, "enum LegalURLPolicy");
assert.match(legalPolicy, /scheme\?\.lowercased\(\)\s*==\s*"https"/);
const legalPage = declaration(apiClient, "enum LegalPage");
for (const pathName of ["privacy", "support", "terms"]) {
  assert.ok(
    legalPage.includes(`case ${pathName}`),
    `missing legal page case: ${pathName}`,
  );
  assert.ok(
    legalPage.includes(`case .${pathName}: "/${pathName}"`),
    `missing legal page path: /${pathName}`,
  );
}
assert.match(login, /legalURL\(\.privacy\)/);
assert.match(login, /legalURL\(\.support\)/);
assert.match(login, /legalURL\(\.terms\)/);
assert.match(settingsView, /legalURL\(\.privacy\)/);
assert.match(settingsView, /legalURL\(\.support\)/);
assert.match(settingsView, /legalURL\(\.terms\)/);


function paeth(left, up, upLeft) {
  const estimate = left + up - upLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const diagonalDistance = Math.abs(estimate - upLeft);
  if (leftDistance <= upDistance && leftDistance <= diagonalDistance) return left;
  if (upDistance <= diagonalDistance) return up;
  return upLeft;
}

function decodeOneBitPng(png) {
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const bitDepth = png[24];
  const colorType = png[25];
  assert.equal(bitDepth, 1, "app icon must use 1-bit pixels");
  assert.equal(colorType, 3, "app icon must use indexed color");

  const compressed = [];
  let offset = 8;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString("ascii");
    if (type === "IDAT") compressed.push(png.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }

  const rowBytes = Math.ceil(width * bitDepth / 8);
  const encoded = inflateSync(Buffer.concat(compressed));
  assert.equal(encoded.length, height * (rowBytes + 1));
  const rows = Buffer.alloc(height * rowBytes);

  for (let y = 0; y < height; y += 1) {
    const sourceOffset = y * (rowBytes + 1);
    const rowOffset = y * rowBytes;
    const filter = encoded[sourceOffset];
    for (let x = 0; x < rowBytes; x += 1) {
      const value = encoded[sourceOffset + 1 + x];
      const left = x > 0 ? rows[rowOffset + x - 1] : 0;
      const up = y > 0 ? rows[rowOffset - rowBytes + x] : 0;
      const upLeft = y > 0 && x > 0 ? rows[rowOffset - rowBytes + x - 1] : 0;
      const predictor = [
        0,
        left,
        up,
        Math.floor((left + up) / 2),
        paeth(left, up, upLeft),
      ][filter];
      assert.notEqual(predictor, undefined, "unsupported PNG filter");
      rows[rowOffset + x] = (value + predictor) & 0xff;
    }
  }

  const pixels = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const byte = rows[y * rowBytes + (x >> 3)];
      pixels[y * width + x] = (byte >> (7 - (x & 7))) & 1;
    }
  }
  return { width, height, pixels };
}

function foregroundComponentCount({ width, height, pixels }) {
  const background = pixels[0];
  const visited = new Uint8Array(pixels.length);
  const queue = new Int32Array(pixels.length);
  let components = 0;

  for (let origin = 0; origin < pixels.length; origin += 1) {
    if (pixels[origin] === background || visited[origin]) continue;
    components += 1;
    let head = 0;
    let tail = 0;
    queue[tail] = origin;
    tail += 1;
    visited[origin] = 1;
    while (head < tail) {
      const index = queue[head];
      head += 1;
      const x = index % width;
      const y = Math.floor(index / width);
      for (let yOffset = -1; yOffset <= 1; yOffset += 1) {
        for (let xOffset = -1; xOffset <= 1; xOffset += 1) {
          if (xOffset === 0 && yOffset === 0) continue;
          const nextX = x + xOffset;
          const nextY = y + yOffset;
          if (nextX < 0 || nextX >= width || nextY < 0 || nextY >= height) continue;
          const neighbor = nextY * width + nextX;
          if (visited[neighbor] || pixels[neighbor] === background) continue;
          visited[neighbor] = 1;
          queue[tail] = neighbor;
          tail += 1;
        }
      }
    }
  }
  return components;
}

const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
assert.ok(appIcon.subarray(0, 8).equals(pngSignature), "app icon must be a PNG");
assert.equal(appIcon.readUInt32BE(16), 1024, "app icon width must be 1024 px");
assert.equal(appIcon.readUInt32BE(20), 1024, "app icon height must be 1024 px");
assert.equal(appIcon.indexOf(Buffer.from("tRNS")), -1, "app icon must not contain transparency");
const paletteOffset = appIcon.indexOf(Buffer.from("PLTE"));
assert.notEqual(paletteOffset, -1, "app icon must use a fixed monochrome palette");
assert.equal(
  appIcon.readUInt32BE(paletteOffset - 4) / 3,
  2,
  "app icon must contain exactly two flat colors",
);
assert.equal(
  foregroundComponentCount(decodeOneBitPng(appIcon)),
  3,
  "app icon mark must contain two slashes and one connected A",
);
assert.match(appIconContents, /"filename"\s*:\s*"AppIcon-1024\.png"/);
assert.match(brandMarkContents, /"filename"\s*:\s*"BrandMark@3x\.png"/);
assert.match(login, /Image\("BrandMark"\)/);

console.log("iOS source contract: PASS");
