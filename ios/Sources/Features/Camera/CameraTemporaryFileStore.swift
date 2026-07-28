import Foundation

struct CameraTemporaryFileStore: Sendable {
    static let defaultRootDirectory = FileManager.default.temporaryDirectory
        .appendingPathComponent("afterimage-camera", isDirectory: true)

    let directory: URL

    init(
        rootDirectory: URL = defaultRootDirectory,
        sessionID: UUID = UUID()
    ) {
        directory = rootDirectory.standardizedFileURL
            .appendingPathComponent(
                sessionID.uuidString,
                isDirectory: true
            )
    }

    init(directory: URL) {
        self.directory = directory.standardizedFileURL
    }

    func makeRecordingURL() throws -> URL {
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true
        )
        return directory.appendingPathComponent(UUID().uuidString)
            .appendingPathExtension("mov")
    }

    func remove(_ url: URL) {
        let standardizedURL = url.standardizedFileURL
        guard standardizedURL.deletingLastPathComponent() == directory else {
            return
        }
        try? FileManager.default.removeItem(at: standardizedURL)
    }

    func purge() throws {
        guard FileManager.default.fileExists(atPath: directory.path) else {
            return
        }
        try FileManager.default.removeItem(at: directory)
    }

    static func purgeOrphans(
        rootDirectory: URL = defaultRootDirectory
    ) throws {
        let root = rootDirectory.standardizedFileURL
        guard FileManager.default.fileExists(atPath: root.path) else {
            return
        }
        try FileManager.default.removeItem(at: root)
    }
}
