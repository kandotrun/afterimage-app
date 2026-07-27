import Foundation

struct BackgroundUploadContext: Sendable {
    let baseURL: URL
    let bearerToken: String
}

/// Persistent, secret-free state for an in-flight background upload.
/// The bearer session remains in Keychain and is never written here.
struct BackgroundUploadState: Codable, Sendable {
    struct Item: Codable, Sendable {
        let assetID: String
        let filename: String
        let mediaURL: URL
        let thumbnailURL: URL?
        let contentType: String
        let byteSize: Int64
        let plan: UploadPlan
        var completedParts: Set<Int>
        var transferComplete: Bool
    }

    let baseURL: URL
    let activityID: String?
    var items: [Item]
    var currentIndex: Int

    var currentItem: Item? {
        guard items.indices.contains(currentIndex) else { return nil }
        return items[currentIndex]
    }

    var allComplete: Bool {
        currentIndex >= items.count
    }
}

enum BackgroundUploadRequestFactory {
    static func make(
        path: String,
        baseURL: URL,
        bearerToken: String,
        contentType: String,
        contentLength: Int64,
        additionalHeaders: [String: String]
    ) throws -> URLRequest {
        let resolver = APIPathResolver(baseURL: baseURL)
        let url = try resolver.resolve(path)
        var request = URLRequest(url: url)
        request.httpMethod = "PUT"
        for (name, value) in additionalHeaders {
            request.setValue(value, forHTTPHeaderField: name)
        }
        request.setValue(contentType, forHTTPHeaderField: "Content-Type")
        request.setValue(String(contentLength), forHTTPHeaderField: "Content-Length")
        if resolver.isAPIOrigin(url) {
            request.setValue("Bearer \(bearerToken)", forHTTPHeaderField: "Authorization")
        }
        return request
    }
}

/// Transfers optimized media with a background URLSession, then finalizes the
/// asset through the authenticated API. State and staged files survive process
/// termination; URLSession reconnects the delegate on relaunch.
final class BackgroundUploadManager: NSObject, @unchecked Sendable {
    private final class SystemCompletionBox: @unchecked Sendable {
        let handler: () -> Void
        init(_ handler: @escaping () -> Void) { self.handler = handler }
    }

    static let shared = BackgroundUploadManager()

    private static let sessionIdentifier = "com.2-38.afterimage.upload"
    private static let maximumConcurrentParts = 3
    private static let storageDirectory: URL = {
        let root = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("afterimage-uploads", isDirectory: true)
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return root
    }()
    private static let stateFileURL = storageDirectory.appendingPathComponent("state.json")

    private let lock = NSRecursiveLock()
    private var backgroundSession: URLSession!
    private var state: BackgroundUploadState?
    private var bearerToken: String?
    private var progressHandler: (@Sendable (String, Double, Int, Int) -> Void)?
    private var finishHandler: (@Sendable (Result<Void, Error>) -> Void)?
    private var systemCompletionHandler: SystemCompletionBox?
    private var backgroundEventsFinished = false
    private var isScheduling = false
    private var isFinalizing = false
    private var sentBytesByTask: [Int: Int64] = [:]

    private override init() {
        super.init()
        state = Self.loadStateFromDisk()
        let delegateQueue = OperationQueue()
        delegateQueue.name = "com.2-38.afterimage.upload.delegate"
        delegateQueue.maxConcurrentOperationCount = 1
        let configuration = URLSessionConfiguration.background(withIdentifier: Self.sessionIdentifier)
        configuration.isDiscretionary = false
        configuration.sessionSendsLaunchEvents = true
        configuration.allowsCellularAccess = true
        backgroundSession = URLSession(configuration: configuration, delegate: self, delegateQueue: delegateQueue)
    }

    var hasPendingUpload: Bool {
        lock.withLock { state != nil }
    }

    // MARK: - Public API

    func startUpload(
        items: [BackgroundUploadState.Item],
        context: BackgroundUploadContext,
        activityID: String?,
        progress: @escaping @Sendable (String, Double, Int, Int) -> Void,
        completion: @escaping @Sendable (Result<Void, Error>) -> Void
    ) throws {
        guard lock.withLock({ state == nil }) else {
            throw AfterimageError.uploadPlanInvalid
        }
        let stagedItems = try stage(items)
        lock.withLock {
            state = BackgroundUploadState(
                baseURL: context.baseURL,
                activityID: activityID,
                items: stagedItems,
                currentIndex: 0
            )
            bearerToken = context.bearerToken
            progressHandler = progress
            finishHandler = completion
            saveStateLocked()
        }
        processCurrentItem()
    }

    /// Reattaches UI callbacks and resumes a transfer/finalization persisted by
    /// a previous process. Existing URLSession tasks are inspected before any
    /// new task is created, preventing duplicate uploads.
    @discardableResult
    func resumePendingUpload(
        context: BackgroundUploadContext? = nil,
        progress: (@Sendable (String, Double, Int, Int) -> Void)? = nil,
        completion: (@Sendable (Result<Void, Error>) -> Void)? = nil
    ) -> Bool {
        let pending = lock.withLock { () -> Bool in
            guard state != nil else { return false }
            if let context {
                bearerToken = context.bearerToken
            }
            if let progress { progressHandler = progress }
            if let completion { finishHandler = completion }
            return true
        }
        if pending { processCurrentItem() }
        return pending
    }

    func handleBackgroundSessionEvents(completionHandler: @escaping () -> Void) {
        lock.withLock {
            systemCompletionHandler = SystemCompletionBox(completionHandler)
            backgroundEventsFinished = false
        }
        _ = resumePendingUpload()
    }

    func cancelAll() {
        backgroundSession.getAllTasks { [weak self] tasks in
            tasks.forEach { $0.cancel() }
            self?.finishCancellation()
        }
    }

    // MARK: - Persistence and staging

    private static func loadStateFromDisk() -> BackgroundUploadState? {
        guard let data = try? Data(contentsOf: stateFileURL) else { return nil }
        return try? JSONDecoder().decode(BackgroundUploadState.self, from: data)
    }

    private func saveStateLocked() {
        guard let state, let data = try? JSONEncoder().encode(state) else { return }
        try? data.write(to: Self.stateFileURL, options: .atomic)
    }

    private func clearStateLocked() {
        state = nil
        try? FileManager.default.removeItem(at: Self.stateFileURL)
    }

    private func stage(_ items: [BackgroundUploadState.Item]) throws -> [BackgroundUploadState.Item] {
        var staged: [BackgroundUploadState.Item] = []
        do {
            for item in items {
                let directory = Self.storageDirectory
                    .appendingPathComponent(item.assetID, isDirectory: true)
                try? FileManager.default.removeItem(at: directory)
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

                let mediaExtension = item.mediaURL.pathExtension.isEmpty ? "media" : item.mediaURL.pathExtension
                let stagedMedia = directory.appendingPathComponent("media").appendingPathExtension(mediaExtension)
                try moveOwnedFile(from: item.mediaURL, to: stagedMedia)

                let stagedThumbnail: URL?
                if let thumbnailURL = item.thumbnailURL {
                    let thumbnailExtension = thumbnailURL.pathExtension.isEmpty ? "jpg" : thumbnailURL.pathExtension
                    let destination = directory.appendingPathComponent("thumbnail").appendingPathExtension(thumbnailExtension)
                    try moveOwnedFile(from: thumbnailURL, to: destination)
                    stagedThumbnail = destination
                } else {
                    stagedThumbnail = nil
                }

                staged.append(BackgroundUploadState.Item(
                    assetID: item.assetID,
                    filename: item.filename,
                    mediaURL: stagedMedia,
                    thumbnailURL: stagedThumbnail,
                    contentType: item.contentType,
                    byteSize: item.byteSize,
                    plan: item.plan,
                    completedParts: item.completedParts,
                    transferComplete: item.transferComplete
                ))
            }
            return staged
        } catch {
            for item in items {
                let directory = Self.storageDirectory
                    .appendingPathComponent(item.assetID, isDirectory: true)
                try? FileManager.default.removeItem(at: directory)
            }
            throw error
        }
    }

    private func moveOwnedFile(from source: URL, to destination: URL) throws {
        do {
            try FileManager.default.moveItem(at: source, to: destination)
        } catch {
            try FileManager.default.copyItem(at: source, to: destination)
            try? FileManager.default.removeItem(at: source)
        }
    }

    private func removeStagedFiles(for item: BackgroundUploadState.Item) {
        try? FileManager.default.removeItem(at: item.mediaURL.deletingLastPathComponent())
    }

    // MARK: - Orchestration

    private func processCurrentItem() {
        let transferComplete = lock.withLock { state?.currentItem?.transferComplete }
        guard let transferComplete else {
            finishSuccessIfNeeded()
            return
        }
        if transferComplete {
            finalizeCurrentItem()
        } else {
            scheduleCurrentTransfers()
        }
    }

    private func scheduleCurrentTransfers() {
        let shouldInspect = lock.withLock { () -> Bool in
            guard state?.currentItem != nil, !isScheduling else { return false }
            isScheduling = true
            return true
        }
        guard shouldInspect else { return }

        backgroundSession.getAllTasks { [weak self] tasks in
            self?.scheduleAfterInspecting(tasks)
        }
    }

    private func scheduleAfterInspecting(_ tasks: [URLSessionTask]) {
        var schedulingError: Error?
        lock.lock()
        defer {
            isScheduling = false
            lock.unlock()
            if let schedulingError { fail(schedulingError) }
        }

        guard let state, let item = state.currentItem, !item.transferComplete else { return }
        guard let token = bearerToken ?? (try? KeychainSessionStore().load()) else {
            schedulingError = AfterimageError.missingCredential
            return
        }
        bearerToken = token

        let activeDescriptions = Set(tasks.compactMap(\.taskDescription))
        switch item.plan.mode {
        case .single:
            let description = taskDescription(assetID: item.assetID, partNumber: nil)
            guard !activeDescriptions.contains(description) else { return }
            guard let path = item.plan.url else {
                schedulingError = AfterimageError.uploadPlanInvalid
                return
            }
            do {
                let request = try BackgroundUploadRequestFactory.make(
                    path: path,
                    baseURL: state.baseURL,
                    bearerToken: token,
                    contentType: item.contentType,
                    contentLength: item.byteSize,
                    additionalHeaders: item.plan.headers
                )
                let task = backgroundSession.uploadTask(with: request, fromFile: item.mediaURL)
                task.taskDescription = description
                task.resume()
            } catch {
                schedulingError = error
            }

        case .multipart:
            guard let partSize = item.plan.partSize, partSize > 0 else {
                schedulingError = AfterimageError.uploadPlanInvalid
                return
            }
            let chunks = MultipartChunkPlanner.chunks(fileSize: item.byteSize, partSize: partSize)
            let activePartNumbers = Set(activeDescriptions.compactMap { parseTaskDescription($0)?.partNumber })
            let availableSlots = max(0, Self.maximumConcurrentParts - activePartNumbers.count)
            let pending = chunks.filter {
                !item.completedParts.contains($0.partNumber) && !activePartNumbers.contains($0.partNumber)
            }.prefix(availableSlots)

            for chunk in pending {
                do {
                    let chunkURL = try writeChunkToFile(chunk, item: item)
                    let path = try item.plan.path(forPart: chunk.partNumber)
                    let request = try BackgroundUploadRequestFactory.make(
                        path: path,
                        baseURL: state.baseURL,
                        bearerToken: token,
                        contentType: "application/octet-stream",
                        contentLength: Int64(chunk.length),
                        additionalHeaders: item.plan.headers
                    )
                    let task = backgroundSession.uploadTask(with: request, fromFile: chunkURL)
                    task.taskDescription = taskDescription(assetID: item.assetID, partNumber: chunk.partNumber)
                    task.resume()
                } catch {
                    schedulingError = error
                    return
                }
            }
        }
    }

    private func writeChunkToFile(_ chunk: MultipartChunk, item: BackgroundUploadState.Item) throws -> URL {
        let chunkURL = item.mediaURL.deletingLastPathComponent()
            .appendingPathComponent("part-\(chunk.partNumber).bin")
        if FileManager.default.fileExists(atPath: chunkURL.path) { return chunkURL }

        let handle = try FileHandle(forReadingFrom: item.mediaURL)
        defer { try? handle.close() }
        try handle.seek(toOffset: UInt64(chunk.offset))
        guard let data = try handle.read(upToCount: chunk.length), data.count == chunk.length else {
            throw AfterimageError.invalidResponse
        }
        try data.write(to: chunkURL, options: .atomic)
        return chunkURL
    }

    private func finalizeCurrentItem() {
        let payload = lock.withLock { () -> (BackgroundUploadState.Item, URL, String)? in
            guard !isFinalizing, let state, let item = state.currentItem else { return nil }
            guard let token = bearerToken ?? (try? KeychainSessionStore().load()) else { return nil }
            bearerToken = token
            isFinalizing = true
            return (item, state.baseURL, token)
        }
        guard let (item, baseURL, token) = payload else {
            if lock.withLock({ state?.currentItem != nil && !isFinalizing }) {
                fail(AfterimageError.missingCredential)
            }
            return
        }

        Task { [weak self] in
            do {
                let api = APIClient(baseURL: baseURL)
                await api.setBearerToken(token)
                _ = try await api.completeUpload(assetID: item.assetID)
                if let thumbnailURL = item.thumbnailURL {
                    try? await api.uploadThumbnail(thumbnailURL, assetID: item.assetID)
                }
                self?.finalizationSucceeded(item: item)
            } catch {
                self?.finalizationFailed(error)
            }
        }
    }

    private func finalizationSucceeded(item: BackgroundUploadState.Item) {
        var shouldContinue = false
        var completion: (@Sendable (Result<Void, Error>) -> Void)?
        let activityID = lock.withLock { () -> String? in
            removeStagedFiles(for: item)
            guard var state else { return nil }
            state.currentIndex += 1
            self.state = state
            isFinalizing = false
            if state.allComplete {
                clearStateLocked()
                completion = finishHandler
                finishHandler = nil
                progressHandler = nil
            } else {
                saveStateLocked()
                shouldContinue = true
            }
            return state.activityID
        }

        if shouldContinue {
            processCurrentItem()
        } else {
            Task { @MainActor in
                UploadLiveActivityManager.shared.end(activityID: activityID)
            }
            completion?(.success(()))
        }
        completeSystemEventsIfPossible()
    }

    private func finalizationFailed(_ error: Error) {
        let completion = lock.withLock { () -> (@Sendable (Result<Void, Error>) -> Void)? in
            isFinalizing = false
            saveStateLocked()
            let handler = finishHandler
            finishHandler = nil
            return handler
        }
        updateLiveActivity(stage: L10n.string("upload.stage.waiting_to_retry"), progress: currentProgress())
        completion?(.failure(error))
        completeSystemEventsIfPossible()
    }

    private func finishSuccessIfNeeded() {
        var completion: (@Sendable (Result<Void, Error>) -> Void)?
        let activityID = lock.withLock { () -> String? in
            guard let state, state.allComplete else { return nil }
            let id = state.activityID
            clearStateLocked()
            completion = finishHandler
            finishHandler = nil
            progressHandler = nil
            return id
        }
        guard activityID != nil || completion != nil else { return }
        Task { @MainActor in
            UploadLiveActivityManager.shared.end(activityID: activityID)
        }
        completion?(.success(()))
        completeSystemEventsIfPossible()
    }

    private func fail(_ error: Error) {
        let completion = lock.withLock { () -> (@Sendable (Result<Void, Error>) -> Void)? in
            saveStateLocked()
            let handler = finishHandler
            finishHandler = nil
            return handler
        }
        updateLiveActivity(stage: L10n.string("upload.stage.retrying"), progress: currentProgress())
        completion?(.failure(error))
        completeSystemEventsIfPossible()
    }

    private func finishCancellation() {
        var completion: (@Sendable (Result<Void, Error>) -> Void)?
        let activityID = lock.withLock { () -> String? in
            if let state {
                state.items.forEach(removeStagedFiles)
            }
            let id = state?.activityID
            clearStateLocked()
            sentBytesByTask.removeAll()
            completion = finishHandler
            finishHandler = nil
            progressHandler = nil
            return id
        }
        Task { @MainActor in
            UploadLiveActivityManager.shared.cancel(activityID: activityID)
        }
        completion?(.failure(AfterimageError.cancelled))
        completeSystemEventsIfPossible()
    }

    // MARK: - Progress

    private func currentProgress() -> Double {
        lock.withLock { currentProgressLocked() }
    }

    private func currentProgressLocked() -> Double {
        guard let state, let item = state.currentItem, item.byteSize > 0 else { return 0 }
        let completedBytes: Int64
        switch item.plan.mode {
        case .single:
            completedBytes = item.transferComplete ? item.byteSize : 0
        case .multipart:
            let chunks = MultipartChunkPlanner.chunks(
                fileSize: item.byteSize,
                partSize: item.plan.partSize ?? 1
            )
            completedBytes = chunks
                .filter { item.completedParts.contains($0.partNumber) }
                .reduce(0) { $0 + Int64($1.length) }
        }
        let inFlightBytes = sentBytesByTask.values.reduce(0, +)
        return min(1, Double(completedBytes + inFlightBytes) / Double(item.byteSize))
    }

    private func reportProgress(taskID: Int, totalBytesSent: Int64) {
        let payload = lock.withLock { () -> (String, Double, Int, Int)? in
            guard let state, let item = state.currentItem else { return nil }
            sentBytesByTask[taskID] = totalBytesSent
            return (item.filename, currentProgressLocked(), state.currentIndex + 1, state.items.count)
        }
        guard let (filename, progress, current, total) = payload else { return }
        progressHandler?(filename, progress, current, total)
        updateLiveActivity(stage: L10n.string("upload.stage.uploading"), progress: 0.50 + progress * 0.44)
    }

    private func updateLiveActivity(stage: String, progress: Double) {
        let payload = lock.withLock { () -> (String?, Int, Int)? in
            guard let state else { return nil }
            return (state.activityID, state.currentIndex + 1, state.items.count)
        }
        guard let (activityID, current, total) = payload else { return }
        Task { @MainActor in
            UploadLiveActivityManager.shared.update(
                activityID: activityID,
                stage: stage,
                progress: progress,
                current: current,
                total: total
            )
        }
    }

    // MARK: - Task descriptions

    private func taskDescription(assetID: String, partNumber: Int?) -> String {
        if let partNumber { return "part:\(assetID):\(partNumber)" }
        return "single:\(assetID)"
    }

    private func parseTaskDescription(_ description: String) -> (assetID: String, partNumber: Int?)? {
        let parts = description.split(separator: ":").map(String.init)
        guard parts.count >= 2 else { return nil }
        if parts[0] == "single" { return (parts[1], nil) }
        if parts[0] == "part", parts.count == 3, let number = Int(parts[2]) {
            return (parts[1], number)
        }
        return nil
    }

    private func completeSystemEventsIfPossible() {
        let completion = lock.withLock { () -> SystemCompletionBox? in
            guard backgroundEventsFinished, !isFinalizing else { return nil }
            backgroundEventsFinished = false
            let handler = systemCompletionHandler
            systemCompletionHandler = nil
            return handler
        }
        guard let completion else { return }
        DispatchQueue.main.async { completion.handler() }
    }
}

// MARK: - URLSession delegates

extension BackgroundUploadManager: URLSessionTaskDelegate, URLSessionDataDelegate {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didSendBodyData bytesSent: Int64,
        totalBytesSent: Int64,
        totalBytesExpectedToSend: Int64
    ) {
        reportProgress(taskID: task.taskIdentifier, totalBytesSent: totalBytesSent)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        defer {
            _ = lock.withLock { sentBytesByTask.removeValue(forKey: task.taskIdentifier) }
        }
        if let error {
            if (error as NSError).code != NSURLErrorCancelled { fail(error) }
            return
        }
        guard let response = task.response as? HTTPURLResponse,
              (200..<300).contains(response.statusCode),
              let description = task.taskDescription,
              let parsed = parseTaskDescription(description) else {
            fail(AfterimageError.invalidResponse)
            return
        }

        var transferFinished = false
        var shouldScheduleMore = false
        lock.withLock {
            guard var state, var item = state.currentItem, item.assetID == parsed.assetID else { return }
            if let partNumber = parsed.partNumber {
                item.completedParts.insert(partNumber)
                let chunkURL = item.mediaURL.deletingLastPathComponent()
                    .appendingPathComponent("part-\(partNumber).bin")
                try? FileManager.default.removeItem(at: chunkURL)
                let expected = MultipartChunkPlanner.chunks(
                    fileSize: item.byteSize,
                    partSize: item.plan.partSize ?? 1
                ).count
                item.transferComplete = item.completedParts.count >= expected
            } else {
                item.transferComplete = true
            }
            state.items[state.currentIndex] = item
            self.state = state
            saveStateLocked()
            transferFinished = item.transferComplete
            shouldScheduleMore = !transferFinished
        }

        if transferFinished {
            updateLiveActivity(stage: L10n.string("upload.stage.finishing"), progress: 0.96)
            finalizeCurrentItem()
        } else if shouldScheduleMore {
            scheduleCurrentTransfers()
        }
    }

    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        lock.withLock { backgroundEventsFinished = true }
        completeSystemEventsIfPossible()
    }
}

private extension NSRecursiveLock {
    func withLock<T>(_ operation: () throws -> T) rethrows -> T {
        lock()
        defer { unlock() }
        return try operation()
    }
}
