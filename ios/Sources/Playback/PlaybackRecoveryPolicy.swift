import Foundation

/// Pure decisions for the playback-grant lifecycle: reuse vs refresh before
/// playing, and whether an item failure deserves one silent re-grant.
struct PlaybackRecoveryPolicy: Equatable, Sendable {
    var safetyMargin: TimeInterval = 10
    var maxFailureRetries = 1

    enum GrantAction: Equatable, Sendable { case reuse, refresh }
    enum FailureAction: Equatable, Sendable { case refresh, surface }

    func grantAction(now: Date, expiresAt: Date?) -> GrantAction {
        guard let expiresAt else { return .refresh }
        return now.addingTimeInterval(safetyMargin) < expiresAt ? .reuse : .refresh
    }

    func failureAction(retriesUsed: Int) -> FailureAction {
        retriesUsed < maxFailureRetries ? .refresh : .surface
    }
}
