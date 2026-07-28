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

    func testDiscardWhileConfiguringDoesNotStartSession() async {
        var finishConfiguration: (() -> Void)?
        var started = false
        let client = makeClient(
            cameraPermission: .authorized,
            microphonePermission: .authorized,
            configure: { _ in
                await withCheckedContinuation { continuation in
                    finishConfiguration = {
                        continuation.resume()
                    }
                }
            },
            startSession: { started = true }
        )
        let model = CameraCaptureModel(client: client)
        let startTask = Task {
            await model.start()
        }
        while finishConfiguration == nil {
            await Task.yield()
        }

        model.discard()
        finishConfiguration?()
        await startTask.value

        XCTAssertFalse(started)
    }

    func testDiscardIgnoresLateInterruptionEnd() async {
        var eventHandler: ((CameraCaptureEvent) -> Void)?
        var startCount = 0
        let client = makeClient(
            cameraPermission: .authorized,
            microphonePermission: .authorized,
            configure: { handler in eventHandler = handler },
            startSession: { startCount += 1 }
        )
        let model = CameraCaptureModel(client: client)
        await model.start()
        eventHandler?(.interrupted)

        model.discard()
        eventHandler?(.interruptionEnded)

        XCTAssertEqual(model.state, .interrupted)
        XCTAssertEqual(startCount, 1)
    }

    func testDiscardIgnoresSceneBecameActive() async {
        var startCount = 0
        let client = makeClient(
            cameraPermission: .authorized,
            microphonePermission: .authorized,
            startSession: { startCount += 1 }
        )
        let model = CameraCaptureModel(client: client)
        await model.start()

        model.discard()
        model.sceneBecameActive()

        XCTAssertEqual(startCount, 1)
    }

    func testBackgroundingWhileConfiguringDoesNotStartSession() async {
        var finishConfiguration: (() -> Void)?
        var startCount = 0
        let client = makeClient(
            cameraPermission: .authorized,
            microphonePermission: .authorized,
            configure: { _ in
                await withCheckedContinuation { continuation in
                    finishConfiguration = {
                        continuation.resume()
                    }
                }
            },
            startSession: { startCount += 1 }
        )
        let model = CameraCaptureModel(client: client)
        let startTask = Task {
            await model.start()
        }
        while finishConfiguration == nil {
            await Task.yield()
        }

        model.sceneBecameInactive()
        finishConfiguration?()
        await startTask.value

        XCTAssertEqual(model.state, .ready)
        XCTAssertEqual(startCount, 0)
        model.sceneBecameActive()
        XCTAssertEqual(startCount, 1)
    }

    func testInterruptionWhileConfiguringWaitsForInterruptionEnd() async {
        var eventHandler: ((CameraCaptureEvent) -> Void)?
        var finishConfiguration: (() -> Void)?
        var startCount = 0
        let client = makeClient(
            cameraPermission: .authorized,
            microphonePermission: .authorized,
            configure: { handler in
                eventHandler = handler
                await withCheckedContinuation { continuation in
                    finishConfiguration = {
                        continuation.resume()
                    }
                }
            },
            startSession: { startCount += 1 }
        )
        let model = CameraCaptureModel(client: client)
        let startTask = Task {
            await model.start()
        }
        while finishConfiguration == nil {
            await Task.yield()
        }

        eventHandler?(.interrupted)
        finishConfiguration?()
        await startTask.value

        XCTAssertEqual(model.state, .interrupted)
        XCTAssertEqual(startCount, 0)
        eventHandler?(.interruptionEnded)
        XCTAssertEqual(model.state, .ready)
        XCTAssertEqual(startCount, 1)
    }

    func testConfigurationCompletesAfterInterruptionAlreadyEnded() async {
        var eventHandler: ((CameraCaptureEvent) -> Void)?
        var finishConfiguration: (() -> Void)?
        var startCount = 0
        let client = makeClient(
            cameraPermission: .authorized,
            microphonePermission: .authorized,
            configure: { handler in
                eventHandler = handler
                await withCheckedContinuation { continuation in
                    finishConfiguration = {
                        continuation.resume()
                    }
                }
            },
            startSession: { startCount += 1 }
        )
        let model = CameraCaptureModel(client: client)
        let startTask = Task {
            await model.start()
        }
        while finishConfiguration == nil {
            await Task.yield()
        }

        eventHandler?(.interrupted)
        eventHandler?(.interruptionEnded)

        XCTAssertEqual(model.state, .configuring)
        XCTAssertEqual(startCount, 0)
        finishConfiguration?()
        await startTask.value
        XCTAssertEqual(model.state, .ready)
        XCTAssertEqual(startCount, 1)
    }

    func testRuntimeFailureWhileConfiguringCannotBeOverwritten() async {
        var eventHandler: ((CameraCaptureEvent) -> Void)?
        var finishConfiguration: (() -> Void)?
        var startCount = 0
        let client = makeClient(
            cameraPermission: .authorized,
            microphonePermission: .authorized,
            configure: { handler in
                eventHandler = handler
                await withCheckedContinuation { continuation in
                    finishConfiguration = {
                        continuation.resume()
                    }
                }
            },
            startSession: { startCount += 1 }
        )
        let model = CameraCaptureModel(client: client)
        let startTask = Task {
            await model.start()
        }
        while finishConfiguration == nil {
            await Task.yield()
        }

        eventHandler?(.runtimeFailure(requiresSessionRebuild: false))
        finishConfiguration?()
        await startTask.value

        XCTAssertEqual(model.state, .failed(.configurationFailed))
        XCTAssertEqual(startCount, 0)
    }

    func testMediaServicesResetSupersedesInFlightConfiguration() async {
        var eventHandler: ((CameraCaptureEvent) -> Void)?
        var configurationFinishes: [() -> Void] = []
        var resetCount = 0
        var startCount = 0
        let client = makeClient(
            cameraPermission: .authorized,
            microphonePermission: .authorized,
            configure: { handler in
                eventHandler = handler
                await withCheckedContinuation { continuation in
                    configurationFinishes.append {
                        continuation.resume()
                    }
                }
            },
            startSession: { startCount += 1 },
            resetSession: { resetCount += 1 }
        )
        let model = CameraCaptureModel(client: client)
        let startTask = Task {
            await model.start()
        }
        while configurationFinishes.count < 1 {
            await Task.yield()
        }

        eventHandler?(.runtimeFailure(requiresSessionRebuild: true))
        while configurationFinishes.count < 2 {
            await Task.yield()
        }
        configurationFinishes[0]()
        await startTask.value

        XCTAssertEqual(model.state, .configuring)
        XCTAssertEqual(startCount, 0)
        configurationFinishes[1]()
        for _ in 0..<100 where model.state != .ready {
            await Task.yield()
        }
        XCTAssertEqual(resetCount, 1)
        XCTAssertEqual(model.state, .ready)
        XCTAssertEqual(startCount, 1)
    }

    func testInterruptionEndWaitsForMediaServicesResetConfiguration() async {
        var eventHandler: ((CameraCaptureEvent) -> Void)?
        var finishReset: (() -> Void)?
        var startCount = 0
        let client = makeClient(
            cameraPermission: .authorized,
            microphonePermission: .authorized,
            configure: { handler in eventHandler = handler },
            startSession: { startCount += 1 },
            resetSession: {
                await withCheckedContinuation { continuation in
                    finishReset = {
                        continuation.resume()
                    }
                }
            }
        )
        let model = CameraCaptureModel(client: client)
        await model.start()
        eventHandler?(.interrupted)

        eventHandler?(.runtimeFailure(requiresSessionRebuild: true))
        eventHandler?(.interruptionEnded)

        XCTAssertEqual(model.state, .configuring)
        XCTAssertEqual(startCount, 1)
        while finishReset == nil {
            await Task.yield()
        }
        finishReset?()
        for _ in 0..<100 where model.state != .ready {
            await Task.yield()
        }
        XCTAssertEqual(model.state, .ready)
        XCTAssertEqual(startCount, 2)
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
        XCTAssertTrue(model.showsNoAudioBadge)
    }

    func testSilentFinalizationProducesReviewWithoutAudio() async {
        var eventHandler: ((CameraCaptureEvent) -> Void)?
        let client = makeClient(
            cameraPermission: .authorized,
            microphonePermission: .denied,
            configure: { handler in eventHandler = handler },
            recordingHasAudio: { _ in false }
        )
        let model = CameraCaptureModel(client: client)
        await model.start()
        await model.record()

        model.continueWithoutAudio()
        XCTAssertEqual(
            model.accessibilityAnnouncement?.kind,
            .silentRecordingStarted
        )
        eventHandler?(.recordingFinished(.success(())))
        await waitForReview(model)

        guard case .review(let video) = model.state else {
            return XCTFail("Expected review")
        }
        XCTAssertFalse(video.hasAudio)
        XCTAssertEqual(
            model.accessibilityAnnouncement?.kind,
            .reviewReady
        )
    }

    func testFinalizationUsesRecordedFileAudioTrackState() async {
        var eventHandler: ((CameraCaptureEvent) -> Void)?
        let client = makeClient(
            cameraPermission: .authorized,
            microphonePermission: .authorized,
            configure: { handler in eventHandler = handler },
            recordingHasAudio: { _ in false }
        )
        let model = CameraCaptureModel(client: client)
        await model.start()
        await model.record()

        eventHandler?(.recordingFinished(.success(())))
        await waitForReview(model)

        guard case .review(let video) = model.state else {
            return XCTFail("Expected review")
        }
        XCTAssertFalse(video.hasAudio)
    }

    func testSuccessfulFinalizationProducesReviewWithoutTransferringOwnership() async {
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
        await waitForReview(model)

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
        await waitForReview(model)

        XCTAssertFalse(model.transfer { _ in false })
        guard case .review = model.state else {
            return XCTFail("Expected retained review")
        }
    }

    func testAcceptedTransferMovesFileOwnership() async throws {
        var eventHandler: ((CameraCaptureEvent) -> Void)?
        var recordedURL: URL?
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let store = CameraTemporaryFileStore(directory: directory)
        let client = makeClient(
            cameraPermission: .authorized,
            microphonePermission: .authorized,
            configure: { handler in eventHandler = handler },
            startRecording: { url, _ in
                recordedURL = url
                FileManager.default.createFile(
                    atPath: url.path,
                    contents: Data("video".utf8)
                )
            }
        )
        let model = CameraCaptureModel(client: client, fileStore: store)
        await model.start()
        await model.record()
        eventHandler?(.recordingFinished(.success(())))
        await waitForReview(model)

        var acceptedURL: URL?
        XCTAssertTrue(
            model.transfer {
                acceptedURL = $0.url
                return true
            }
        )

        XCTAssertEqual(model.state, .transferred)
        XCTAssertEqual(acceptedURL, recordedURL)
        XCTAssertFalse(model.transfer { _ in true })
        guard let recordedURL else {
            return XCTFail("Expected recording URL")
        }
        XCTAssertTrue(FileManager.default.fileExists(atPath: recordedURL.path))
        try FileManager.default.removeItem(at: recordedURL)
    }

    func testOpeningAnotherCameraDoesNotDeleteTransferredRecording() async throws {
        var eventHandler: ((CameraCaptureEvent) -> Void)?
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let firstStore = CameraTemporaryFileStore(
            rootDirectory: root,
            sessionID: UUID()
        )
        let secondStore = CameraTemporaryFileStore(
            rootDirectory: root,
            sessionID: UUID()
        )
        let client = makeClient(
            cameraPermission: .authorized,
            microphonePermission: .authorized,
            configure: { handler in eventHandler = handler },
            startRecording: { url, _ in
                FileManager.default.createFile(
                    atPath: url.path,
                    contents: Data("video".utf8)
                )
            }
        )
        let first = CameraCaptureModel(client: client, fileStore: firstStore)
        await first.start()
        await first.record()
        eventHandler?(.recordingFinished(.success(())))
        await waitForReview(first)
        var transferredURL: URL?
        XCTAssertTrue(
            first.transfer {
                transferredURL = $0.url
                return true
            }
        )

        _ = CameraCaptureModel(client: client, fileStore: secondStore)

        guard let transferredURL else {
            return XCTFail("Expected transferred URL")
        }
        XCTAssertTrue(
            FileManager.default.fileExists(atPath: transferredURL.path)
        )
        try FileManager.default.removeItem(at: root)
    }

    func testRetakeDeletesCameraOwnedRecording() async {
        let result = await makeRecordedModel()

        await result.model.retake()

        XCTAssertEqual(result.model.state, .ready)
        XCTAssertFalse(
            FileManager.default.fileExists(atPath: result.url.path)
        )
    }

    func testDiscardDeletesCameraOwnedRecording() async {
        let result = await makeRecordedModel()

        result.model.discard()

        XCTAssertFalse(
            FileManager.default.fileExists(atPath: result.url.path)
        )
    }

    func testDeinitializationStopsSessionAndDeletesOwnedRecording() async {
        var recordedURL: URL?
        var stopSessionCount = 0
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let store = CameraTemporaryFileStore(directory: directory)
        var model: CameraCaptureModel? = CameraCaptureModel(
            client: makeClient(
                cameraPermission: .authorized,
                microphonePermission: .authorized,
                stopSession: { stopSessionCount += 1 },
                startRecording: { url, _ in
                    recordedURL = url
                    FileManager.default.createFile(
                        atPath: url.path,
                        contents: Data("video".utf8)
                    )
                }
            ),
            fileStore: store
        )
        await model?.start()
        await model?.record()
        weak let releasedModel = model

        model = nil

        guard let recordedURL else {
            return XCTFail("Expected recording URL")
        }
        XCTAssertNil(releasedModel)
        XCTAssertEqual(stopSessionCount, 1)
        XCTAssertFalse(
            FileManager.default.fileExists(atPath: recordedURL.path)
        )
    }

    func testDiscardIgnoresLateRetake() async {
        var eventHandler: ((CameraCaptureEvent) -> Void)?
        var startCount = 0
        let client = makeClient(
            cameraPermission: .authorized,
            microphonePermission: .authorized,
            configure: { handler in eventHandler = handler },
            startSession: { startCount += 1 }
        )
        let model = CameraCaptureModel(client: client)
        await model.start()
        await model.record()
        eventHandler?(.recordingFinished(.success(())))
        await waitForReview(model)

        model.discard()
        await model.retake()

        XCTAssertEqual(startCount, 1)
    }

    func testFailedFinalizationDeletesPartialRecording() async {
        var eventHandler: ((CameraCaptureEvent) -> Void)?
        var recordedURL: URL?
        let client = makeClient(
            cameraPermission: .authorized,
            microphonePermission: .authorized,
            configure: { handler in eventHandler = handler },
            startRecording: { url, _ in
                recordedURL = url
                FileManager.default.createFile(
                    atPath: url.path,
                    contents: Data("partial".utf8)
                )
            }
        )
        let model = CameraCaptureModel(client: client)
        await model.start()
        await model.record()

        eventHandler?(.recordingFinished(.failure(.recordingFailed)))

        guard let recordedURL else {
            return XCTFail("Expected recording URL")
        }
        XCTAssertEqual(model.state, .failed(.recordingFailed))
        XCTAssertFalse(
            FileManager.default.fileExists(atPath: recordedURL.path)
        )
        XCTAssertEqual(
            model.accessibilityAnnouncement?.kind,
            .captureFailed
        )
    }

    func testAudioInspectionFailureDeletesFinalizedRecording() async {
        var eventHandler: ((CameraCaptureEvent) -> Void)?
        var recordedURL: URL?
        let client = makeClient(
            cameraPermission: .authorized,
            microphonePermission: .authorized,
            configure: { handler in eventHandler = handler },
            startRecording: { url, _ in
                recordedURL = url
                FileManager.default.createFile(
                    atPath: url.path,
                    contents: Data("video".utf8)
                )
            },
            recordingHasAudio: { _ in
                throw CameraCaptureFailure.recordingFailed
            }
        )
        let model = CameraCaptureModel(client: client)
        await model.start()
        await model.record()

        eventHandler?(.recordingFinished(.success(())))
        for _ in 0..<100 where model.state != .failed(.recordingFailed) {
            await Task.yield()
        }

        guard let recordedURL else {
            return XCTFail("Expected recording URL")
        }
        XCTAssertEqual(model.state, .failed(.recordingFailed))
        XCTAssertFalse(
            FileManager.default.fileExists(atPath: recordedURL.path)
        )
    }

    func testInsufficientStorageFinalizationIsRetryable() async {
        var eventHandler: ((CameraCaptureEvent) -> Void)?
        let client = makeClient(
            cameraPermission: .authorized,
            microphonePermission: .authorized,
            configure: { handler in eventHandler = handler }
        )
        let model = CameraCaptureModel(client: client)
        await model.start()
        await model.record()

        eventHandler?(.recordingFinished(.failure(.insufficientStorage)))

        XCTAssertEqual(model.state, .failed(.insufficientStorage))
        await model.retry()
        XCTAssertEqual(model.state, .ready)
    }

    func testStoppingRecordingAnnouncesStateChange() async {
        let client = makeClient(
            cameraPermission: .authorized,
            microphonePermission: .authorized
        )
        let model = CameraCaptureModel(client: client)
        await model.start()
        await model.record()

        model.stopRecording()

        XCTAssertEqual(
            model.accessibilityAnnouncement?.kind,
            .recordingStopped
        )
    }

    func testRuntimeFailureStopsRecordingBeforeCleanup() async {
        var eventHandler: ((CameraCaptureEvent) -> Void)?
        var stopped = false
        let client = makeClient(
            cameraPermission: .authorized,
            microphonePermission: .authorized,
            configure: { handler in eventHandler = handler },
            stopRecording: { stopped = true }
        )
        let model = CameraCaptureModel(client: client)
        await model.start()
        await model.record()

        eventHandler?(.runtimeFailure(requiresSessionRebuild: true))

        XCTAssertTrue(stopped)
        XCTAssertEqual(model.state, .finalizing)
    }

    func testMediaServicesResetRebuildsReadySession() async {
        var eventHandler: ((CameraCaptureEvent) -> Void)?
        var resetCount = 0
        let client = makeClient(
            cameraPermission: .authorized,
            microphonePermission: .authorized,
            configure: { handler in eventHandler = handler },
            resetSession: { resetCount += 1 }
        )
        let model = CameraCaptureModel(client: client)
        await model.start()

        eventHandler?(.runtimeFailure(requiresSessionRebuild: true))
        for _ in 0..<100 where model.state != .ready || resetCount == 0 {
            await Task.yield()
        }

        XCTAssertEqual(resetCount, 1)
        XCTAssertEqual(model.state, .ready)
    }

    func testRetryRebuildsRecoverableFailure() async {
        var eventHandler: ((CameraCaptureEvent) -> Void)?
        var resetCount = 0
        let client = makeClient(
            cameraPermission: .authorized,
            microphonePermission: .authorized,
            configure: { handler in eventHandler = handler },
            resetSession: { resetCount += 1 }
        )
        let model = CameraCaptureModel(client: client)
        await model.start()
        eventHandler?(.runtimeFailure(requiresSessionRebuild: false))

        await model.retry()

        XCTAssertEqual(resetCount, 1)
        XCTAssertEqual(model.state, .ready)
    }

    func testFinalizingIgnoresFocusAndZoom() async {
        var focusCount = 0
        var zoomCount = 0
        let client = makeClient(
            cameraPermission: .authorized,
            microphonePermission: .authorized,
            focus: { _ in focusCount += 1 },
            zoom: { _ in zoomCount += 1 }
        )
        let model = CameraCaptureModel(client: client)
        await model.start()
        await model.record()
        model.stopRecording()

        model.focus(at: .zero)
        model.zoom(to: 2)

        XCTAssertEqual(model.state, .finalizing)
        XCTAssertEqual(focusCount, 0)
        XCTAssertEqual(zoomCount, 0)
    }

    func testBackgroundingStopsAndFinalizesRecording() async {
        var stopped = false
        let client = makeClient(
            cameraPermission: .authorized,
            microphonePermission: .authorized,
            stopRecording: { stopped = true }
        )
        let model = CameraCaptureModel(client: client)
        await model.start()
        await model.record()

        model.sceneBecameInactive()

        XCTAssertTrue(stopped)
        XCTAssertEqual(model.state, .finalizing)
    }

    func testCaptureInterruptionResumesOnlyAfterInterruptionEnds() async {
        var eventHandler: ((CameraCaptureEvent) -> Void)?
        var startCount = 0
        let client = makeClient(
            cameraPermission: .authorized,
            microphonePermission: .authorized,
            configure: { handler in eventHandler = handler },
            startSession: { startCount += 1 }
        )
        let model = CameraCaptureModel(client: client)
        await model.start()
        eventHandler?(.interrupted)

        model.sceneBecameActive()

        XCTAssertEqual(model.state, .interrupted)
        XCTAssertEqual(startCount, 1)
        eventHandler?(.interruptionEnded)
        XCTAssertEqual(model.state, .ready)
        XCTAssertEqual(startCount, 2)
    }

    func testInterruptionEndingWhileInactiveDoesNotRestartSession() async {
        var eventHandler: ((CameraCaptureEvent) -> Void)?
        var startCount = 0
        let client = makeClient(
            cameraPermission: .authorized,
            microphonePermission: .authorized,
            configure: { handler in eventHandler = handler },
            startSession: { startCount += 1 }
        )
        let model = CameraCaptureModel(client: client)
        await model.start()
        eventHandler?(.interrupted)
        model.sceneBecameInactive()

        eventHandler?(.interruptionEnded)

        XCTAssertEqual(model.state, .ready)
        XCTAssertEqual(startCount, 1)
        model.sceneBecameActive()
        XCTAssertEqual(startCount, 2)
    }
}

@MainActor
private func makeClient(
    cameraPermission: CameraPermission,
    microphonePermission: CameraPermission,
    configure: @escaping (@escaping @MainActor (CameraCaptureEvent) -> Void) async throws -> Void = { _ in },
    startSession: @escaping () -> Void = {},
    stopSession: @escaping () -> Void = {},
    startRecording: @escaping (URL, Bool) throws -> Void = { _, _ in },
    stopRecording: @escaping () -> Void = {},
    recordingHasAudio: @escaping (URL) async throws -> Bool = { _ in true },
    resetSession: @escaping () async throws -> Void = {},
    focus: @escaping (CGPoint) -> Void = { _ in },
    zoom: @escaping (CGFloat) -> Void = { _ in }
) -> CameraCaptureClient {
    CameraCaptureClient(
        session: AVCaptureSession(),
        cameraPermission: { cameraPermission },
        requestCameraPermission: { cameraPermission == .authorized },
        microphonePermission: { microphonePermission },
        requestMicrophonePermission: { microphonePermission == .authorized },
        configure: configure,
        startSession: startSession,
        stopSession: stopSession,
        startRecording: startRecording,
        stopRecording: stopRecording,
        recordingHasAudio: recordingHasAudio,
        resetSession: resetSession,
        switchCamera: { .front },
        focus: focus,
        zoom: zoom,
        attachPreviewLayer: { _ in }
    )
}

@MainActor
private func makeRecordedModel() async -> (
    model: CameraCaptureModel,
    url: URL
) {
    var eventHandler: ((CameraCaptureEvent) -> Void)?
    var recordedURL: URL?
    let client = makeClient(
        cameraPermission: .authorized,
        microphonePermission: .authorized,
        configure: { handler in eventHandler = handler },
        startRecording: { url, _ in
            recordedURL = url
            FileManager.default.createFile(
                atPath: url.path,
                contents: Data("video".utf8)
            )
        }
    )
    let model = CameraCaptureModel(client: client)
    await model.start()
    await model.record()
    eventHandler?(.recordingFinished(.success(())))
    await waitForReview(model)
    guard let recordedURL else {
        preconditionFailure()
    }
    return (model, recordedURL)
}

@MainActor
private func waitForReview(_ model: CameraCaptureModel) async {
    for _ in 0..<100 {
        if case .review = model.state {
            return
        }
        await Task.yield()
    }
}
