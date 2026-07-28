@preconcurrency import AVFoundation
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
    case insufficientStorage
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
    case runtimeFailure(requiresSessionRebuild: Bool)
}

enum CameraAccessibilityAnnouncementKind: Equatable, Sendable {
    case recordingStarted
    case silentRecordingStarted
    case recordingStopped
    case captureFailed
    case reviewReady
}

struct CameraAccessibilityAnnouncement: Equatable, Sendable {
    let id = UUID()
    let kind: CameraAccessibilityAnnouncementKind
}

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
    let recordingHasAudio: (URL) async throws -> Bool
    let resetSession: () async throws -> Void
    let switchCamera: () async throws -> AVCaptureDevice.Position
    let focus: (CGPoint) -> Void
    let zoom: (CGFloat) -> Void
    let attachPreviewLayer: (AVCaptureVideoPreviewLayer) -> Void
}
