import XCTest
@testable import afterimage

final class CameraTemporaryFileStoreTests: XCTestCase {
    func testDefaultSessionsDoNotDeleteFilesOwnedByAnotherSession() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let first = CameraTemporaryFileStore(
            rootDirectory: root,
            sessionID: UUID()
        )
        let second = CameraTemporaryFileStore(
            rootDirectory: root,
            sessionID: UUID()
        )
        let acceptedRecording = try first.makeRecordingURL()
        FileManager.default.createFile(
            atPath: acceptedRecording.path,
            contents: Data("video".utf8)
        )

        try second.purge()

        XCTAssertTrue(
            FileManager.default.fileExists(atPath: acceptedRecording.path)
        )
        try FileManager.default.removeItem(at: root)
    }

    func testRecordingURLIsUniqueMovInsideOwnedDirectory() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let store = CameraTemporaryFileStore(directory: root)

        let first = try store.makeRecordingURL()
        let second = try store.makeRecordingURL()

        XCTAssertEqual(first.deletingLastPathComponent(), root)
        XCTAssertEqual(first.pathExtension, "mov")
        XCTAssertNotEqual(first, second)
    }

    func testPurgeRemovesOnlyFilesInsideOwnedDirectory() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        let outside = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
        let store = CameraTemporaryFileStore(directory: root)
        let recording = try store.makeRecordingURL()
        FileManager.default.createFile(
            atPath: recording.path,
            contents: Data("video".utf8)
        )
        FileManager.default.createFile(
            atPath: outside.path,
            contents: Data("keep".utf8)
        )

        try store.purge()

        XCTAssertFalse(FileManager.default.fileExists(atPath: recording.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: outside.path))
        try FileManager.default.removeItem(at: outside)
    }
}
