import XCTest
@testable import afterimage

final class AccountDeletionPolicyTests: XCTestCase {
    func testBackendFailureKeepsSessionAvailableForRetry() {
        let state = AccountDeletionPolicy.reduce(
            .deleting,
            event: .backendFailed("temporary")
        )

        XCTAssertEqual(state, .backendFailed("temporary"))
        XCTAssertTrue(state.keepsAuthenticatedSession)
        XCTAssertTrue(state.canRetry)
    }

    func testAcceptedDeletionNeverReturnsToAuthenticatedReadyDuringCleanup() {
        let cleaning = AccountDeletionPolicy.reduce(
            .deleting,
            event: .backendAccepted
        )
        let failed = AccountDeletionPolicy.reduce(
            cleaning,
            event: .localCleanupFailed
        )

        XCTAssertEqual(cleaning, .cleaningLocalData)
        XCTAssertEqual(failed, .localCleanupFailed)
        XCTAssertFalse(cleaning.keepsAuthenticatedSession)
        XCTAssertFalse(failed.keepsAuthenticatedSession)
        XCTAssertTrue(failed.canRetry)
    }

    func testSuccessfulLocalCleanupFinishesAcceptedDeletion() {
        let state = AccountDeletionPolicy.reduce(
            .cleaningLocalData,
            event: .localCleanupSucceeded
        )

        XCTAssertEqual(state, .completed)
        XCTAssertFalse(state.keepsAuthenticatedSession)
        XCTAssertFalse(state.canRetry)
    }

    func testReauthenticationRequestKeepsAccountBoundUntilAppleCompletes() {
        let state = AccountDeletionPolicy.reduce(
            .deleting,
            event: .reauthenticationRequired
        )

        XCTAssertEqual(state, .reauthenticationRequired)
        XCTAssertTrue(state.keepsAuthenticatedSession)
    }
}

final class AccountDeletionCleanupStoreTests: XCTestCase {
    func testPendingGenerationPersistsWithoutSessionOrAccountData() throws {
        let suiteName = "AccountDeletionCleanupStoreTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let store = AccountDeletionCleanupStore(defaults: defaults)
        let generationID = UUID()

        store.markPending(generationID: generationID)

        XCTAssertEqual(store.pendingGenerationID, generationID)
        XCTAssertEqual(
            defaults.string(forKey: "account-deletion.pending-generation"),
            generationID.uuidString
        )

        store.clear()

        XCTAssertNil(store.pendingGenerationID)
    }
}

final class LocalMediaFileCleanupTests: XCTestCase {
    func testPurgeRemovesOwnedTemporaryDirectoriesOnly() throws {
        let fileManager = FileManager.default
        let root = fileManager.temporaryDirectory.appendingPathComponent(
            "LocalMediaFileCleanupTests.\(UUID().uuidString)",
            isDirectory: true
        )
        defer { try? fileManager.removeItem(at: root) }
        try fileManager.createDirectory(
            at: root,
            withIntermediateDirectories: true
        )
        let ownedDirectories = [
            "afterimage-camera",
            "afterimage-imports",
            "afterimage-optimized",
        ].map {
            root.appendingPathComponent($0, isDirectory: true)
        }
        for directory in ownedDirectories {
            try fileManager.createDirectory(
                at: directory,
                withIntermediateDirectories: true
            )
        }
        let unrelated = root.appendingPathComponent(
            "unrelated",
            isDirectory: true
        )
        try fileManager.createDirectory(
            at: unrelated,
            withIntermediateDirectories: true
        )

        try LocalMediaFileCleanup.purge(
            rootDirectory: root,
            fileManager: fileManager
        )

        for directory in ownedDirectories {
            XCTAssertFalse(
                fileManager.fileExists(atPath: directory.path)
            )
        }
        XCTAssertTrue(fileManager.fileExists(atPath: unrelated.path))
    }
}
