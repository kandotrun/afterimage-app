import XCTest
@testable import afterimage

final class ImportIdentityTests: XCTestCase {
    func testBuildsStablePrivateFingerprintAndLegacyCompatibleFilename() {
        let identity = ImportIdentity(
            localIdentifier: "ABCDEF12-3456-7890-ABCD-EF1234567890/L0/001",
            kind: .video
        )

        XCTAssertEqual(
            identity.sourceFingerprint,
            "257c7bf69ec1e7efd02131cd0cf6991c1453b83f3801ffc96c658181e130f6b2"
        )
        XCTAssertEqual(identity.filename, "ABCDEF12-3456-7890-ABCD-EF1234567890-L0-001.mov")
    }

    func testDifferentIdentifiersRemainDistinctWhenTheirFilenamesSanitizeTheSame() {
        let slash = ImportIdentity(localIdentifier: "A/B", kind: .video)
        let dash = ImportIdentity(localIdentifier: "A-B", kind: .video)

        XCTAssertEqual(slash.filename, dash.filename)
        XCTAssertNotEqual(slash.sourceFingerprint, dash.sourceFingerprint)
    }

    func testSelectionPlanSkipsExistingItemsButKeepsUnknownIdentifiers() {
        let uploaded = ImportIdentity(localIdentifier: "UPLOADED/L0/001", kind: .video)
        let new = ImportIdentity(localIdentifier: "NEW/L0/001", kind: .video)
        let identities: [ImportIdentity?] = [uploaded, nil, new]

        let plan = ImportSelectionPolicy.plan(
            identities: identities,
            existing: [uploaded.sourceFingerprint]
        )

        XCTAssertEqual(plan.uploadIndexes, [1, 2])
        XCTAssertEqual(plan.skippedCount, 1)
    }

    func testLookupCandidatesPreserveFirstSeenOrderAndRemoveDuplicates() {
        let first = ImportIdentity(localIdentifier: "FIRST/L0/001", kind: .video)
        let second = ImportIdentity(localIdentifier: "SECOND/L0/001", kind: .image)

        let candidates = ImportSelectionPolicy.candidates(
            from: [first, first, nil, second]
        )

        XCTAssertEqual(
            candidates.map(\.sourceFingerprint),
            [first.sourceFingerprint, second.sourceFingerprint]
        )
    }

    func testAllExistingSelectionProducesNoUploadIndexes() {
        let first = ImportIdentity(localIdentifier: "FIRST/L0/001", kind: .video)
        let second = ImportIdentity(localIdentifier: "SECOND/L0/001", kind: .video)

        let plan = ImportSelectionPolicy.plan(
            identities: [first, second],
            existing: [first.sourceFingerprint, second.sourceFingerprint]
        )

        XCTAssertTrue(plan.uploadIndexes.isEmpty)
        XCTAssertEqual(plan.skippedCount, 2)
        XCTAssertEqual(
            ImportSelectionSummary(selectedCount: 2, skippedCount: 2).uploadCount,
            0
        )
    }
}
