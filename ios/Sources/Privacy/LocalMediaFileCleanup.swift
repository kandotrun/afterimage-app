import Foundation

enum LocalMediaFileCleanup {
    static func purge(fileManager: FileManager = .default) throws {
        try purge(
            rootDirectory: fileManager.temporaryDirectory,
            fileManager: fileManager
        )
    }

    static func purge(
        rootDirectory: URL,
        fileManager: FileManager = .default
    ) throws {
        for name in [
            "afterimage-camera",
            "afterimage-imports",
            "afterimage-optimized",
        ] {
            let directory = rootDirectory.appendingPathComponent(
                name,
                isDirectory: true
            )
            if fileManager.fileExists(atPath: directory.path) {
                try fileManager.removeItem(at: directory)
            }
        }
    }
}
