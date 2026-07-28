# In-App Video Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add private, file-backed in-app video recording that joins Afterimage's existing HEVC optimization and background upload path.

**Architecture:** A feature-local `CameraCaptureModel` owns one enum state and drives a closure-based `CameraCaptureClient`. The live client adapts an AVFoundation `CameraCaptureSession`; tests replace only that hardware boundary. Accepted recordings become `ImportedMedia` and enter the same `AppModel.process(media:)` path as video-only `PhotosPicker` imports.

**Tech Stack:** Swift 6, SwiftUI on iOS 26, AVFoundation, AVKit, UIKit, XcodeGen, XCTest, Node contract/localization scripts.

## Global Constraints

- New imports and in-app captures are video-only.
- Use native iOS 26 Liquid Glass with no availability checks or Material fallback.
- Do not add source comments.
- Do not use `any`, `as any`, `@ts-ignore`, or `@ts-expect-error`.
- Record video directly to a temporary file; never buffer a complete video in memory.
- R2 receives only HEVC video and its generated thumbnail.
- Preserve nil-settings compressed-audio passthrough; silent video has no audio track.
- Do not save recordings to Photos or add photo-library write permission.
- Request microphone permission only when the first recording requires it.
- Follow RED -> GREEN -> REFACTOR for each behavior.

---

### Task 1: Camera policy and temporary-file ownership

**Files:**
- Create: `ios/Sources/Features/Camera/CameraCapturePolicy.swift`
- Create: `ios/Sources/Features/Camera/CameraTemporaryFileStore.swift`
- Create: `ios/Tests/CameraCapturePolicyTests.swift`
- Create: `ios/Tests/CameraTemporaryFileStoreTests.swift`

**Interfaces:**
- Produces: `CameraPermission`, `CameraCapturePhase`, `CameraStartAction`, `CameraMicrophoneAction`, `CameraBackgroundAction`.
- Produces: `CameraCapturePolicy.startAction`, `microphoneAction`, `backgroundAction`, `allowsCameraSwitch`.
- Produces: `CameraTemporaryFileStore.makeRecordingURL`, `remove`, and `purge`.

- [ ] **Step 1: Write the failing policy tests**

```swift
import XCTest
@testable import afterimage

final class CameraCapturePolicyTests: XCTestCase {
    func testDeniedCameraPermissionOpensSettingsState() {
        XCTAssertEqual(
            CameraCapturePolicy.startAction(cameraPermission: .denied),
            .showSettings
        )
    }

    func testDeniedMicrophoneRequiresExplicitSilentConfirmation() {
        XCTAssertEqual(
            CameraCapturePolicy.microphoneAction(
                permission: .denied,
                silentRecordingConfirmed: false
            ),
            .confirmSilentRecording
        )
    }

    func testConfirmedSilentRecordingDoesNotRequireMicrophone() {
        XCTAssertEqual(
            CameraCapturePolicy.microphoneAction(
                permission: .denied,
                silentRecordingConfirmed: true
            ),
            .recordWithoutAudio
        )
    }

    func testBackgroundingStopsAnActiveRecording() {
        XCTAssertEqual(
            CameraCapturePolicy.backgroundAction(phase: .recording),
            .stopRecording
        )
    }

    func testCameraSwitchIsLimitedToReadyState() {
        XCTAssertTrue(CameraCapturePolicy.allowsCameraSwitch(phase: .ready))
        XCTAssertFalse(CameraCapturePolicy.allowsCameraSwitch(phase: .recording))
        XCTAssertFalse(CameraCapturePolicy.allowsCameraSwitch(phase: .finalizing))
    }
}
```

- [ ] **Step 2: Run the policy tests and verify RED**

Run:

```bash
cd ios
xcodegen generate
xcodebuild test -project afterimage.xcodeproj -scheme afterimage -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -only-testing:afterimageTests/CameraCapturePolicyTests CODE_SIGNING_ALLOWED=NO
```

Expected: compilation fails because `CameraCapturePolicy` and its value types do not exist.

- [ ] **Step 3: Implement the minimal policy**

```swift
import Foundation

enum CameraPermission: Equatable, Sendable {
    case notDetermined
    case authorized
    case denied
}

enum CameraCapturePhase: Equatable, Sendable {
    case authorizing
    case configuring
    case ready
    case confirmingSilentRecording
    case recording
    case finalizing
    case reviewing
    case interrupted
    case failed
    case transferred
}

enum CameraStartAction: Equatable, Sendable {
    case requestPermission
    case configure
    case showSettings
}

enum CameraMicrophoneAction: Equatable, Sendable {
    case requestPermission
    case recordWithAudio
    case confirmSilentRecording
    case recordWithoutAudio
}

enum CameraBackgroundAction: Equatable, Sendable {
    case stopSession
    case stopRecording
    case waitForFinalization
}

enum CameraCapturePolicy {
    static func startAction(cameraPermission: CameraPermission) -> CameraStartAction {
        switch cameraPermission {
        case .notDetermined: .requestPermission
        case .authorized: .configure
        case .denied: .showSettings
        }
    }

    static func microphoneAction(
        permission: CameraPermission,
        silentRecordingConfirmed: Bool
    ) -> CameraMicrophoneAction {
        switch permission {
        case .notDetermined: .requestPermission
        case .authorized: .recordWithAudio
        case .denied:
            silentRecordingConfirmed ? .recordWithoutAudio : .confirmSilentRecording
        }
    }

    static func backgroundAction(phase: CameraCapturePhase) -> CameraBackgroundAction {
        switch phase {
        case .recording: .stopRecording
        case .finalizing: .waitForFinalization
        default: .stopSession
        }
    }

    static func allowsCameraSwitch(phase: CameraCapturePhase) -> Bool {
        phase == .ready
    }
}
```

- [ ] **Step 4: Run the policy tests and verify GREEN**

Run the command from Step 2.

Expected: `CameraCapturePolicyTests` passes.

- [ ] **Step 5: Write the failing temporary-store tests**

```swift
import XCTest
@testable import afterimage

final class CameraTemporaryFileStoreTests: XCTestCase {
    func testRecordingURLIsUniqueMovInsideOwnedDirectory() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let store = CameraTemporaryFileStore(directory: root)

        let first = try store.makeRecordingURL()
        let second = try store.makeRecordingURL()

        XCTAssertEqual(first.deletingLastPathComponent(), root)
        XCTAssertEqual(first.pathExtension, "mov")
        XCTAssertNotEqual(first, second)
    }

    func testPurgeRemovesOnlyFilesInsideOwnedDirectory() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let outside = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
        let store = CameraTemporaryFileStore(directory: root)
        let recording = try store.makeRecordingURL()
        FileManager.default.createFile(atPath: recording.path, contents: Data("video".utf8))
        FileManager.default.createFile(atPath: outside.path, contents: Data("keep".utf8))

        try store.purge()

        XCTAssertFalse(FileManager.default.fileExists(atPath: recording.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: outside.path))
        try FileManager.default.removeItem(at: outside)
    }
}
```

- [ ] **Step 6: Run the temporary-store tests and verify RED**

Run:

```bash
cd ios
xcodebuild test -project afterimage.xcodeproj -scheme afterimage -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -only-testing:afterimageTests/CameraTemporaryFileStoreTests CODE_SIGNING_ALLOWED=NO
```

Expected: compilation fails because `CameraTemporaryFileStore` does not exist.

- [ ] **Step 7: Implement the temporary store**

```swift
import Foundation

struct CameraTemporaryFileStore: Sendable {
    let directory: URL

    init(
        directory: URL = FileManager.default.temporaryDirectory
            .appendingPathComponent("afterimage-camera", isDirectory: true)
    ) {
        self.directory = directory
    }

    func makeRecordingURL() throws -> URL {
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true
        )
        return directory
            .appendingPathComponent(UUID().uuidString)
            .appendingPathExtension("mov")
    }

    func remove(_ url: URL) {
        guard url.deletingLastPathComponent() == directory else { return }
        try? FileManager.default.removeItem(at: url)
    }

    func purge() throws {
        guard FileManager.default.fileExists(atPath: directory.path) else { return }
        try FileManager.default.removeItem(at: directory)
    }
}
```

- [ ] **Step 8: Run both Task 1 tests and commit**

Run:

```bash
cd ios
xcodebuild test -project afterimage.xcodeproj -scheme afterimage -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -only-testing:afterimageTests/CameraCapturePolicyTests -only-testing:afterimageTests/CameraTemporaryFileStoreTests CODE_SIGNING_ALLOWED=NO
```

Expected: both test classes pass.

Commit:

```bash
git add ios/Sources/Features/Camera/CameraCapturePolicy.swift ios/Sources/Features/Camera/CameraTemporaryFileStore.swift ios/Tests/CameraCapturePolicyTests.swift ios/Tests/CameraTemporaryFileStoreTests.swift
git commit -m "test(ios): define camera capture policies"
```

### Task 2: Captured-video ingest boundary

**Files:**
- Create: `ios/Sources/Features/Camera/CameraIngestPolicy.swift`
- Create: `ios/Tests/CameraIngestPolicyTests.swift`
- Modify: `ios/Sources/App/AppModel.swift:252-491`

**Interfaces:**
- Consumes: `ImportedMedia`.
- Produces: `CameraIngestPolicy.canAccept(hasUploadTask:hasPendingBackgroundUpload:)`.
- Produces: `AppModel.importCapturedMedia(_:) -> Bool`.
- Changes: `AppModel.process(media:identity:current:total:)`.

- [ ] **Step 1: Write and run the failing ingest-policy test**

```swift
import XCTest
@testable import afterimage

final class CameraIngestPolicyTests: XCTestCase {
    func testAcceptsOnlyWhenNoUploadOwnsThePipeline() {
        XCTAssertTrue(
            CameraIngestPolicy.canAccept(
                hasUploadTask: false,
                hasPendingBackgroundUpload: false
            )
        )
        XCTAssertFalse(
            CameraIngestPolicy.canAccept(
                hasUploadTask: true,
                hasPendingBackgroundUpload: false
            )
        )
        XCTAssertFalse(
            CameraIngestPolicy.canAccept(
                hasUploadTask: false,
                hasPendingBackgroundUpload: true
            )
        )
    }
}
```

Run:

```bash
cd ios
xcodebuild test -project afterimage.xcodeproj -scheme afterimage -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -only-testing:afterimageTests/CameraIngestPolicyTests CODE_SIGNING_ALLOWED=NO
```

Expected: compilation fails because `CameraIngestPolicy` does not exist.

- [ ] **Step 2: Implement the policy and verify GREEN**

```swift
enum CameraIngestPolicy {
    static func canAccept(
        hasUploadTask: Bool,
        hasPendingBackgroundUpload: Bool
    ) -> Bool {
        !hasUploadTask && !hasPendingBackgroundUpload
    }
}
```

Run the command from Step 1.

Expected: `CameraIngestPolicyTests` passes.

- [ ] **Step 3: Refactor picker loading away from common processing**

Change the picker loop to:

```swift
upload = UploadPresentation(
    stage: .importing,
    progress: 0.02,
    current: position + 1,
    total: plan.uploadIndexes.count
)
let media = try await MediaImporter.load(items[index])
try await process(
    media: media,
    identity: identities[index],
    current: position + 1,
    total: plan.uploadIndexes.count
)
```

Change the common method signature to:

```swift
private func process(
    media: ImportedMedia,
    identity: ImportIdentity?,
    current: Int,
    total: Int
) async throws
```

Keep `defer { media.removeTemporaryFile() }`, optimization, asset creation,
background handoff, cleanup, and location propagation unchanged.

- [ ] **Step 4: Add captured-video acceptance**

```swift
@discardableResult
func importCapturedMedia(_ media: ImportedMedia) -> Bool {
    guard CameraIngestPolicy.canAccept(
        hasUploadTask: uploadTask != nil,
        hasPendingBackgroundUpload: BackgroundUploadManager.shared.hasPendingUpload
    ) else {
        return false
    }
    haptics.play(.lift)
    importSelectionSummary = nil
    uploadTask = Task { [weak self] in
        guard let self else { return }
        do {
            try await self.process(
                media: media,
                identity: nil,
                current: 1,
                total: 1
            )
        } catch {
            if !Task.isCancelled {
                self.haptics.play(.failure)
                self.show(error: error)
            }
        }
        self.upload = nil
        self.uploadTask = nil
    }
    return true
}
```

- [ ] **Step 5: Run focused and existing import tests, then commit**

Run:

```bash
cd ios
xcodebuild test -project afterimage.xcodeproj -scheme afterimage -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -only-testing:afterimageTests/CameraIngestPolicyTests -only-testing:afterimageTests/ImportIdentityTests -only-testing:afterimageTests/ImportMetadataTests CODE_SIGNING_ALLOWED=NO
```

Expected: all selected tests pass.

Commit:

```bash
git add ios/Sources/Features/Camera/CameraIngestPolicy.swift ios/Tests/CameraIngestPolicyTests.swift ios/Sources/App/AppModel.swift
git commit -m "feat(ios): accept captured videos in media ingest"
```

### Task 3: Testable camera state model

**Files:**
- Create: `ios/Sources/Features/Camera/CameraCaptureClient.swift`
- Create: `ios/Sources/Features/Camera/CameraCaptureModel.swift`
- Create: `ios/Tests/CameraCaptureModelTests.swift`

**Interfaces:**
- Consumes: Task 1 policies and `CameraTemporaryFileStore`.
- Produces: `CameraCapturedVideo`, `CameraCaptureFailure`, `CameraCaptureState`, `CameraCaptureEvent`.
- Produces: `CameraCaptureClient` closure boundary and `CameraCaptureModel`.
- Produces: `CameraCaptureModel.start`, `record`, `continueWithoutAudio`, `stopRecording`, `retake`, `transfer`, `sceneBecameInactive`, `sceneBecameActive`.

- [ ] **Step 1: Write failing state-model tests**

```swift
import AVFoundation
import XCTest
@testable import afterimage

@MainActor
final class CameraCaptureModelTests: XCTestCase {
    func testAuthorizedCameraBecomesReady() async {
        var configured = false
        var started = false
        let client = makeClient(
            cameraPermission: .authorized,
            microphonePermission: .authorized,
            configure: { _ in configured = true },
            startSession: { started = true }
        )
        let model = CameraCaptureModel(client: client)

        await model.start()

        XCTAssertEqual(model.state, .ready)
        XCTAssertTrue(configured)
        XCTAssertTrue(started)
    }

    func testDeniedMicrophoneRequiresSilentConfirmation() async {
        let client = makeClient(
            cameraPermission: .authorized,
            microphonePermission: .denied
        )
        let model = CameraCaptureModel(client: client)
        await model.start()

        await model.record()

        XCTAssertEqual(model.state, .confirmingSilentRecording)
    }

    func testSuccessfulFinalizationProducesReviewWithoutTransferringOwnership() async throws {
        var eventHandler: ((CameraCaptureEvent) -> Void)?
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let store = CameraTemporaryFileStore(directory: directory)
        let client = makeClient(
            cameraPermission: .authorized,
            microphonePermission: .authorized,
            configure: { handler in eventHandler = handler }
        )
        let model = CameraCaptureModel(client: client, fileStore: store)
        await model.start()
        await model.record()

        eventHandler?(.recordingFinished(.success(())))

        guard case .review(let video) = model.state else {
            return XCTFail("Expected review")
        }
        XCTAssertTrue(video.hasAudio)
        XCTAssertEqual(video.url.pathExtension, "mov")
    }

    func testRejectedTransferKeepsReviewOwnership() async {
        var eventHandler: ((CameraCaptureEvent) -> Void)?
        let client = makeClient(
            cameraPermission: .authorized,
            microphonePermission: .authorized,
            configure: { handler in eventHandler = handler }
        )
        let model = CameraCaptureModel(client: client)
        await model.start()
        await model.record()
        eventHandler?(.recordingFinished(.success(())))

        XCTAssertFalse(model.transfer { _ in false })
        guard case .review = model.state else {
            return XCTFail("Expected retained review")
        }
    }
}

@MainActor
private func makeClient(
    cameraPermission: CameraPermission,
    microphonePermission: CameraPermission,
    configure: @escaping (@escaping @MainActor (CameraCaptureEvent) -> Void) async throws -> Void = { _ in },
    startSession: @escaping () -> Void = {}
) -> CameraCaptureClient {
    CameraCaptureClient(
        session: AVCaptureSession(),
        cameraPermission: { cameraPermission },
        requestCameraPermission: { cameraPermission == .authorized },
        microphonePermission: { microphonePermission },
        requestMicrophonePermission: { microphonePermission == .authorized },
        configure: configure,
        startSession: startSession,
        stopSession: {},
        startRecording: { _, _ in },
        stopRecording: {},
        switchCamera: { .front },
        focus: { _ in },
        zoom: { _ in },
        attachPreviewLayer: { _ in }
    )
}
```

- [ ] **Step 2: Generate the project and verify RED**

Run:

```bash
cd ios
xcodegen generate
xcodebuild test -project afterimage.xcodeproj -scheme afterimage -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -only-testing:afterimageTests/CameraCaptureModelTests CODE_SIGNING_ALLOWED=NO
```

Expected: compilation fails because the camera client, model, state, and result types do not exist.

- [ ] **Step 3: Implement result, failure, state, event, and client types**

```swift
import AVFoundation
import CoreGraphics
import Foundation

struct CameraCapturedVideo: Equatable, Sendable {
    let url: URL
    let capturedAt: Date
    let hasAudio: Bool

    var importedMedia: ImportedMedia {
        ImportedMedia(
            kind: .video,
            url: url,
            originalFilename: url.lastPathComponent,
            capturedAt: capturedAt,
            location: nil
        )
    }
}

enum CameraCaptureFailure: Error, Equatable, Sendable {
    case cameraPermissionDenied
    case cameraUnavailable
    case configurationFailed
    case recordingFailed
}

enum CameraCaptureState: Equatable, Sendable {
    case authorizing
    case configuring
    case ready
    case confirmingSilentRecording
    case recording(startedAt: Date)
    case finalizing
    case review(CameraCapturedVideo)
    case interrupted
    case failed(CameraCaptureFailure)
    case transferred
}

enum CameraCaptureEvent: Sendable {
    case recordingFinished(Result<Void, CameraCaptureFailure>)
    case interrupted
    case interruptionEnded
    case runtimeFailure
}
```

`CameraCaptureClient` stores concrete closures:

```swift
@MainActor
struct CameraCaptureClient {
    let session: AVCaptureSession
    let cameraPermission: () -> CameraPermission
    let requestCameraPermission: () async -> Bool
    let microphonePermission: () -> CameraPermission
    let requestMicrophonePermission: () async -> Bool
    let configure: (@escaping @MainActor (CameraCaptureEvent) -> Void) async throws -> Void
    let startSession: () -> Void
    let stopSession: () -> Void
    let startRecording: (URL, Bool) throws -> Void
    let stopRecording: () -> Void
    let switchCamera: () async throws -> AVCaptureDevice.Position
    let focus: (CGPoint) -> Void
    let zoom: (CGFloat) -> Void
    let attachPreviewLayer: (AVCaptureVideoPreviewLayer) -> Void
}
```

The test file owns a `makeClient` helper that fills unused closures with no-op
behavior and never touches physical camera hardware.

- [ ] **Step 4: Implement the main-actor model**

Implement state transitions exactly through `CameraCapturePolicy`. `record`
creates a URL before invoking the client, records the start time, and remembers
whether the audio input was requested. `recordingFinished(.success)` produces
`.review`; failure removes the owned URL and produces `.failed`.

`transfer` must be:

```swift
@discardableResult
func transfer(_ accept: (ImportedMedia) -> Bool) -> Bool {
    guard case .review(let video) = state,
          accept(video.importedMedia) else {
        return false
    }
    state = .transferred
    return true
}
```

- [ ] **Step 5: Run model tests and commit**

Run the command from Step 2.

Expected: `CameraCaptureModelTests` passes.

Commit:

```bash
git add ios/Sources/Features/Camera/CameraCaptureClient.swift ios/Sources/Features/Camera/CameraCaptureModel.swift ios/Tests/CameraCaptureModelTests.swift
git commit -m "feat(ios): model camera recording states"
```

### Task 4: AVFoundation live camera adapter

**Files:**
- Create: `ios/Sources/Features/Camera/CameraCaptureSession.swift`
- Modify: `ios/Sources/Features/Camera/CameraCaptureClient.swift`
- Modify: `scripts/verify-ios-contract.mjs`

**Interfaces:**
- Consumes: `CameraCaptureClient`, `CameraCaptureEvent`, and `CameraCaptureFailure`.
- Produces: `CameraCaptureClient.live()`.
- Owns: `AVCaptureSession`, selected camera input, optional microphone input,
  `AVCaptureMovieFileOutput`, rotation coordinator, and recording delegate.

- [ ] **Step 1: Add contract requirements and verify RED**

Require these symbols in the iOS source contract:

```text
AVCaptureMovieFileOutput
AVCaptureVideoPreviewLayer
AVCaptureDevice.RotationCoordinator
NSCameraUsageDescription
NSMicrophoneUsageDescription
```

Run:

```bash
npm run check:ios
```

Expected: FAIL because the AVFoundation adapter and permission keys do not exist.

- [ ] **Step 2: Implement session configuration and lifecycle**

`CameraCaptureSession` is an `NSObject, @unchecked Sendable` with:

```swift
let session = AVCaptureSession()
private let queue = DispatchQueue(label: "afterimage.camera.capture")
private let movieOutput = AVCaptureMovieFileOutput()
private var videoInput: AVCaptureDeviceInput?
private var audioInput: AVCaptureDeviceInput?
private var eventHandler: (@MainActor (CameraCaptureEvent) -> Void)?
```

Configuration uses `.high`, the rear wide-angle camera, and
`beginConfiguration` / `commitConfiguration`. `startRunning` and `stopRunning`
execute only on `queue`. `switchCamera` atomically replaces the video input and
returns the resulting position.

- [ ] **Step 3: Implement file-backed recording and events**

Before recording with audio, add the default audio input when authorized.
Without audio, remove any audio input. Call:

```swift
movieOutput.startRecording(to: url, recordingDelegate: self)
```

`fileOutput(_:didFinishRecordingTo:from:error:)` emits success when there is no
error or `AVErrorRecordingSuccessfullyFinishedKey` is true; otherwise it emits
`.recordingFailed`. Runtime and interruption notifications emit the matching
`CameraCaptureEvent`.

- [ ] **Step 4: Implement focus, zoom, and rotation**

Focus converts the preview point before calling:

```swift
device.focusPointOfInterest = point
device.exposurePointOfInterest = point
device.focusMode = .continuousAutoFocus
device.exposureMode = .continuousAutoExposure
```

Zoom clamps to `1...min(device.activeFormat.videoMaxZoomFactor, 8)`.
`attachPreviewLayer` creates `AVCaptureDevice.RotationCoordinator`, observes
preview and capture angles, and writes supported angles to preview and movie
connections.

- [ ] **Step 5: Wire the live client and verify contract GREEN**

`CameraCaptureClient.live()` owns one `CameraCaptureSession` and forwards every
closure to it.

Run:

```bash
npm run check:ios
```

Expected: source contract still fails only for permission/localization files,
which Task 5 supplies. The Swift symbols are present.

### Task 5: Camera UI, timeline entry, permissions, and localization

**Files:**
- Create: `ios/Sources/Features/Camera/CameraPreview.swift`
- Create: `ios/Sources/Features/Camera/CameraCaptureView.swift`
- Modify: `ios/Sources/Features/Timeline/TimelineView.swift`
- Modify: `ios/Resources/Info.plist`
- Modify: `ios/Resources/Localizable.xcstrings`
- Modify: `ios/Resources/Localization/ja.lproj/InfoPlist.strings`
- Modify: `ios/Resources/Localization/en.lproj/InfoPlist.strings`
- Modify: `ios/Resources/Localization/zh-Hans.lproj/InfoPlist.strings`
- Modify: `ios/Resources/Localization/ko.lproj/InfoPlist.strings`

**Interfaces:**
- Consumes: `CameraCaptureModel`, `CameraCaptureClient.live`, and
  `AppModel.importCapturedMedia`.
- Produces: full-screen recording, silent confirmation, review/retake/accept,
  settings recovery, scene lifecycle, focus, zoom, and camera switching UI.

- [ ] **Step 1: Add permission keys and localized usage strings**

Add to `Info.plist`:

```xml
<key>NSCameraUsageDescription</key>
<string>afterimageの動画をアプリ内で撮影するためにカメラを使用します。</string>
<key>NSMicrophoneUsageDescription</key>
<string>撮影する動画に音声を記録するためにマイクを使用します。</string>
```

Add localized values for both keys to every `InfoPlist.strings`.

- [ ] **Step 2: Add UI localization keys**

Add four-locale values for:

```text
camera.action.close
camera.action.open_settings
camera.action.record
camera.action.stop
camera.action.switch_camera
camera.action.retake
camera.action.use_video
camera.action.record_without_audio
camera.action.cancel
camera.status.configuring
camera.status.finalizing
camera.status.no_audio
camera.permission.title
camera.permission.message
camera.microphone.title
camera.microphone.message
camera.error.unavailable
camera.error.configuration
camera.error.recording
camera.discard.title
camera.discard.message
camera.discard.confirm
camera.source.record
camera.source.library
```

- [ ] **Step 3: Implement the preview bridge**

`CameraPreview` hosts a `UIView` whose `layerClass` is
`AVCaptureVideoPreviewLayer`. Its coordinator installs one tap recognizer and
one pinch recognizer. Tap passes both layer and device points for focus
feedback; pinch passes a cumulative scale to the model; `makeUIView` attaches
the preview layer for rotation.

- [ ] **Step 4: Implement the full-screen camera**

`CameraCaptureView` owns:

```swift
@StateObject private var model = CameraCaptureModel(client: .live())
@EnvironmentObject private var appModel: AppModel
@Environment(\.dismiss) private var dismiss
@Environment(\.scenePhase) private var scenePhase
```

Render one branch per `CameraCaptureState`. Ready/recording show the full-screen
preview, Liquid Glass close/camera-switch controls, record/stop control, elapsed
time, focus feedback, and the `音声なし` badge. Finalizing shows progress. Review
uses local `VideoPlayer` with retake and `この動画を使う`. Permission failure
shows settings and close.

Acceptance calls:

```swift
if model.transfer({ appModel.importCapturedMedia($0) }) {
    dismiss()
}
```

- [ ] **Step 5: Replace the plus button with a source menu**

Add an item-driven camera destination to `TimelineView`. Keep the existing
video-only `PhotosPicker` unchanged inside a `Menu`; add an `アプリで撮影`
button that opens the full-screen cover. Preserve the circular Liquid Glass
plus label and disable the entire source entry while upload UI owns the dock.

- [ ] **Step 6: Run contract and focused model tests**

Run:

```bash
npm run check:ios
cd ios
xcodegen generate
xcodebuild test -project afterimage.xcodeproj -scheme afterimage -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -only-testing:afterimageTests/CameraCapturePolicyTests -only-testing:afterimageTests/CameraTemporaryFileStoreTests -only-testing:afterimageTests/CameraIngestPolicyTests -only-testing:afterimageTests/CameraCaptureModelTests CODE_SIGNING_ALLOWED=NO
```

Expected: contract, localization, and all camera tests pass.

- [ ] **Step 7: Commit camera implementation**

```bash
git add ios/Sources/Features/Camera ios/Sources/Features/Timeline/TimelineView.swift ios/Resources/Info.plist ios/Resources/Localizable.xcstrings ios/Resources/Localization scripts/verify-ios-contract.mjs
git commit -m "feat(ios): record videos inside the app"
```

### Task 6: Full verification, manual QA, and PR

**Files:**
- Modify only files required by defects found during verification.

**Interfaces:**
- Verifies the complete design against the production app surface.

- [ ] **Step 1: Run diagnostics, full XCTest, and repository checks**

Run:

```bash
npm ci
npm run check
cd ios
xcodegen generate
xcodebuild test -project afterimage.xcodeproj -scheme afterimage -destination 'platform=iOS Simulator,name=iPhone 17 Pro' CODE_SIGNING_ALLOWED=NO
```

Expected: every command exits 0 with zero failed tests.

- [ ] **Step 2: Run simulator manual QA**

Launch the app with a development session and verify that the plus menu exposes
both recording and the unchanged video library picker. Open recording in the
simulator and verify the explicit unavailable-camera state, settings/close
actions, localization, and dismissal without a crash.

- [ ] **Step 3: Run physical-device QA when a connected iOS 26 device exists**

Verify rear/front recording, audio and silent paths, focus, zoom, rotation,
retake, discard, acceptance, compression, upload cancellation, backgrounding,
and that Photos receives no new item. Record device and codec evidence. If no
device is connected, state that the physical capture matrix remains a required
post-PR gate.

- [ ] **Step 4: Self-review and fresh verification**

Inspect the complete diff for unused abstractions, duplicated state, source
comments, `any`, unbounded media reads, accidental photo import changes,
credentials, and unrelated edits. Fix defects with a failing regression test,
then rerun Step 1 once.

- [ ] **Step 5: Push and open the draft PR**

```bash
git push -u origin agent/in-app-camera-capture
gh pr create --draft --base main --head agent/in-app-camera-capture --title "feat(ios): record videos inside the app" --body-file <temporary-pr-body>
```

The PR body must describe the video-only scope, privacy boundary, user flow,
tests, simulator QA, physical-device status, and Node/tooling warnings.
