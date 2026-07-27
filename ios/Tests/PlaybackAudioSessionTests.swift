import AVFAudio
import XCTest
@testable import afterimage

final class PlaybackAudioSessionTests: XCTestCase {
    @MainActor
    func testActivateUsesMoviePlaybackThatIgnoresTheSilentSwitch() throws {
        let session = AudioSessionSpy()
        let playback = PlaybackAudioSession(session: session)

        try playback.activate()

        XCTAssertEqual(session.category, .playback)
        XCTAssertEqual(session.mode, .moviePlayback)
        XCTAssertEqual(session.categoryOptions, [])
        XCTAssertEqual(session.activations, [true])
    }

    @MainActor
    func testDeactivateNotifiesOtherAudioSessions() {
        let session = AudioSessionSpy()
        let playback = PlaybackAudioSession(session: session)

        playback.deactivate()

        XCTAssertEqual(session.activations, [false])
        XCTAssertEqual(session.lastActiveOptions, [.notifyOthersOnDeactivation])
    }
}

private final class AudioSessionSpy: AudioSessionControlling {
    var category: AVAudioSession.Category?
    var mode: AVAudioSession.Mode?
    var categoryOptions: AVAudioSession.CategoryOptions?
    var activations: [Bool] = []
    var lastActiveOptions: AVAudioSession.SetActiveOptions = []

    func setCategory(
        _ category: AVAudioSession.Category,
        mode: AVAudioSession.Mode,
        options: AVAudioSession.CategoryOptions
    ) throws {
        self.category = category
        self.mode = mode
        categoryOptions = options
    }

    func setActive(_ active: Bool, options: AVAudioSession.SetActiveOptions) throws {
        activations.append(active)
        lastActiveOptions = options
    }
}
