import Foundation
import XCTest
@testable import afterimage

@MainActor
private final class HapticPlayerSpy: HapticPlaying {
    private(set) var cues: [HapticCue] = []

    func play(_ cue: HapticCue) {
        cues.append(cue)
    }
}

final class HapticCueTests: XCTestCase {
    func testSuccessCueHasAConfirmingDoublePulse() {
        let events = HapticCue.success.events
        XCTAssertEqual(events.count, 2)
        XCTAssertLessThan(events[0].relativeTime, events[1].relativeTime)
        XCTAssertGreaterThan(events[1].intensity, events[0].intensity)
    }

    func testProgressCueStaysSubtle() {
        let event = HapticCue.progress.events.first
        XCTAssertNotNil(event)
        XCTAssertLessThanOrEqual(event?.intensity ?? 1, 0.25)
    }

    func testFailureCueDiffersFromSuccess() {
        XCTAssertNotEqual(HapticCue.failure.events, HapticCue.success.events)
    }

    func testFocusCueIsLighterAndSharperThanSelection() throws {
        let focus = try XCTUnwrap(HapticCue.focus.events.first)
        let selection = try XCTUnwrap(HapticCue.selection.events.first)

        XCTAssertLessThan(focus.intensity, selection.intensity)
        XCTAssertGreaterThan(focus.sharpness, selection.sharpness)
    }

    func testRecordingStartBuildsIntensity() {
        let events = HapticCue.recordStart.events

        XCTAssertGreaterThanOrEqual(events.count, 2)
        XCTAssertLessThan(events[0].intensity, events[1].intensity)
    }

    func testRecordingStopReleasesIntensity() {
        let events = HapticCue.recordStop.events

        XCTAssertGreaterThanOrEqual(events.count, 2)
        XCTAssertGreaterThan(events[0].intensity, events[1].intensity)
    }

    func testCopyCueConfirmsWithoutMatchingUploadSuccess() {
        XCTAssertGreaterThanOrEqual(HapticCue.copy.events.count, 2)
        XCTAssertNotEqual(HapticCue.copy.events, HapticCue.success.events)
    }

    func testWarningCueDiffersFromFailure() {
        XCTAssertNotEqual(HapticCue.warning.events, HapticCue.failure.events)
    }

    func testEveryCueProducesAValidPattern() {
        let cues: [HapticCue] = [
            .selection,
            .lift,
            .progress,
            .focus,
            .recordStart,
            .recordStop,
            .copy,
            .warning,
            .success,
            .failure,
            .delete,
        ]

        for cue in cues {
            let events = cue.events
            XCTAssertFalse(events.isEmpty, "\(cue) must contain at least one event")
            XCTAssertEqual(events.map(\.relativeTime), events.map(\.relativeTime).sorted())

            for event in events {
                XCTAssertTrue((0...1).contains(event.intensity))
                XCTAssertTrue((0...1).contains(event.sharpness))
                XCTAssertGreaterThanOrEqual(event.relativeTime, 0)
                if event.kind == .continuous {
                    XCTAssertGreaterThan(event.duration, 0)
                }
            }
        }
    }

    func testCameraAnnouncementsMapToOutcomeSpecificCues() {
        XCTAssertEqual(CameraHapticPolicy.cue(for: .recordingStarted), .recordStart)
        XCTAssertEqual(CameraHapticPolicy.cue(for: .silentRecordingStarted), .recordStart)
        XCTAssertEqual(CameraHapticPolicy.cue(for: .recordingStopped), .recordStop)
        XCTAssertEqual(CameraHapticPolicy.cue(for: .captureFailed), .failure)
        XCTAssertEqual(CameraHapticPolicy.cue(for: .reviewReady), .success)
    }

    func testDiscardingCaptureSuppressesIntermediateCaptureCues() {
        let kinds: [CameraAccessibilityAnnouncementKind] = [
            .recordingStarted,
            .silentRecordingStarted,
            .recordingStopped,
            .captureFailed,
            .reviewReady,
        ]
        for kind in kinds {
            XCTAssertNil(CameraHapticPolicy.cue(for: kind, isDiscarding: true))
        }
    }

    @MainActor
    func testAppModelRoutesFeatureCuesThroughItsInjectedPlayer() {
        let player = HapticPlayerSpy()
        let model = AppModel(
            api: APIClient(baseURL: URL(string: "https://example.test")!),
            haptics: player
        )

        model.playHaptic(.copy)

        XCTAssertEqual(player.cues, [.copy])
    }
}
