import XCTest
@testable import afterimage

final class PlayerChromeTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1_000)

    func testTapToggles() {
        var chrome = PlayerChrome()
        chrome.apply(.tapped(at: t0, isPlaying: false))
        XCTAssertFalse(chrome.isVisible)
        chrome.apply(.tapped(at: t0, isPlaying: false))
        XCTAssertTrue(chrome.isVisible)
        XCTAssertNil(chrome.hideDeadline)
    }

    func testAutoHidesAfterDelayWhilePlaying() {
        var chrome = PlayerChrome()
        chrome.apply(.playbackStarted(at: t0))
        chrome.apply(.clockTicked(at: t0.addingTimeInterval(1)))
        XCTAssertTrue(chrome.isVisible)
        chrome.apply(.clockTicked(at: t0.addingTimeInterval(PlayerChrome.autoHideDelay)))
        XCTAssertFalse(chrome.isVisible)
    }

    func testPauseShowsAndDisarms() {
        var chrome = PlayerChrome()
        chrome.apply(.playbackStarted(at: t0))
        chrome.apply(.clockTicked(at: t0.addingTimeInterval(5)))
        XCTAssertFalse(chrome.isVisible)
        chrome.apply(.tapped(at: t0.addingTimeInterval(6), isPlaying: true))
        XCTAssertTrue(chrome.isVisible)
        chrome.apply(.paused)
        XCTAssertNil(chrome.hideDeadline)
        chrome.apply(.clockTicked(at: t0.addingTimeInterval(60)))
        XCTAssertTrue(chrome.isVisible)
    }

    func testScrubKeepsChromeUntilPlaybackResumes() {
        var chrome = PlayerChrome()
        chrome.apply(.playbackStarted(at: t0))
        chrome.apply(.scrubBegan)
        chrome.apply(.clockTicked(at: t0.addingTimeInterval(60)))
        XCTAssertTrue(chrome.isVisible)
        chrome.apply(.scrubEnded)
        chrome.apply(.clockTicked(at: t0.addingTimeInterval(120)))
        XCTAssertTrue(chrome.isVisible)
        chrome.apply(.playbackStarted(at: t0.addingTimeInterval(120)))
        chrome.apply(.clockTicked(at: t0.addingTimeInterval(123)))
        XCTAssertFalse(chrome.isVisible)
    }

    func testPlaybackEndedShowsChrome() {
        var chrome = PlayerChrome()
        chrome.apply(.playbackStarted(at: t0))
        chrome.apply(.clockTicked(at: t0.addingTimeInterval(10)))
        XCTAssertFalse(chrome.isVisible)
        chrome.apply(.playbackEnded)
        XCTAssertTrue(chrome.isVisible)
        XCTAssertNil(chrome.hideDeadline)
    }

    func testTappedWhileHiddenDuringPlaybackRearmsAutoHide() {
        var chrome = PlayerChrome()
        chrome.apply(.playbackStarted(at: t0))
        chrome.apply(.clockTicked(at: t0.addingTimeInterval(3)))
        XCTAssertFalse(chrome.isVisible)
        chrome.apply(.tapped(at: t0.addingTimeInterval(4), isPlaying: true))
        XCTAssertTrue(chrome.isVisible)
        chrome.apply(.clockTicked(at: t0.addingTimeInterval(7)))
        XCTAssertFalse(chrome.isVisible)
    }
}
