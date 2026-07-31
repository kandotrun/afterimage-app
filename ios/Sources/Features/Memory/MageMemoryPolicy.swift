import Foundation

enum MemorySearchPolicy {
    static func query(from input: String) -> String? {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        return String(trimmed.prefix(200))
    }
}

enum VideoAnalysisPollingPolicy {
    static func shouldPoll(status: VideoAnalysisStatus, isVisible: Bool) -> Bool {
        isVisible && (status == .unavailable || status == .queued || status == .processing)
    }
}

struct MemorySeekRequest: Equatable {
    let assetID: String
    let startMs: Int
}

enum MemorySeekPolicy {
    static func seconds(startMs: Int?, assetID: String, pageAssetID: String) -> TimeInterval? {
        guard assetID == pageAssetID, let startMs else { return nil }
        return TimeInterval(max(0, startMs)) / 1_000
    }
}
