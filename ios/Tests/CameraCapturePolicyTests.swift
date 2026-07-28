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
