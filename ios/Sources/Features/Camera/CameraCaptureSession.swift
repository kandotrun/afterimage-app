@preconcurrency import AVFoundation
import CoreGraphics
import Foundation

final class CameraCaptureSession: NSObject, @unchecked Sendable {
    let session = AVCaptureSession()

    private let queue = DispatchQueue(label: "afterimage.camera.capture")
    private let movieOutput = AVCaptureMovieFileOutput()
    private var videoInput: AVCaptureDeviceInput?
    private var audioInput: AVCaptureDeviceInput?
    private var eventHandler: (@MainActor (CameraCaptureEvent) -> Void)?
    private weak var previewLayer: AVCaptureVideoPreviewLayer?
    private var rotationCoordinator: AVCaptureDevice.RotationCoordinator?
    private var previewRotationObservation: NSKeyValueObservation?
    private var captureRotationObservation: NSKeyValueObservation?
    private var isObservingSession = false
    private var stopsSessionAfterRecording = false

    func configure(
        eventHandler: @escaping @MainActor (CameraCaptureEvent) -> Void
    ) async throws {
        self.eventHandler = eventHandler
        try await withCheckedThrowingContinuation { continuation in
            queue.async {
                do {
                    try self.configureSession()
                    continuation.resume()
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    func startSession() {
        queue.async {
            guard !self.session.isRunning else { return }
            self.session.startRunning()
        }
    }

    func stopSession() {
        queue.async {
            guard self.session.isRunning else { return }
            if self.movieOutput.isRecording {
                self.stopsSessionAfterRecording = true
                self.movieOutput.stopRecording()
            } else {
                self.session.stopRunning()
            }
        }
    }

    func startRecording(to url: URL, hasAudio: Bool) throws {
        try queue.sync {
            guard session.isRunning,
                  !movieOutput.isRecording else {
                throw CameraCaptureFailure.recordingFailed
            }
            if hasAudio {
                try addAudioInput()
            } else {
                removeAudioInput()
            }
            movieOutput.startRecording(to: url, recordingDelegate: self)
        }
    }

    func stopRecording() {
        queue.async {
            guard self.movieOutput.isRecording else { return }
            self.movieOutput.stopRecording()
        }
    }

    func resetSession() async throws {
        try await withCheckedThrowingContinuation {
            (continuation: CheckedContinuation<Void, Error>) in
            queue.async {
                guard !self.movieOutput.isRecording else {
                    continuation.resume(
                        throwing: CameraCaptureFailure.configurationFailed
                    )
                    return
                }
                if self.session.isRunning {
                    self.session.stopRunning()
                }
                self.session.beginConfiguration()
                self.session.inputs.forEach(self.session.removeInput)
                self.session.outputs.forEach(self.session.removeOutput)
                self.session.commitConfiguration()
                self.videoInput = nil
                self.audioInput = nil
                continuation.resume()
            }
        }
    }

    func switchCamera() async throws -> AVCaptureDevice.Position {
        try await withCheckedThrowingContinuation { continuation in
            queue.async {
                do {
                    let position = try self.replaceVideoInput()
                    continuation.resume(returning: position)
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    func focus(at point: CGPoint) {
        queue.async {
            guard let device = self.videoInput?.device else { return }
            do {
                try device.lockForConfiguration()
                defer { device.unlockForConfiguration() }
                if device.isFocusPointOfInterestSupported,
                   device.isFocusModeSupported(.continuousAutoFocus) {
                    device.focusPointOfInterest = point
                    device.focusMode = .continuousAutoFocus
                }
                if device.isExposurePointOfInterestSupported,
                   device.isExposureModeSupported(.continuousAutoExposure) {
                    device.exposurePointOfInterest = point
                    device.exposureMode = .continuousAutoExposure
                }
            } catch {
                return
            }
        }
    }

    func zoom(to factor: CGFloat) {
        queue.async {
            guard let device = self.videoInput?.device else { return }
            do {
                try device.lockForConfiguration()
                defer { device.unlockForConfiguration() }
                let maximum = min(device.activeFormat.videoMaxZoomFactor, 8)
                device.videoZoomFactor = min(max(factor, 1), maximum)
            } catch {
                return
            }
        }
    }

    @MainActor
    func attachPreviewLayer(_ layer: AVCaptureVideoPreviewLayer) {
        previewLayer = layer
        layer.session = session
        layer.videoGravity = .resizeAspectFill
        updateRotationCoordinator()
    }

    private func configureSession() throws {
        guard videoInput == nil else { return }
        guard let device = camera(position: .back) else {
            throw CameraCaptureFailure.cameraUnavailable
        }
        let input: AVCaptureDeviceInput
        do {
            input = try AVCaptureDeviceInput(device: device)
        } catch {
            throw CameraCaptureFailure.configurationFailed
        }

        session.beginConfiguration()
        defer { session.commitConfiguration() }
        session.sessionPreset = .high
        guard session.canAddInput(input),
              session.canAddOutput(movieOutput) else {
            throw CameraCaptureFailure.configurationFailed
        }
        session.addInput(input)
        session.addOutput(movieOutput)
        videoInput = input

        observeSessionIfNeeded()

        Task { @MainActor in
            self.updateRotationCoordinator()
        }
    }

    private func camera(position: AVCaptureDevice.Position) -> AVCaptureDevice? {
        AVCaptureDevice.DiscoverySession(
            deviceTypes: [.builtInWideAngleCamera],
            mediaType: .video,
            position: position
        ).devices.first
    }

    private func observeSessionIfNeeded() {
        guard !isObservingSession else { return }
        isObservingSession = true
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(sessionWasInterrupted(_:)),
            name: AVCaptureSession.wasInterruptedNotification,
            object: session
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(sessionInterruptionEnded(_:)),
            name: AVCaptureSession.interruptionEndedNotification,
            object: session
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(sessionRuntimeError(_:)),
            name: AVCaptureSession.runtimeErrorNotification,
            object: session
        )
    }

    private func addAudioInput() throws {
        guard audioInput == nil else { return }
        guard let device = AVCaptureDevice.default(for: .audio) else {
            throw CameraCaptureFailure.configurationFailed
        }
        let input: AVCaptureDeviceInput
        do {
            input = try AVCaptureDeviceInput(device: device)
        } catch {
            throw CameraCaptureFailure.configurationFailed
        }
        session.beginConfiguration()
        defer { session.commitConfiguration() }
        guard session.canAddInput(input) else {
            throw CameraCaptureFailure.configurationFailed
        }
        session.addInput(input)
        audioInput = input
    }

    private func removeAudioInput() {
        guard let audioInput else { return }
        session.beginConfiguration()
        session.removeInput(audioInput)
        session.commitConfiguration()
        self.audioInput = nil
    }

    private func replaceVideoInput() throws -> AVCaptureDevice.Position {
        guard !movieOutput.isRecording,
              let currentInput = videoInput else {
            throw CameraCaptureFailure.cameraUnavailable
        }
        let nextPosition: AVCaptureDevice.Position = currentInput.device.position == .back
            ? .front
            : .back
        guard let device = camera(position: nextPosition) else {
            throw CameraCaptureFailure.cameraUnavailable
        }
        let nextInput: AVCaptureDeviceInput
        do {
            nextInput = try AVCaptureDeviceInput(device: device)
        } catch {
            throw CameraCaptureFailure.cameraUnavailable
        }

        session.beginConfiguration()
        session.removeInput(currentInput)
        if session.canAddInput(nextInput) {
            session.addInput(nextInput)
            videoInput = nextInput
        } else {
            session.addInput(currentInput)
            session.commitConfiguration()
            throw CameraCaptureFailure.cameraUnavailable
        }
        session.commitConfiguration()

        Task { @MainActor in
            self.updateRotationCoordinator()
        }
        return nextPosition
    }

    @MainActor
    private func updateRotationCoordinator() {
        previewRotationObservation = nil
        captureRotationObservation = nil
        guard let previewLayer,
              let device = queue.sync(execute: { videoInput?.device }) else {
            rotationCoordinator = nil
            return
        }
        let coordinator = AVCaptureDevice.RotationCoordinator(
            device: device,
            previewLayer: previewLayer
        )
        rotationCoordinator = coordinator
        previewRotationObservation = coordinator.observe(
            \.videoRotationAngleForHorizonLevelPreview,
            options: [.initial, .new]
        ) { [weak self] coordinator, _ in
            let angle = coordinator.videoRotationAngleForHorizonLevelPreview
            Task { @MainActor [weak self] in
                guard let connection = self?.previewLayer?.connection,
                      connection.isVideoRotationAngleSupported(angle) else {
                    return
                }
                connection.videoRotationAngle = angle
            }
        }
        captureRotationObservation = coordinator.observe(
            \.videoRotationAngleForHorizonLevelCapture,
            options: [.initial, .new]
        ) { [weak self] coordinator, _ in
            guard let self else { return }
            let angle = coordinator.videoRotationAngleForHorizonLevelCapture
            self.queue.async {
                guard let connection = self.movieOutput.connection(with: .video),
                      connection.isVideoRotationAngleSupported(angle) else {
                    return
                }
                connection.videoRotationAngle = angle
            }
        }
    }

    @objc private func sessionWasInterrupted(_ notification: Notification) {
        emit(.interrupted)
    }

    @objc private func sessionInterruptionEnded(_ notification: Notification) {
        emit(.interruptionEnded)
    }

    @objc private func sessionRuntimeError(_ notification: Notification) {
        let error = notification
            .userInfo?[AVCaptureSessionErrorKey] as? AVError
        emit(
            .runtimeFailure(
                requiresSessionRebuild: error?.code == .mediaServicesWereReset
            )
        )
    }

    private func emit(_ event: CameraCaptureEvent) {
        Task { @MainActor [weak self] in
            self?.eventHandler?(event)
        }
    }

    private func finishDeferredSessionStop() {
        queue.async {
            guard self.stopsSessionAfterRecording else { return }
            self.stopsSessionAfterRecording = false
            if self.session.isRunning {
                self.session.stopRunning()
            }
        }
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }
}

extension CameraCaptureSession: AVCaptureFileOutputRecordingDelegate {
    func fileOutput(
        _ output: AVCaptureFileOutput,
        didFinishRecordingTo outputFileURL: URL,
        from connections: [AVCaptureConnection],
        error: Error?
    ) {
        finishDeferredSessionStop()
        if let error {
            let didFinish = (error as NSError)
                .userInfo[AVErrorRecordingSuccessfullyFinishedKey] as? Bool == true
            let failure: CameraCaptureFailure
            if let avError = error as? AVError,
               avError.code == .diskFull
                || avError.code == .maximumFileSizeReached {
                failure = .insufficientStorage
            } else {
                failure = .recordingFailed
            }
            emit(
                .recordingFinished(
                    didFinish ? .success(()) : .failure(failure)
                )
            )
        } else {
            emit(.recordingFinished(.success(())))
        }
    }
}
