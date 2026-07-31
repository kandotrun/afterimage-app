import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFileSync(path.join(root, relative), "utf8");
const readSwiftTree = (directory) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return readSwiftTree(absolute);
    if (entry.isFile() && entry.name.endsWith(".swift")) return [readFileSync(absolute, "utf8")];
    return [];
  });

const hapticEngine = read("ios/Sources/Haptics/HapticEngine.swift");
const appModel = read("ios/Sources/App/AppModel.swift");
const auth = read("ios/Sources/Features/Auth/ChallengeBoundAppleSignInButton.swift");
const cameraModel = read("ios/Sources/Features/Camera/CameraCaptureModel.swift");
const cameraPreview = read("ios/Sources/Features/Camera/CameraPreview.swift");
const cameraView = read("ios/Sources/Features/Camera/CameraCaptureView.swift");
const cameraLiveView = read("ios/Sources/Features/Camera/CameraLiveCaptureView.swift");
const timeline = read("ios/Sources/Features/Timeline/TimelineView.swift");
const dayStory = read("ios/Sources/Features/Timeline/DayStorySection.swift");
const memoryDetail = read("ios/Sources/Features/Memory/MemoryDetailView.swift");
const photoMemory = read("ios/Sources/Features/Memory/PhotoMemoryView.swift");
const videoMemory = read("ios/Sources/Features/Memory/VideoMemoryView.swift");
const dailyPlayback = read("ios/Sources/Features/Memory/DailyPlaybackView.swift");
const videoAnalysis = read("ios/Sources/Features/Memory/VideoAnalysisSheet.swift");
const transcript = read("ios/Sources/Features/Memory/TranscriptSheet.swift");
const memorySearch = read("ios/Sources/Features/Search/MemorySearchView.swift");
const settings = read("ios/Sources/Features/Settings/SettingsView.swift");
const aiConnection = read("ios/Sources/Features/Settings/AIConnectionView.swift");
const allSwiftSources = readSwiftTree(path.join(root, "ios/Sources")).join("\n");

for (const cue of ["focus", "recordStart", "recordStop", "copy", "warning"]) {
  assert.match(hapticEngine, new RegExp(`case ${cue}\\b`), `missing HapticCue.${cue}`);
}
assert.match(hapticEngine, /protocol HapticPlaying[\s\S]*?func play\(_ cue: HapticCue\)/);
assert.match(appModel, /private let haptics:\s*any HapticPlaying/);
assert.match(
  appModel,
  /func playHaptic\(_ cue: HapticCue\)[\s\S]{0,120}?haptics\.play\(cue\)/,
  "AppModel must expose its injected haptic player to feature views",
);
for (const cue of ["selection", "lift", "success", "failure", "delete"]) {
  assert.match(appModel, new RegExp(`haptics\\.play\\(\\.${cue}\\)`), `missing AppModel outcome cue ${cue}`);
}

assert.match(
  cameraModel,
  /enum CameraHapticPolicy[\s\S]*recordingStarted[\s\S]*recordStart[\s\S]*recordingStopped[\s\S]*recordStop[\s\S]*captureFailed[\s\S]*failure[\s\S]*reviewReady[\s\S]*success/,
  "camera lifecycle announcements must map to distinct tactile outcomes",
);
assert.match(cameraModel, /guard !isDiscarding else \{ return nil \}/);
assert.match(cameraView, /guard !dismissAfterFinalization else \{ return \}/);
assert.match(cameraView, /CameraHapticPolicy\.cue\(for:\s*announcement\.kind\)/);
assert.match(cameraPreview, /if model\.focus\(at:\s*devicePoint\)\s*\{\s*onFocus\(layerPoint\)/);
assert.match(memoryDetail, /TabView\(selection:\s*pagerSelection\)/);
assert.match(
  memoryDetail,
  /private var pagerSelection:[\s\S]{0,500}?set:[\s\S]{0,300}?playHaptic\(\.selection\)/,
  "memory paging feedback must run through the user-driven binding setter",
);

const mappings = [
  [auth, "lift", "Apple sign-in retry"],
  [cameraLiveView, "focus", "accepted camera focus"],
  [cameraLiveView, "selection", "camera switch"],
  [cameraView, "warning", "camera discard confirmation"],
  [cameraView, "delete", "camera discard completion"],
  [cameraView, "lift", "camera retake and retry"],
  [timeline, "selection", "timeline navigation"],
  [timeline, "warning", "timeline destructive confirmations"],
  [timeline, "lift", "timeline retries and upload actions"],
  [dayStory, "selection", "day story navigation"],
  [memoryDetail, "warning", "memory delete confirmation"],
  [memoryDetail, "selection", "memory paging and chrome"],
  [photoMemory, "lift", "photo zoom and retry"],
  [photoMemory, "failure", "photo load failure"],
  [videoMemory, "selection", "single-memory playback controls"],
  [videoMemory, "progress", "single-memory scrubbing"],
  [videoMemory, "failure", "single-memory playback failure"],
  [dailyPlayback, "warning", "daily playback delete confirmation"],
  [dailyPlayback, "selection", "daily playback controls and chapters"],
  [dailyPlayback, "progress", "daily playback scrubbing"],
  [dailyPlayback, "failure", "daily playback failure"],
  [videoAnalysis, "selection", "analysis segment seek"],
  [videoAnalysis, "lift", "analysis retry"],
  [videoAnalysis, "failure", "analysis load failure"],
  [transcript, "copy", "transcript copy"],
  [transcript, "lift", "transcript retry"],
  [transcript, "failure", "transcript load failure"],
  [memorySearch, "selection", "search result navigation"],
  [memorySearch, "lift", "search retry"],
  [settings, "warning", "settings destructive confirmations"],
  [settings, "lift", "settings reload"],
  [settings, "selection", "settings navigation"],
  [aiConnection, "warning", "MCP revoke confirmation"],
  [aiConnection, "copy", "MCP copy actions"],
  [aiConnection, "success", "MCP token creation"],
  [aiConnection, "failure", "MCP operation failure"],
];
for (const [source, cue, label] of mappings) {
  assert.match(source, new RegExp(`playHaptic\\(\\.${cue}\\)`), `missing haptic for ${label}`);
}

assert.doesNotMatch(
  allSwiftSources,
  /\.sensoryFeedback\(/,
  "feature haptics must use the injected HapticEngine consistently",
);

console.log(`iOS haptic contracts passed (${mappings.length} semantic mappings)`);
