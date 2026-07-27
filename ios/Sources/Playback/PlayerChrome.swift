import Foundation

/// Pure visibility state machine for the playback chrome (nav bar + controls).
/// The view layer forwards events and ticks a clock; auto-hide is deadline based.
struct PlayerChrome: Equatable, Sendable {
    static let autoHideDelay: TimeInterval = 3

    private(set) var isVisible: Bool
    private(set) var hideDeadline: Date?

    init(isVisible: Bool = true) {
        self.isVisible = isVisible
    }

    enum Event: Equatable, Sendable {
        case tapped(at: Date, isPlaying: Bool)
        case playbackStarted(at: Date)
        case paused
        case scrubBegan
        case scrubEnded
        case playbackEnded
        case clockTicked(at: Date)
    }

    mutating func apply(_ event: Event) {
        switch event {
        case let .tapped(at, isPlaying):
            isVisible.toggle()
            hideDeadline = isVisible && isPlaying ? at.addingTimeInterval(Self.autoHideDelay) : nil
        case let .playbackStarted(at):
            hideDeadline = isVisible ? at.addingTimeInterval(Self.autoHideDelay) : nil
        case .paused, .scrubBegan, .playbackEnded:
            isVisible = true
            hideDeadline = nil
        case .scrubEnded:
            hideDeadline = nil
        case let .clockTicked(at):
            if let deadline = hideDeadline, at >= deadline {
                isVisible = false
                hideDeadline = nil
            }
        }
    }
}
