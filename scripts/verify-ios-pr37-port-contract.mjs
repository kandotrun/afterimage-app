import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFileSync(path.join(root, relative), "utf8");

function scope(source, startPattern, label) {
  const match = startPattern.exec(source);
  assert.ok(match, `missing declaration: ${label}`);
  const opening = source.indexOf("{", match.index + match[0].length);
  assert.notEqual(opening, -1, `missing body: ${label}`);
  let depth = 0;
  let state = "code";
  for (let index = opening; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1];
    if (state === "line") {
      if (current === "\n") state = "code";
      continue;
    }
    if (state === "block") {
      if (current === "*" && next === "/") {
        state = "code";
        index += 1;
      }
      continue;
    }
    if (state === "string") {
      if (current === "\\") {
        index += 1;
      } else if (current === "\"") {
        state = "code";
      }
      continue;
    }
    if (current === "/" && next === "/") {
      state = "line";
      index += 1;
      continue;
    }
    if (current === "/" && next === "*") {
      state = "block";
      index += 1;
      continue;
    }
    if (current === "\"") {
      state = "string";
      continue;
    }
    if (current === "{") depth += 1;
    if (current === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(match.index, index + 1);
    }
  }
  assert.fail(`unterminated body: ${label}`);
}

function includesAll(body, fragments, label) {
  for (const fragment of fragments) {
    assert.ok(body.includes(fragment), `${label} missing: ${fragment}`);
  }
}

const appDelegate = read("ios/Sources/App/AppDelegate.swift");
const appModel = read("ios/Sources/App/AppModel.swift");
const appRoot = read("ios/Sources/App/afterimageApp.swift");
const apiClient = read("ios/Sources/Networking/APIClient.swift");
const apiModels = read("ios/Sources/Models/APIModels.swift");
const background = read("ios/Sources/Upload/BackgroundUploadManager.swift");
const cameraPlayback = read("ios/Sources/Features/Camera/CameraCapturePlayback.swift");
const cameraPolicy = read("ios/Sources/Features/Camera/CameraCapturePolicy.swift");
const cameraView = read("ios/Sources/Features/Camera/CameraCaptureView.swift");
const dailyPlayback = read("ios/Sources/Features/Memory/DailyPlaybackView.swift");
const transcript = read("ios/Sources/Features/Memory/TranscriptSheet.swift");
const videoMemory = read("ios/Sources/Features/Memory/VideoMemoryView.swift");
const preview = read("ios/Sources/Features/Timeline/DayPreviewPlaybackController.swift");
const dayStory = read("ios/Sources/Features/Timeline/DayStorySection.swift");
const timeline = read("ios/Sources/Features/Timeline/TimelineView.swift");
const reminder = read("ios/Sources/Notifications/DailyPostReminderScheduler.swift");
const router = read("ios/Sources/Notifications/NotificationIntentRouter.swift");
const catalog = JSON.parse(read("ios/Resources/Localizable.xcstrings"));

const sceneAction = scope(
  cameraPolicy,
  /static func sceneChangeAction\(for change: CameraScenePhaseChange\)/,
  "CameraCapturePolicy.sceneChangeAction",
);
includesAll(sceneAction, ["case .active: .resume", "case .inactive: .ignore", "case .background: .suspend"], "scene policy");

const cameraBody = scope(cameraView, /struct CameraCaptureView: View/, "CameraCaptureView");
includesAll(cameraBody, ["CameraCapturePolicy.sceneChangeAction", "case .ignore:", "case .suspend:"], "camera scene handling");
const reviewBody = scope(cameraPlayback, /struct ReviewVideoView: View/, "ReviewVideoView");
includesAll(reviewBody, ["PlaybackAudioSession().activate()", "PlaybackAudioSession().deactivate()"], "capture review audio");

const nextIndex = scope(
  preview,
  /nonisolated static func nextIndex\(after index: Int, count: Int\)/,
  "DayPreviewPlaybackController.nextIndex",
);
assert.ok(nextIndex.includes("index + 1 < count"), "day preview must stop after one pass");
assert.ok(!nextIndex.includes("% count"), "day preview must not wrap");
const grantCache = scope(preview, /struct DayPreviewGrantCache/, "DayPreviewGrantCache");
includesAll(grantCache, ["capacity", "count", "PlaybackRecoveryPolicy", "removeFirst"], "bounded preview grant cache");
const preparePreview = scope(
  preview,
  /private func prepare\(index: Int, generation expected: Int\) async/,
  "DayPreviewPlaybackController.prepare",
);
includesAll(preparePreview, ["grantCache.grant", "expected == generation", "grantCache.insert"], "preview cache race guard");
assert.ok(
  preparePreview.indexOf("expected == generation") < preparePreview.lastIndexOf("grantCache.insert"),
  "stale grant loads must be rejected before cache insertion",
);
const hero = scope(dayStory, /private struct DayStoryHero: View/, "DayStoryHero");
includesAll(hero, ["isLowPowerModeEnabled", "NSProcessInfoPowerStateDidChange"], "Low Power preview behavior");

const reminderPolicy = scope(reminder, /enum DailyPostReminderPolicy/, "DailyPostReminderPolicy");
includesAll(reminderPolicy, ["identifierPrefix", "isReminder(identifier:"], "reminder identifier policy");
const willPresent = scope(
  appDelegate,
  /willPresent notification: UNNotification\s*\)\s*async -> UNNotificationPresentationOptions/,
  "AppDelegate.willPresent",
);
includesAll(willPresent, ["DailyPostReminderPolicy.isReminder", "return []"], "foreground reminder suppression");
const didReceive = scope(
  appDelegate,
  /didReceive response: UNNotificationResponse\s*\)\s*async/,
  "AppDelegate.didReceive",
);
includesAll(didReceive, ["UNNotificationDefaultActionIdentifier", "requestCameraCapture()"], "reminder tap routing");
const intentRouter = scope(router, /final class NotificationIntentRouter/, "NotificationIntentRouter");
includesAll(intentRouter, ["wantsCameraCapture", "consumeCameraCaptureRequest"], "notification intent router");
const timelineView = scope(timeline, /struct TimelineView: View/, "TimelineView");
includesAll(timelineView, ["notificationIntents", "consumeCameraCaptureRequest()", "cameraRoute = .capture"], "timeline camera route");

const manager = scope(background, /final class BackgroundUploadManager/, "BackgroundUploadManager");
includesAll(manager, ["var requiresCancellationCleanup", "var pendingOwnerID"], "persisted upload recovery state");
const uploadContext = scope(background, /struct BackgroundUploadContext/, "BackgroundUploadContext");
assert.ok(uploadContext.includes("let ownerID: String"), "background upload context must carry its owner");
const uploadState = scope(background, /struct BackgroundUploadState/, "BackgroundUploadState");
assert.ok(uploadState.includes("var ownerID: String?"), "persisted upload state must retain owner scope");
const startUpload = scope(background, /func startUpload\(/, "BackgroundUploadManager.startUpload");
assert.ok(startUpload.includes("ownerID: context.ownerID"), "new persisted uploads must capture their owner");
const resumePending = scope(
  background,
  /func resumePendingUpload\(/,
  "BackgroundUploadManager.resumePendingUpload",
);
includesAll(
  resumePending,
  ["guard ownerID == context.ownerID", "guard adoptLegacyOwner", "currentState.ownerID = context.ownerID"],
  "persisted upload owner validation",
);
const cancelAndWait = scope(
  background,
  /func cancelAllAndWaitForCleanup\(/,
  "BackgroundUploadManager.cancelAllAndWaitForCleanup",
);
includesAll(cancelAndWait, ["await withCheckedContinuation", "cancelAll("], "awaitable discard");
const finishCleanup = scope(
  background,
  /private func finishCancellationCleanup\(/,
  "BackgroundUploadManager.finishCancellationCleanup",
);
assert.ok(
  finishCleanup.indexOf("removeStagedFiles") < finishCleanup.indexOf("clearStateLocked"),
  "staged files must be removed only after remote cleanup succeeds",
);
const failedCleanup = scope(
  background,
  /private func cancellationCleanupFailed\(/,
  "BackgroundUploadManager.cancellationCleanupFailed",
);
assert.ok(failedCleanup.includes("saveStateLocked()"), "failed discard must retain durable retry state");

const beginAuth = scope(
  appModel,
  /private func beginAuthGeneration\(/,
  "AppModel.beginAuthGeneration",
);
includesAll(
  beginAuth,
  ["authScopeGeneration", "cancelAllAndWaitForCleanup", "backgroundUploadNeedsRetry"],
  "auth generation cleanup",
);
const signOut = scope(appModel, /func signOut\(\) async/, "AppModel.signOut");
includesAll(signOut, ["beginAuthGeneration", "restoreAuthGeneration", "revokeSession"], "sign-out rollback");
const cancelUpload = scope(appModel, /func cancelUpload\(\) async/, "AppModel.cancelUpload");
assert.ok(cancelUpload.includes("await discardBackgroundUpload()"), "cancel must delegate to durable discard");
assert.ok(!cancelUpload.includes("cancelAll()"), "AppModel cancel must not treat cancelAll as immediate cleanup");
const timelineCancelCalls = timeline.match(/model\.cancelUpload\(\)/g) ?? [];
const awaitedTimelineCancelCalls = timeline.match(
  /Task\s*\{\s*await\s+model\.cancelUpload\(\)\s*\}/g,
) ?? [];
assert.equal(timelineCancelCalls.length, 2, "timeline must expose both cancel actions");
assert.equal(
  awaitedTimelineCancelCalls.length,
  timelineCancelCalls.length,
  "every async cancelUpload call in TimelineView must be awaited inside a Task",
);
const discardUpload = scope(
  appModel,
  /func discardBackgroundUpload\(\) async/,
  "AppModel.discardBackgroundUpload",
);
includesAll(
  discardUpload,
  ["cancelAllAndWaitForCleanup", "backgroundUploadNeedsRetry", "publishBackgroundUploadRecoveryFailure"],
  "durable upload discard",
);
const retryUpload = scope(appModel, /func retryBackgroundUpload\(\) async/, "AppModel.retryBackgroundUpload");
includesAll(retryUpload, ["requiresCancellationCleanup", "cancelAllAndWaitForCleanup"], "discard cleanup retry");
const importItems = scope(appModel, /func importItems\(_ items: \[PhotosPickerItem\]\)/, "AppModel.importItems");
includesAll(importItems, ["hasActiveBackgroundUpload", "failedItemCount", "continue", "upload.batch_failures"], "batch import recovery");
const importCapture = scope(
  appModel,
  /func importCapturedMedia\(_ media: ImportedMedia\) -> Bool/,
  "AppModel.importCapturedMedia",
);
assert.ok(importCapture.includes("hasActiveBackgroundUpload"), "camera import path must guard persisted manager state");

const refreshTimeline = scope(appModel, /func refreshTimeline\(\) async throws/, "AppModel.refreshTimeline");
includesAll(refreshTimeline, ["timelineRefresh", "awaitTimelineRefresh"], "coalesced timeline refresh");
const awaitRefresh = scope(
  appModel,
  /private func awaitTimelineRefresh\(/,
  "AppModel.awaitTimelineRefresh",
);
includesAll(awaitRefresh, ["refresh.task.value", "timelineRefresh?.id == refresh.id"], "refresh task lifecycle");
const freshTimeline = scope(
  appModel,
  /func refreshTimelineEnsuringFresh\(\) async throws/,
  "AppModel.refreshTimelineEnsuringFresh",
);
includesAll(freshTimeline, ["awaitTimelineRefresh", "startTimelineRefresh"], "post-upload fresh timeline");
const resumedUpload = scope(
  appModel,
  /func resumeBackgroundUploadIfNeeded\(/,
  "AppModel.resumeBackgroundUploadIfNeeded",
);
includesAll(
  resumedUpload,
  [
    "authScope",
    "isCurrentAuthScope",
    "refreshTimelineEnsuringFresh",
    "invalidatesSession",
    "adoptLegacyOwner: adoptLegacyOwner",
  ],
  "scoped upload completion",
);
const processUpload = scope(appModel, /private func process\(/, "AppModel.process");
includesAll(
  processUpload,
  ["operationScope", "isCurrentAuthScope(operationScope)", "refreshTimelineEnsuringFresh"],
  "initial upload completion scope",
);
const bootstrap = scope(appModel, /func bootstrap\(\) async/, "AppModel.bootstrap");
includesAll(
  bootstrap,
  ["api.currentUser()", "adoptLegacyOwner: true"],
  "restored session owner resolution",
);
const currentUser = scope(apiClient, /func currentUser\(\) async throws/, "APIClient.currentUser");
assert.ok(currentUser.includes('path: "/v1/me"'), "session bootstrap must resolve its authenticated owner");
const signIn = scope(
  appModel,
  /func signIn\(\s*credential: ASAuthorizationAppleIDCredential,\s*challengeID: String\s*\) async/,
  "AppModel.signIn",
);
includesAll(
  signIn,
  [
    "challengeID: challengeID",
    "establishSession(response)",
    "manager.hasPendingUpload",
    "manager.pendingOwnerID != response.user.id",
    "cleanupPendingUpload",
  ],
  "new sign-in owner isolation",
);
assert.ok(
  signIn.indexOf("establishSession(response)") < signIn.indexOf("guard await beginAuthGeneration"),
  "cleanup failure after sign-in must retain the generation-bound authenticated session",
);
assert.match(
  beginAuth,
  /guard cleanupSucceeded else \{[\s\S]{0,240}?backgroundUploadNeedsRetry[\s\S]{0,160}?publishBackgroundUploadRecoveryFailure\(\)[\s\S]{0,80}?return false/,
  "auth cleanup failure must retain retry state",
);
const invalidatesSession = scope(
  apiModels,
  /var invalidatesSession: Bool/,
  "AfterimageError.invalidatesSession",
);
assert.ok(invalidatesSession.includes("status == 401"), "HTTP 401 must invalidate the session");
const sessionExpired = scope(
  appModel,
  /private func expireSession\(ifCurrent context: AuthSessionContext\)/,
  "AppModel.expireSession",
);
includesAll(
  sessionExpired,
  ["currentSession?.context == context", "clearLocalSession(ifCurrent: context)", "auth.session_expired_title"],
  "401 session invalidation",
);
const terminationHandler = scope(
  appModel,
  /private func installSessionTerminationHandler\(\) async/,
  "AppModel.installSessionTerminationHandler",
);
includesAll(
  terminationHandler,
  ["authGeneration.setTerminationHandler", "expireSession(ifCurrent: context)"],
  "generation-bound 401 isolation",
);

const uploadDock = scope(timeline, /private struct UploadDock: View/, "UploadDock");
includesAll(uploadDock, ["model.hasActiveBackgroundUpload", "resumeBackgroundUpload", "discardBackgroundUpload"], "persisted upload dock");
assert.ok(
  uploadDock.indexOf("model.hasActiveBackgroundUpload") < uploadDock.indexOf("Menu {"),
  "the add menu must be unreachable while manager state or cleanup is pending",
);
includesAll(timelineView, ["TimelineLoadFailedView", "timelineFooter", "refreshTimelineReportingFailure"], "timeline load and retry states");
const thumbnail = scope(timeline, /struct AuthenticatedThumbnail: View/, "AuthenticatedThumbnail");
includesAll(thumbnail, ["timelineGeneration", "Task.sleep", "thumbnailData"], "thumbnail retries");
const dailyPlaybackView = scope(dailyPlayback, /struct DailyPlaybackView: View/, "DailyPlaybackView");
assert.ok(
  dailyPlaybackView.includes("Task { await loadDay() }"),
  "daily playback failure must expose retry",
);
const transcriptSheet = scope(transcript, /struct TranscriptSheet: View/, "TranscriptSheet");
includesAll(
  transcriptSheet,
  ["transcriptIsInProgress", "transcript.pending_title", "transcript.failed_title", "action.retry"],
  "transcript states",
);
const videoMemoryView = scope(videoMemory, /struct VideoMemoryView: View/, "VideoMemoryView");
assert.ok(
  videoMemoryView.includes("showsTranscriptButton"),
  "transcript state button must remain visible before completion",
);

for (const key of [
  "timeline.refresh_failed",
  "timeline.pagination_failed",
  "timeline.load_failed_title",
  "timeline.load_failed_detail",
  "auth.session_expired_title",
  "auth.session_expired_message",
  "auth.sign_out.confirm_title",
  "auth.sign_out.action",
  "auth.sign_out.detail",
  "auth.sign_out.upload_warning",
  "upload.resume",
  "upload.discard",
  "upload.discard_retry",
  "upload.discarding",
  "upload.batch_failures",
  "upload.cancel.confirm_title",
  "upload.cancel.action",
  "upload.cancel.detail",
  "upload.discard.confirm_title",
  "upload.discard.action",
  "upload.discard.detail",
  "transcript.pending_title",
  "transcript.pending_detail",
  "transcript.failed_title",
  "transcript.load_failed_title",
]) {
  const localizations = catalog.strings[key]?.localizations;
  assert.ok(localizations, `missing localization key: ${key}`);
  for (const locale of ["ja", "en", "zh-Hans", "ko"]) {
    assert.equal(localizations[locale]?.stringUnit?.state, "translated", `missing ${locale}: ${key}`);
  }
}

const rootView = scope(appRoot, /struct RootView: View/, "RootView");
assert.ok(rootView.includes("model.backgroundUploadNeedsRetry"), "root recovery alert must remain available");
console.log("iOS PR #37 selective port contract: PASS");
