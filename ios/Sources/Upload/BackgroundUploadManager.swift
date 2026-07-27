import Foundation

/// Persistent state for an in-flight background upload batch.
/// Survives app termination so we can resume/complete on relaunch.
struct BackgroundUploadState: Codable, Sendable {
    struct Item: Codable, Sendable {
        let assetID: String
        let filename: String
        let mediaURL: URL
        let thumbnailURL: URL?
        let contentType: String
        let byteSize: Int64
        let plan: UploadPlan
        /// Part numbers that have been confirmed uploaded.
        var completedParts: Set<Int>
        var isComplete: Bool
    }

    var items: [Item]
    var currentIndex: Int

    var currentItem: Item? {
        guard items.indices.contains(currentIndex) else { return nil }
        return items[currentIndex]
    }

    var allComplete: Bool {
        items.allSatisfy(\.isComplete)
    }
}

/// Manages file transfers to R2 via a background URLSession so they continue
/// when the app is suspended or terminated.
///
/// This class only handles the raw file upload to R2 signed URLs.
/// API calls (createAsset, completeUpload, thumbnail) are handled by the caller.
final class BackgroundUploadManager: NSObject, @unchecked Sendable {
    static let shared = BackgroundUploadManager()

    private static let sessionIdentifier = "com.2-38.afterimage.upload"
    private static let stateFileURL: URL = {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("afterimage-uploads", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("state.json")
    }()

    private var backgroundSession: URLSession!
    private var state: BackgroundUploadState?
    private var completionHandler: (() -> Void)?
    private var progressHandler: (@Sendable (String, Double, Int, Int) -> Void)?
    private var finishHandler: (@Sendable (Result<Void, Error>) -> Void)?

    /// Active upload tasks keyed by part number (0 for single upload).
    private var activeTasks: [Int: URLSessionUploadTask] = [:]

    private override init() {
        super.init()
        let config = URLSessionConfiguration.background(withIdentifier: Self.sessionIdentifier)
        config.isDiscretionary = false
        config.sessionSendsLaunchEvents = true
        config.allowsCellularAccess = true
        backgroundSession = URLSession(configuration: config, delegate: self, delegateQueue: nil)
    }

    // MARK: - State persistence

    private func saveState() {
        guard let state else { return }
        if let data = try? JSONEncoder().encode(state) {
            try? data.write(to: Self.stateFileURL, options: .atomic)
        }
    }

    private func loadState() -> BackgroundUploadState? {
        guard let data = try? Data(contentsOf: Self.stateFileURL) else { return nil }
        return try? JSONDecoder().decode(BackgroundUploadState.self, from: data)
    }

    private func clearState() {
        state = nil
        try? FileManager.default.removeItem(at: Self.stateFileURL)
    }

    // MARK: - Public API

    /// Start a background upload batch (R2 file transfers only).
    func startUpload(
        items: [BackgroundUploadState.Item],
        progress: @escaping @Sendable (String, Double, Int, Int) -> Void,
        completion: @escaping @Sendable (Result<Void, Error>) -> Void
    ) {
        state = BackgroundUploadState(items: items, currentIndex: 0)
        progressHandler = progress
        finishHandler = completion
        saveState()
        processCurrentItem()
    }

    /// Called from AppDelegate when the system relaunches the app for background events.
    func handleBackgroundSessionEvents(completionHandler: @escaping () -> Void) {
        self.completionHandler = completionHandler
    }

    /// Resume any interrupted upload on app launch.
    func resumePendingUpload(
        progress: @escaping @Sendable (String, Double, Int, Int) -> Void,
        completion: @escaping @Sendable (Result<Void, Error>) -> Void
    ) {
        guard let saved = loadState(), !saved.allComplete else {
            clearState()
            return
        }
        state = saved
        progressHandler = progress
        finishHandler = completion
        processCurrentItem()
    }

    func cancelAll() {
        for (_, task) in activeTasks {
            task.cancel()
        }
        activeTasks.removeAll()
        clearState()
        finishHandler?(.failure(AfterimageError.cancelled))
        finishHandler = nil
        progressHandler = nil
    }

    // MARK: - Upload orchestration

    private func processCurrentItem() {
        guard let item = state?.currentItem, !item.isComplete else {
            advanceToNextItem()
            return
        }

        let plan = item.plan
        switch plan.mode {
        case .single:
            guard let urlString = plan.url, let url = URL(string: urlString) else {
                failItem(AfterimageError.uploadPlanInvalid)
                return
            }
            var request = URLRequest(url: url)
            request.httpMethod = "PUT"
            request.setValue(item.contentType, forHTTPHeaderField: "Content-Type")
            request.setValue(String(item.byteSize), forHTTPHeaderField: "Content-Length")

            let task = backgroundSession.uploadTask(with: request, fromFile: item.mediaURL)
            task.taskDescription = "single:\(item.assetID)"
            activeTasks[0] = task
            task.resume()

        case .multipart:
            guard let partSize = plan.partSize, partSize > 0 else {
                failItem(AfterimageError.uploadPlanInvalid)
                return
            }
            let chunks = MultipartChunkPlanner.chunks(fileSize: item.byteSize, partSize: partSize)
            let pending = chunks.filter { !item.completedParts.contains($0.partNumber) }

            if pending.isEmpty {
                markItemComplete()
                return
            }

            for chunk in pending {
                guard let chunkURL = writeChunkToFile(chunk, from: item.mediaURL) else {
                    failItem(AfterimageError.compressionFailed("チャンクの書き出しに失敗しました。"))
                    return
                }
                guard let partURLString = try? plan.path(forPart: chunk.partNumber),
                      let partURL = URL(string: partURLString) else {
                    failItem(AfterimageError.uploadPlanInvalid)
                    return
                }
                var request = URLRequest(url: partURL)
                request.httpMethod = "PUT"
                request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
                request.setValue(String(chunk.length), forHTTPHeaderField: "Content-Length")

                let task = backgroundSession.uploadTask(with: request, fromFile: chunkURL)
                task.taskDescription = "part:\(item.assetID):\(chunk.partNumber):\(chunkURL.lastPathComponent)"
                activeTasks[chunk.partNumber] = task
                task.resume()
            }
        }
    }

    private func writeChunkToFile(_ chunk: MultipartChunk, from sourceURL: URL) -> URL? {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("afterimage-chunks", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let chunkURL = dir.appendingPathComponent("chunk-\(chunk.partNumber).bin")

        guard let handle = try? FileHandle(forReadingFrom: sourceURL) else { return nil }
        defer { try? handle.close() }
        try? handle.seek(toOffset: UInt64(chunk.offset))
        guard let data = try? handle.read(upToCount: chunk.length), data.count == chunk.length else { return nil }
        do {
            try data.write(to: chunkURL, options: .atomic)
            return chunkURL
        } catch {
            return nil
        }
    }

    private func markItemComplete() {
        guard var s = state, var item = s.currentItem else { return }
        item.isComplete = true
        s.items[s.currentIndex] = item
        state = s
        saveState()
        advanceToNextItem()
    }

    private func advanceToNextItem() {
        guard var s = state else { return }
        s.currentIndex += 1
        state = s
        saveState()

        if s.currentIndex >= s.items.count {
            clearState()
            finishHandler?(.success(()))
            finishHandler = nil
            progressHandler = nil
        } else {
            processCurrentItem()
        }
    }

    private func failItem(_ error: Error) {
        activeTasks.removeAll()
        clearState()
        finishHandler?(.failure(error))
        finishHandler = nil
        progressHandler = nil
    }

    private func reportProgress() {
        guard let s = state, let item = s.currentItem else { return }
        let totalParts: Int
        let doneParts: Int

        switch item.plan.mode {
        case .single:
            totalParts = 1
            doneParts = activeTasks.isEmpty ? 1 : 0
        case .multipart:
            let chunks = MultipartChunkPlanner.chunks(
                fileSize: item.byteSize,
                partSize: item.plan.partSize ?? 1
            )
            totalParts = chunks.count
            doneParts = item.completedParts.count
        }

        let itemProgress = totalParts > 0 ? Double(doneParts) / Double(totalParts) : 0
        let batchProgress = (Double(s.currentIndex) + itemProgress) / Double(max(s.items.count, 1))
        progressHandler?(item.filename, batchProgress, s.currentIndex + 1, s.items.count)
    }
}

// MARK: - URLSessionDelegate

extension BackgroundUploadManager: URLSessionTaskDelegate, URLSessionDataDelegate {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didSendBodyData bytesSent: Int64,
        totalBytesSent: Int64,
        totalBytesExpectedToSend: Int64
    ) {
        reportProgress()
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let description = task.taskDescription else { return }
        let parts = description.split(separator: ":", maxSplits: 3).map(String.init)

        if let error {
            if (error as NSError).code == NSURLErrorCancelled { return }
            failItem(error)
            return
        }

        switch parts.first {
        case "single":
            activeTasks.removeValue(forKey: 0)
            markItemComplete()

        case "part":
            guard parts.count >= 3, let partNumber = Int(parts[2]) else { return }
            activeTasks.removeValue(forKey: partNumber)

            // Clean up chunk temp file.
            if parts.count >= 4 {
                let chunkURL = FileManager.default.temporaryDirectory
                    .appendingPathComponent("afterimage-chunks")
                    .appendingPathComponent(parts[3])
                try? FileManager.default.removeItem(at: chunkURL)
            }

            // Mark part complete.
            if var s = state, var item = s.currentItem {
                item.completedParts.insert(partNumber)
                s.items[s.currentIndex] = item
                state = s
                saveState()
                reportProgress()

                let totalChunks = MultipartChunkPlanner.chunks(
                    fileSize: item.byteSize,
                    partSize: item.plan.partSize ?? 1
                ).count
                if item.completedParts.count >= totalChunks {
                    markItemComplete()
                }
            }

        default:
            break
        }
    }

    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        DispatchQueue.main.async { [weak self] in
            self?.completionHandler?()
            self?.completionHandler = nil
        }
    }
}
