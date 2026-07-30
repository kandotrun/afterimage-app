import Foundation

protocol AccountDeletionCleanupStoring: Sendable {
    var pendingGenerationID: UUID? { get }
    func markPending(generationID: UUID)
    func clear()
}

final class AccountDeletionCleanupStore: AccountDeletionCleanupStoring, @unchecked Sendable {
    private static let key = "account-deletion.pending-generation"
    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    var pendingGenerationID: UUID? {
        defaults.string(forKey: Self.key).flatMap(UUID.init(uuidString:))
    }

    func markPending(generationID: UUID) {
        defaults.set(generationID.uuidString, forKey: Self.key)
    }

    func clear() {
        defaults.removeObject(forKey: Self.key)
    }
}
