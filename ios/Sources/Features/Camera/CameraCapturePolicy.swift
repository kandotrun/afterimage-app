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

enum CameraScenePhaseChange: Equatable, Sendable {
    case active
    case inactive
    case background
}

enum CameraSceneChangeAction: Equatable, Sendable {
    case resume
    case ignore
    case suspend
}

enum CameraCapturePolicy {
    static func startAction(cameraPermission: CameraPermission) -> CameraStartAction {
        switch cameraPermission {
        case .notDetermined:
            .requestPermission
        case .authorized:
            .configure
        case .denied:
            .showSettings
        }
    }

    static func microphoneAction(
        permission: CameraPermission,
        silentRecordingConfirmed: Bool
    ) -> CameraMicrophoneAction {
        switch permission {
        case .notDetermined:
            .requestPermission
        case .authorized:
            .recordWithAudio
        case .denied where silentRecordingConfirmed:
            .recordWithoutAudio
        case .denied:
            .confirmSilentRecording
        }
    }

    /// `.inactive` covers Control Center, the notification shade, and incoming-call
    /// banners — moments where the system camera keeps recording, so we must too.
    /// Only a real `.background` transition suspends capture.
    static func sceneChangeAction(for change: CameraScenePhaseChange) -> CameraSceneChangeAction {
        switch change {
        case .active: .resume
        case .inactive: .ignore
        case .background: .suspend
        }
    }

    static func backgroundAction(phase: CameraCapturePhase) -> CameraBackgroundAction {
        switch phase {
        case .recording:
            .stopRecording
        case .finalizing:
            .waitForFinalization
        default:
            .stopSession
        }
    }

    static func allowsCameraSwitch(phase: CameraCapturePhase) -> Bool {
        phase == .ready
    }
}
