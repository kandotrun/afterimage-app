# In-App Camera Capture

Date: 2026-07-28
Status: proposed

## Problem

Afterimage can import videos from the system photo picker, but it cannot record
a new memory without leaving the app. Capture should feel like the first step
of the existing private ingest flow, not a second media system with different
storage, compression, or upload behavior.

The current path is:

1. `TimelineView` receives `PhotosPickerItem` values.
2. `AppModel` checks library identities for duplicates.
3. `MediaImporter` copies each selected item to a temporary file.
4. `MediaCompressor` writes the only uploadable video.
5. `BackgroundUploadManager` stages and uploads the optimized media.

In-app capture must join this path at `ImportedMedia`. Captured originals must
remain temporary and must never be sent to R2 or saved to the photo library
unless a separate feature explicitly adds that behavior later.

## Goals

1. Record one video from the timeline without leaving Afterimage.
2. Provide a focused camera experience with camera switching, tap-to-focus,
   pinch-to-zoom, recording duration, and a review/retake step.
3. Preserve the existing privacy boundary: no upload before confirmation, no
   automatic photo-library write, and only optimized media reaches R2.
4. Reuse the current HEVC video, passthrough-audio, thumbnail,
   background-upload, progress, cancellation, and timeline-refresh behavior.
5. Handle permissions, capture-session interruption, app backgrounding,
   unavailable hardware, disk exhaustion, and capture finalization explicitly.
6. Keep camera state feature-local and model mutually exclusive states with one
   enum instead of parallel booleans.

## Non-goals

- Still-photo capture, Live Photos, burst mode, RAW, ProRAW, depth, portrait
  effects, filters, crop, trim, or other editing.
- Saving captured originals to Photos or requesting photo-library add access.
- Location collection or location metadata changes.
- Simultaneous front/back capture, external camera selection, Camera Control,
  or a manual lens picker.
- Capturing another item while an existing compression/upload job is active.
- Multiple accepted captures in one camera presentation.
- Replacing the existing photo-library picker.

## Product decisions

### One `追加` entry point

Keep the existing prominent `追加` control in `UploadDock`, but make it a menu:

- `アプリで撮影` opens a local item-driven `fullScreenCover`.
- `ライブラリから動画を選ぶ` keeps the existing video-only `PhotosPicker`
  configuration, including its 12-item limit and duplicate check.

The entry point remains unavailable while `AppModel.upload` or a persisted
background upload is active, matching current behavior. No global router is
needed because the camera is owned and presented only by `TimelineView`.

### Custom AVFoundation camera

Use a custom AVFoundation capture surface rather than
`UIImagePickerController`. The custom surface can preserve Afterimage's
full-screen visual language, show recording and permission state precisely, and
hand a temporary file directly to the existing ingest boundary.

The capture graph contains:

- one selected `AVCaptureDeviceInput` for video;
- an audio input when microphone access is authorized;
- `AVCaptureMovieFileOutput` for file-backed video recording; and
- `AVCaptureVideoPreviewLayer` hosted by a small `UIViewRepresentable`.

All capture-session configuration and `startRunning` / `stopRunning` calls run
on a dedicated serial queue. Observable UI state is published on the main
actor. Video records directly to a temporary `.mov` file and is never assembled
in memory.

### Confirmation before ingest

Every capture has a review step:

- local playback with audio when audio was recorded;
- `撮り直す`: deletes the temporary result and resumes the camera;
- `この動画を使う`: transfers ownership to `AppModel`.

The cover dismisses only after `AppModel` accepts ownership. If upload state
changed while the camera was open, the review stays visible and explains that
the current upload must finish first.

### Microphone denial does not block video

Camera permission is required for the feature. Microphone permission is
requested only when the user first chooses video.

If microphone access is denied or restricted:

- the user may explicitly continue with silent video;
- the camera shows a persistent `音声なし` badge in video mode; and
- the review repeats the same status.

This avoids both blocking a useful capture and silently producing a result
different from the user's expectation. A silent movie has no audio track, which
the current video optimizer already supports. When an audio track exists, the
current nil-settings audio passthrough remains mandatory.

## Experience

### Launch and permission

1. The user taps `追加` then `アプリで撮影`.
2. The full-screen cover opens against black immediately.
3. If camera access is undetermined, the app requests it before configuring the
   session.
4. While authorization or configuration is pending, show a centered progress
   state and a working close button.
5. If access is denied or restricted, replace the preview with an explanation,
   `設定を開く`, and `閉じる`. Never repeatedly request access.
6. If no camera is available, show an unavailable state rather than a blank
   preview. This is also the expected simulator behavior.

No photo-library permission is needed because captured media is not written to
Photos.

### Ready state

The preview fills the screen. Controls use native iOS 26 Liquid Glass over the
preview while the record control remains visually solid and high contrast.

Top controls:

- close;
- silent-video status when applicable; and
- front/back camera switch.

Preview interactions:

- tap to set focus and exposure, with a short-lived focus indicator;
- pinch to zoom, clamped to the active device's supported range; and
- correct preview rotation from `AVCaptureDevice.RotationCoordinator`.

Bottom controls:

- record/stop button; and
- elapsed recording time in video mode.

The rear camera is the default for each presentation. Camera switching is
disabled during recording and video finalization.

### Video capture

`AVCaptureMovieFileOutput` writes a QuickTime movie directly to a unique
temporary URL. `capturedAt` is the successful recording start time. The UI
enters review only after the recording delegate reports successful
finalization.

There is no arbitrary product duration limit in the first slice. Recording
remains file-backed, reports elapsed time, and stops with an actionable error
if the system reports insufficient space or another file-output failure.

Apply the rotation coordinator's capture angle to the movie output connection.
The existing optimizer continues to respect the recorded preferred transform
when producing the final HEVC video.

### Review and acceptance

The live session stops before review to release camera and thermal resources.
Retake deletes the result, restarts the session, and returns to the prior mode.
Close from review asks for confirmation because it discards a completed but
unaccepted capture.

On acceptance:

1. Build a video `ImportedMedia` from the temporary URL, unique filename, and
   explicit capture timestamp.
2. Call `AppModel.importCapturedMedia`.
3. If accepted, dismiss the camera and show the existing upload dock at the
   compression stage.
4. Optimize to HEVC plus a JPEG thumbnail.
5. Create the owner-scoped asset and hand optimized files to
   `BackgroundUploadManager`.
6. Refresh the timeline on completion.

Camera recordings do not use the photo-library duplicate lookup and pass no
`sourceFingerprint`. Each accepted recording is an intentional new memory. The
filename includes a timestamp and UUID so separate captures cannot collide.

## State model

`CameraCaptureModel` owns one state:

| State | Allowed user actions | Exit |
| --- | --- | --- |
| `authorizing` | close | authorized, denied |
| `configuring` | close | ready, failed |
| `ready` | close, switch camera, focus, zoom, record | recording |
| `recording(startedAt)` | stop | finalizing, interrupted |
| `finalizingVideo` | none | review, failed |
| `review(result)` | retake, accept, close with confirmation | ready, ingest, dismissed |
| `interrupted(reason)` | retry when possible, close | configuring, review, failed |
| `failed(failure)` | retry when recoverable, settings when relevant, close | configuring, dismissed |

Derived presentation values such as record availability, camera-switch
availability, close behavior, and status labels come from a pure
`CameraCapturePolicy`. Capture delegates send events to the model; views never
mutate AVFoundation objects directly.

## Ownership and cleanup

Temporary-file ownership must be explicit:

1. `CameraCaptureModel` owns the current result until acceptance.
2. Retake, discard, failed finalization, and normal dismissal delete every
   camera-owned file.
3. `AppModel.importCapturedMedia` returns whether it accepted ownership.
4. After acceptance, `AppModel` owns and removes the captured source using the
   same `defer` path as picker imports.
5. `MediaCompressor` creates separate optimized media and thumbnail files.
6. `BackgroundUploadManager` moves only optimized files into its durable staging
   directory and removes them according to its existing completion,
   cancellation, and recovery rules.

The camera does not save a second copy, write to Photos, create a backend asset,
or begin compression before the user taps the accept action.

## App lifecycle and failures

### Backgrounding

The app never continues capturing in the background.

- Ready state: stop the session; restart when active.
- Recording: request stop immediately. If finalization succeeds, keep the
  result in review when the app becomes active. Do not upload automatically.
- Finalization that cannot complete: delete partial output and show a retryable
  failure on return.

### Capture interruptions

Observe capture-session interruption and runtime-error notifications.

- Camera or microphone in use by another client: pause controls and explain the
  interruption; resume after the interruption ends.
- System pressure: stop recording safely, retain a successfully finalized
  result for review, and avoid automatic restart until pressure clears.
- Media services reset: rebuild the session graph on its serial queue.
- Phone call or audio-device interruption while recording: stop and finalize;
  keep the valid recording, including its actual audio-track state.

### Ingest failures

Failures after acceptance use the existing upload progress, haptics, notice, and
cleanup behavior. Compression failure never uploads the camera source. An R2
upload still receives only the optimized media and generated thumbnail.

## Privacy and security

- The camera is reachable only from the authenticated timeline.
- Add `NSCameraUsageDescription` and `NSMicrophoneUsageDescription` with
  localized, purpose-specific text.
- Do not add `NSPhotoLibraryAddUsageDescription`; the feature does not write to
  Photos.
- Do not log temporary paths, capture metadata, thumbnails, file bytes,
  playback content, or permission history.
- Store unaccepted results in a dedicated temporary capture directory, purge
  orphaned files on the next launch, and never offer to recover an unaccepted
  capture after termination.
- Do not create a remote asset until optimization has succeeded.
- Preserve owner-scoped authentication on all existing create, upload,
  thumbnail, content, and delete requests.

## Accessibility and localization

- Localize every new label and permission explanation in Japanese, English,
  Simplified Chinese, and Korean.
- Give close, camera switch, record, stop, retake, accept, and settings
  controls explicit accessibility labels and state values.
- Announce recording start/stop, silent recording, capture failure, and review
  readiness through accessibility announcements.
- Keep the record control at least 44 points and separate destructive discard
  from the primary accept action.
- Do not rely on red alone to indicate recording; pair color with shape, timer,
  and an accessibility value.
- Disable decorative preview elements from the accessibility tree.

## Code boundaries

```
ios/Sources/Features/Camera/
  CameraCaptureView.swift
  CameraCaptureModel.swift
  CameraCapturePolicy.swift
  CameraCaptureSession.swift
  CameraPreview.swift

ios/Sources/App/AppModel.swift
ios/Sources/Features/Timeline/TimelineView.swift
ios/Sources/Import/MediaImporter.swift
ios/Resources/Info.plist
ios/Resources/Localizable.xcstrings
ios/Resources/Localization/{ja,en,zh-Hans,ko}.lproj/InfoPlist.strings
ios/Tests/CameraCapturePolicyTests.swift
ios/Tests/CameraIngestPolicyTests.swift
scripts/verify-ios-contract.mjs
```

`CameraCaptureSession` owns AVFoundation objects and its serial queue.
`CameraCaptureModel` is a main-actor, feature-local observable type.
`CameraCaptureView` owns the model with SwiftUI state and dismisses itself.
`TimelineView` owns only the optional presentation destination.

Refactor `AppModel` so picker loading is separate from common media processing:

- `importItems` retains identity lookup and calls `MediaImporter.load`.
- `importCapturedMedia` accepts one already-file-backed `ImportedMedia`.
- both call `process(media:identity:current:total:)`.

This is the only production-flow refactor required. Do not introduce a second
compressor, uploader, backend endpoint, or captured-media database.

## Testing

Follow RED -> GREEN -> REFACTOR.

### Automated

1. `CameraCapturePolicyTests`
   - permissions map to authorizing, ready, denied, or silent-video choices;
   - camera switching is blocked while recording or finalizing;
   - backgrounding during recording requests stop instead of acceptance;
   - review discard and accepted ownership are mutually exclusive;
   - record availability follows capture-session and microphone decisions.
2. Ingest tests
   - captured media bypasses library duplicate planning;
   - a pure ingest policy rejects a capture while an upload task or persisted
     background upload owns the pipeline;
   - rejection leaves the camera-owned file in place;
   - acceptance transfers ownership exactly once;
   - camera-owned temporary files are removed on retake, discard, and failed
     finalization.
3. Compression coverage
   - captured video produces HEVC;
   - AAC audio is passed through;
   - a video with no audio track remains valid.
4. Contract and localization checks
   - require camera and microphone usage descriptions;
   - require `AVCaptureMovieFileOutput` and `AVCaptureVideoPreviewLayer`;
   - require every new key in all four locales.
5. Run the full iOS XCTest suite and `npm run check`.

### Physical-device manual QA

The simulator can validate unavailable-camera UI and policy tests, but it does
not satisfy the camera gate. On an iOS 26 iPhone, verify:

1. first-run camera allow and deny paths;
2. video capture on rear and front cameras, rotation, focus, zoom, retake,
   discard, and acceptance;
3. microphone allowed, denied, and later re-enabled in Settings;
4. silent-video labeling and successful compression;
5. rotation during preview and before recording;
6. home gesture or app background transition while ready and while recording;
7. phone-call or competing-camera interruption when practical;
8. low-storage or forced file-output failure;
9. upload cancellation, app relaunch after background handoff, and timeline
   refresh;
10. confirmation that Photos contains no new item and R2 receives only the
    optimized HEVC object plus thumbnail.

Record the device model, iOS build, media dimensions, codecs, audio-track
presence, source/optimized byte sizes, and exact pass/fail result.

## Implementation order

1. Add failing pure policy, ownership, contract, and localization tests.
2. Add permission strings, local presentation routing, and unavailable/denied
   states.
3. Implement the file-backed capture session, preview, video flow, rotation,
   focus, zoom, and interruption handling.
4. Refactor picker loading away from common `ImportedMedia` processing and add
   captured-media ownership transfer.
5. Add review/retake/accept UI and connect the existing upload presentation.
6. Run automated gates, then complete the physical-device matrix before
   calling the feature done.

## Apple platform references

- [Setting up a capture session](https://developer.apple.com/documentation/avfoundation/setting-up-a-capture-session)
- [Requesting authorization to capture and save media](https://developer.apple.com/documentation/avfoundation/requesting-authorization-to-capture-and-save-media)
- [AVCaptureMovieFileOutput](https://developer.apple.com/documentation/avfoundation/avcapturemoviefileoutput)
- [AVCaptureDevice.RotationCoordinator](https://developer.apple.com/documentation/avfoundation/avcapturedevice/rotationcoordinator)
- [AVCaptureSession](https://developer.apple.com/documentation/avfoundation/avcapturesession)
- [AVCaptureSession.InterruptionReason](https://developer.apple.com/documentation/avfoundation/avcapturesession/interruptionreason)
