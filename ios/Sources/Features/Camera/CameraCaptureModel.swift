@preconcurrency import AVFoundation
import CoreGraphics
import Foundation

@MainActor
final class CameraCaptureModel: ObservableObject {
    @Published private(set) var state: CameraCaptureState = .authorizing
    @Published private(set) var cameraPosition: AVCaptureDevice.Position = .back
    @Published private(set) var zoomFactor: CGFloat = 1
    @Published private(set) var showsNoAudioBadge = false
    @Published private(set) var accessibilityAnnouncement:
        CameraAccessibilityAnnouncement?

    let session: AVCaptureSession

    private let client: CameraCaptureClient
    private let fileStore: CameraTemporaryFileStore
    private var recordingURL: URL?
    private var recordingStartedAt: Date?
    private var isDiscarded = false
    private var isSceneActive = true
    private var configurationGeneration = 0
    private var isConfigurationInFlight = false
    private var isCaptureInterrupted = false
    private var needsSessionRebuild = false

    init(
        client: CameraCaptureClient,
        fileStore: CameraTemporaryFileStore = CameraTemporaryFileStore()
    ) {
        self.client = client
        self.fileStore = fileStore
        session = client.session
    }

    isolated deinit {
        guard !isDiscarded else { return }
        client.stopSession()
        if let recordingURL {
            fileStore.remove(recordingURL)
        }
    }

    func start() async {
        guard !isDiscarded else { return }
        switch CameraCapturePolicy.startAction(
            cameraPermission: client.cameraPermission()
        ) {
        case .requestPermission:
            state = .authorizing
            let isAuthorized = await client.requestCameraPermission()
            guard !isDiscarded, !Task.isCancelled else { return }
            guard isAuthorized else {
                fail(.cameraPermissionDenied)
                return
            }
            await configure()
        case .configure:
            await configure()
        case .showSettings:
            fail(.cameraPermissionDenied)
        }
    }

    func record() async {
        guard state == .ready else { return }
        switch CameraCapturePolicy.microphoneAction(
            permission: client.microphonePermission(),
            silentRecordingConfirmed: false
        ) {
        case .requestPermission:
            let isAuthorized = await client.requestMicrophonePermission()
            guard state == .ready, !isDiscarded else { return }
            if isAuthorized {
                showsNoAudioBadge = false
                beginRecording(hasAudio: true)
            } else {
                showsNoAudioBadge = true
                state = .confirmingSilentRecording
            }
        case .recordWithAudio:
            showsNoAudioBadge = false
            beginRecording(hasAudio: true)
        case .confirmSilentRecording:
            showsNoAudioBadge = true
            state = .confirmingSilentRecording
        case .recordWithoutAudio:
            showsNoAudioBadge = true
            beginRecording(hasAudio: false)
        }
    }

    func continueWithoutAudio() {
        guard state == .confirmingSilentRecording else { return }
        beginRecording(hasAudio: false)
    }

    func cancelSilentRecording() {
        guard state == .confirmingSilentRecording else { return }
        state = .ready
    }

    func stopRecording() {
        guard case .recording = state else { return }
        state = .finalizing
        client.stopRecording()
        announce(.recordingStopped)
    }

    func switchCamera() async {
        guard CameraCapturePolicy.allowsCameraSwitch(phase: capturePhase) else {
            return
        }
        do {
            cameraPosition = try await client.switchCamera()
            zoomFactor = 1
        } catch {
            fail(.cameraUnavailable)
        }
    }

    func focus(at point: CGPoint) {
        guard state == .ready || isRecording else { return }
        client.focus(point)
    }

    func zoom(to factor: CGFloat) {
        guard state == .ready || isRecording else { return }
        zoomFactor = max(1, factor)
        client.zoom(zoomFactor)
    }

    func retake() async {
        guard !isDiscarded,
              case .review(let video) = state else {
            return
        }
        fileStore.remove(video.url)
        clearRecording()
        if needsSessionRebuild {
            await configure(resetSession: true)
        } else {
            state = .ready
            client.startSession()
        }
    }

    func retry() async {
        switch state {
        case .failed(.cameraUnavailable),
             .failed(.configurationFailed),
             .failed(.recordingFailed),
             .failed(.insufficientStorage),
             .interrupted:
            await configure(resetSession: true)
        default:
            break
        }
    }

    @discardableResult
    func transfer(_ accept: (ImportedMedia) -> Bool) -> Bool {
        guard case .review(let video) = state,
              accept(video.importedMedia) else {
            return false
        }
        clearRecording()
        state = .transferred
        client.stopSession()
        return true
    }

    func discard() {
        guard !isDiscarded else { return }
        isDiscarded = true
        if case .review(let video) = state {
            fileStore.remove(video.url)
        } else if let recordingURL {
            fileStore.remove(recordingURL)
        }
        clearRecording()
        client.stopSession()
    }

    func sceneBecameInactive() {
        isSceneActive = false
        switch CameraCapturePolicy.backgroundAction(phase: capturePhase) {
        case .stopSession:
            client.stopSession()
        case .stopRecording:
            stopRecording()
        case .waitForFinalization:
            break
        }
    }

    func sceneBecameActive() {
        guard !isDiscarded else { return }
        isSceneActive = true
        switch state {
        case .ready, .confirmingSilentRecording:
            showsNoAudioBadge = client.microphonePermission() == .denied
            client.startSession()
        case .failed(.cameraPermissionDenied)
            where client.cameraPermission() == .authorized:
            Task {
                await start()
            }
        default:
            break
        }
    }

    func attachPreviewLayer(_ layer: AVCaptureVideoPreviewLayer) {
        client.attachPreviewLayer(layer)
    }

    private var capturePhase: CameraCapturePhase {
        switch state {
        case .authorizing:
            .authorizing
        case .configuring:
            .configuring
        case .ready:
            .ready
        case .confirmingSilentRecording:
            .confirmingSilentRecording
        case .recording:
            .recording
        case .finalizing:
            .finalizing
        case .review:
            .reviewing
        case .interrupted:
            .interrupted
        case .failed:
            .failed
        case .transferred:
            .transferred
        }
    }

    private func configure(resetSession: Bool = false) async {
        guard !isDiscarded else { return }
        configurationGeneration &+= 1
        let generation = configurationGeneration
        isConfigurationInFlight = true
        state = .configuring
        do {
            if resetSession {
                try await client.resetSession()
                needsSessionRebuild = false
            }
            try await client.configure { [weak self] event in
                self?.handle(event)
            }
            guard generation == configurationGeneration else { return }
            isConfigurationInFlight = false
            guard !isDiscarded, !Task.isCancelled else {
                client.stopSession()
                return
            }
            if isCaptureInterrupted {
                state = .interrupted
                return
            }
            if isSceneActive {
                client.startSession()
            }
            showsNoAudioBadge = client.microphonePermission() == .denied
            state = .ready
        } catch let failure as CameraCaptureFailure {
            guard generation == configurationGeneration else { return }
            isConfigurationInFlight = false
            guard !isDiscarded, !Task.isCancelled else { return }
            fail(failure)
        } catch {
            guard generation == configurationGeneration else { return }
            isConfigurationInFlight = false
            guard !isDiscarded, !Task.isCancelled else { return }
            fail(.configurationFailed)
        }
    }

    private func beginRecording(hasAudio: Bool) {
        guard !isDiscarded else { return }
        do {
            let url = try fileStore.makeRecordingURL()
            let startedAt = Date()
            try client.startRecording(url, hasAudio)
            recordingURL = url
            recordingStartedAt = startedAt
            state = .recording(startedAt: startedAt)
            announce(
                hasAudio
                    ? .recordingStarted
                    : .silentRecordingStarted
            )
        } catch {
            clearRecording(removingFile: true)
            fail(.recordingFailed)
        }
    }

    private func handle(_ event: CameraCaptureEvent) {
        guard !isDiscarded else { return }
        switch event {
        case .recordingFinished(.success):
            guard isRecording || state == .finalizing else { return }
            guard let recordingURL, let recordingStartedAt else {
                fail(.recordingFailed)
                return
            }
            client.stopSession()
            state = .finalizing
            Task {
                await finalizeRecording(
                    url: recordingURL,
                    capturedAt: recordingStartedAt
                )
            }
        case .recordingFinished(.failure(let failure)):
            client.stopSession()
            clearRecording(removingFile: true)
            fail(failure)
        case .interrupted:
            isCaptureInterrupted = true
            if case .recording = state {
                stopRecording()
            } else if state == .configuring {
                state = .interrupted
            } else if state == .ready
                        || state == .confirmingSilentRecording {
                state = .interrupted
            }
        case .interruptionEnded:
            isCaptureInterrupted = false
            if state == .interrupted {
                if isConfigurationInFlight {
                    state = .configuring
                } else {
                    state = .ready
                    if isSceneActive {
                        client.startSession()
                    }
                }
            }
        case .runtimeFailure(let requiresSessionRebuild):
            if case .review = state {
                return
            }
            guard state != .transferred, !isDiscarded else {
                return
            }
            invalidateConfiguration()
            isCaptureInterrupted = false
            needsSessionRebuild = needsSessionRebuild || requiresSessionRebuild
            if isRecording {
                stopRecording()
            } else if state != .finalizing {
                client.stopSession()
                if requiresSessionRebuild {
                    state = .configuring
                    Task {
                        await configure(resetSession: true)
                    }
                } else {
                    fail(.configurationFailed)
                }
            }
        }
    }

    private func finalizeRecording(url: URL, capturedAt: Date) async {
        do {
            let hasAudio = try await client.recordingHasAudio(url)
            guard !isDiscarded, recordingURL == url else { return }
            state = .review(
                CameraCapturedVideo(
                    url: url,
                    capturedAt: capturedAt,
                    hasAudio: hasAudio
                )
            )
            announce(.reviewReady)
        } catch {
            guard !isDiscarded, recordingURL == url else { return }
            clearRecording(removingFile: true)
            fail(.recordingFailed)
        }
    }

    private func clearRecording(removingFile: Bool = false) {
        if removingFile, let recordingURL {
            fileStore.remove(recordingURL)
        }
        recordingURL = nil
        recordingStartedAt = nil
    }

    private func invalidateConfiguration() {
        guard isConfigurationInFlight else { return }
        configurationGeneration &+= 1
        isConfigurationInFlight = false
    }

    private var isRecording: Bool {
        if case .recording = state {
            return true
        }
        return false
    }

    private func fail(_ failure: CameraCaptureFailure) {
        state = .failed(failure)
        announce(.captureFailed)
    }

    private func announce(_ kind: CameraAccessibilityAnnouncementKind) {
        accessibilityAnnouncement = CameraAccessibilityAnnouncement(kind: kind)
    }
}
