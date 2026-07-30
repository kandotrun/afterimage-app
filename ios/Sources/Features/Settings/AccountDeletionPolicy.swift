enum AccountDeletionState: Equatable {
    case idle
    case deleting
    case reauthenticationRequired
    case backendFailed(String)
    case cleaningLocalData
    case localCleanupFailed
    case completed

    var keepsAuthenticatedSession: Bool {
        switch self {
        case .idle, .deleting, .reauthenticationRequired, .backendFailed:
            true
        case .cleaningLocalData, .localCleanupFailed, .completed:
            false
        }
    }

    var canRetry: Bool {
        switch self {
        case .backendFailed, .localCleanupFailed:
            true
        case .idle, .deleting, .reauthenticationRequired, .cleaningLocalData, .completed:
            false
        }
    }
}

enum AccountDeletionEvent: Equatable {
    case backendAccepted
    case backendFailed(String)
    case reauthenticationRequired
    case localCleanupSucceeded
    case localCleanupFailed
}

enum AccountDeletionPolicy {
    static func reduce(
        _ state: AccountDeletionState,
        event: AccountDeletionEvent
    ) -> AccountDeletionState {
        switch (state, event) {
        case (.deleting, .backendAccepted):
            .cleaningLocalData
        case (.deleting, .backendFailed(let message)):
            .backendFailed(message)
        case (.deleting, .reauthenticationRequired):
            .reauthenticationRequired
        case (.cleaningLocalData, .localCleanupSucceeded),
             (.localCleanupFailed, .localCleanupSucceeded):
            .completed
        case (.cleaningLocalData, .localCleanupFailed),
             (.localCleanupFailed, .localCleanupFailed):
            .localCleanupFailed
        default:
            state
        }
    }
}
