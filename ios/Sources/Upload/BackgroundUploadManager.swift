import Foundation

struct BackgroundUploadContext: Sendable {
    let baseURL: URL
    let session: StoredSession
}

struct UploadPreviewDescriptor: Equatable, Sendable {
    let generationID: UUID
    let assetID: String
    let mediaURL: URL
    let contentType: String
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

    let generationID: UUID
    var authContext: AuthSessionContext
    let baseURL: URL
    let activityID: String?
    var items: [Item]
    var currentIndex: Int
    var pausedAfterFailure: Bool
    var cancellationRequested: Bool
    var retryAttemptsByTransfer: [String: Int]
    var retryNotBeforeByTransfer: [String: Date]

    var currentItem: Item? {
        guard items.indices.contains(currentIndex) else { return nil }
        return items[currentIndex]
    }

    var currentPreviewDescriptor: UploadPreviewDescriptor? {
        guard !cancellationRequested,
              let item = currentItem,
              item.contentType.hasPrefix("video/"),
              item.mediaURL.isFileURL else { return nil }
        return UploadPreviewDescriptor(
            generationID: generationID,
            assetID: item.assetID,
            mediaURL: item.mediaURL,
            contentType: item.contentType
        )
    }

    var allComplete: Bool {
        currentIndex >= items.count
    }

    init(
        generationID: UUID = UUID(),
        authContext: AuthSessionContext = AuthSessionContext(
            generationID: UUID(),
            accountID: nil
        ),
        baseURL: URL,
        activityID: String?,
        items: [Item],
        currentIndex: Int,
        pausedAfterFailure: Bool = false,
        cancellationRequested: Bool = false,
        retryAttemptsByTransfer: [String: Int] = [:],
        retryNotBeforeByTransfer: [String: Date] = [:]
    ) {
        self.generationID = generationID
        self.authContext = authContext
        self.baseURL = baseURL
        self.activityID = activityID
        self.items = items
        self.currentIndex = currentIndex
        self.pausedAfterFailure = pausedAfterFailure
        self.cancellationRequested = cancellationRequested
        self.retryAttemptsByTransfer = retryAttemptsByTransfer
        self.retryNotBeforeByTransfer = retryNotBeforeByTransfer
    }

    private enum CodingKeys: String, CodingKey {
        case generationID
        case authContext
        case baseURL
        case activityID
        case items
        case currentIndex
        case pausedAfterFailure
        case cancellationRequested
        case retryAttemptsByTransfer
        case retryNotBeforeByTransfer
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        generationID = try container.decodeIfPresent(UUID.self, forKey: .generationID) ?? UUID()
        authContext = try container.decodeIfPresent(
            AuthSessionContext.self,
            forKey: .authContext
        ) ?? AuthSessionContext(generationID: UUID(), accountID: nil)
        baseURL = try container.decode(URL.self, forKey: .baseURL)
        activityID = try container.decodeIfPresent(String.self, forKey: .activityID)
        items = try container.decode([Item].self, forKey: .items)
        currentIndex = try container.decode(Int.self, forKey: .currentIndex)
        pausedAfterFailure = try container.decodeIfPresent(Bool.self, forKey: .pausedAfterFailure) ?? false
        cancellationRequested = try container.decodeIfPresent(Bool.self, forKey: .cancellationRequested) ?? false
        retryAttemptsByTransfer = try container.decodeIfPresent([String: Int].self, forKey: .retryAttemptsByTransfer) ?? [:]
        retryNotBeforeByTransfer = try container.decodeIfPresent([String: Date].self, forKey: .retryNotBeforeByTransfer) ?? [:]
    }
}

struct BackgroundUploadTaskIdentity: Equatable, Sendable {
    let generationID: UUID
    let assetID: String
    let partNumber: Int?

    var description: String {
        if let partNumber {
            return "v2:part:\(generationID.uuidString):\(assetID):\(partNumber)"
        }
        return "v2:single:\(generationID.uuidString):\(assetID)"
    }

    init(generationID: UUID, assetID: String, partNumber: Int?) {
        self.generationID = generationID
        self.assetID = assetID
        self.partNumber = partNumber
    }

    init?(description: String) {
        let parts = description.split(separator: ":", omittingEmptySubsequences: false).map(String.init)
        guard parts.count >= 4,
              parts[0] == "v2",
              let generationID = UUID(uuidString: parts[2]),
              !parts[3].isEmpty else { return nil }
        switch parts[1] {
        case "single" where parts.count == 4:
            self.init(generationID: generationID, assetID: parts[3], partNumber: nil)
        case "part" where parts.count == 5:
            guard let partNumber = Int(parts[4]), partNumber > 0 else { return nil }
            self.init(generationID: generationID, assetID: parts[3], partNumber: partNumber)
        default:
            return nil
        }
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

enum BackgroundUploadRetryDisposition: Equatable, Sendable {
    case retry(after: TimeInterval)
    case reconcile
    case expireSession
    case fail
}

enum BackgroundUploadRetryPolicy {
    private static let retryDelays: [TimeInterval] = [2, 10, 30, 60]

    static func disposition(
        error: Error?,
        httpStatus: Int?,
        attempt: Int
    ) -> BackgroundUploadRetryDisposition {
        if let httpStatus {
            if httpStatus == 401 {
                return .expireSession
            }
            if httpStatus == 404 {
                return .reconcile
            }
            guard httpStatus == 408
                    || httpStatus == 425
                    || httpStatus == 429
                    || httpStatus == 409
                    || (500...599).contains(httpStatus) else {
                return .fail
            }
            return retryDisposition(attempt: attempt)
        }

        if let afterimageError = error as? AfterimageError {
            if case .invalidResponse = afterimageError {
                return retryDisposition(attempt: attempt)
            }
            return .fail
        }

        guard let urlErrorCode = urlErrorCode(from: error) else { return .fail }
        switch urlErrorCode {
        case .badURL,
             .unsupportedURL,
             .userAuthenticationRequired,
             .userCancelledAuthentication,
             .appTransportSecurityRequiresSecureConnection,
             .secureConnectionFailed,
             .serverCertificateHasBadDate,
             .serverCertificateUntrusted,
             .serverCertificateHasUnknownRoot,
             .serverCertificateNotYetValid,
             .clientCertificateRejected,
             .clientCertificateRequired,
             .fileDoesNotExist,
             .noPermissionsToReadFile,
             .dataLengthExceedsMaximum:
            return .fail
        default:
            return retryDisposition(attempt: attempt)
        }
    }

    private static func retryDisposition(attempt: Int) -> BackgroundUploadRetryDisposition {
        guard retryDelays.indices.contains(attempt - 1) else { return .fail }
        return .retry(after: retryDelays[attempt - 1])
    }

    private static func urlErrorCode(from error: Error?) -> URLError.Code? {
        if let urlError = error as? URLError { return urlError.code }
        guard let error else { return nil }
        let nsError = error as NSError
        guard nsError.domain == NSURLErrorDomain else { return nil }
        return URLError.Code(rawValue: nsError.code)
    }
}

enum BackgroundUploadAuthorizationPolicy {
    static func canUse(
        owner: AuthSessionContext,
        current: AuthSessionContext
    ) -> Bool {
        if let ownerAccount = owner.accountID,
           let currentAccount = current.accountID {
            return ownerAccount == currentAccount
        }
        return owner == current
    }
}

/// Transfers optimized media with a background URLSession, then finalizes the
/// asset through the authenticated API. State and staged files survive process
/// termination; URLSession reconnects the delegate on relaunch.
final class BackgroundUploadManager: NSObject, @unchecked Sendable {
    private struct UploadScope: Equatable, Sendable {
        let generationID: UUID
        let assetID: String
    }

    private struct FailureDelivery {
        let scope: UploadScope
        let completion: (@Sendable (Result<Void, Error>) -> Void)?
    }

    private struct TaskProgress: Sendable {
        let scope: UploadScope
        let bytesSent: Int64
    }

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
    private lazy var backgroundSession: URLSession = {
        let delegateQueue = OperationQueue()
        delegateQueue.name = "com.2-38.afterimage.upload.delegate"
        delegateQueue.maxConcurrentOperationCount = 1
        let configuration = URLSessionConfiguration.background(withIdentifier: Self.sessionIdentifier)
        configuration.isDiscretionary = false
        configuration.sessionSendsLaunchEvents = true
        configuration.allowsCellularAccess = true
        return URLSession(configuration: configuration, delegate: self, delegateQueue: delegateQueue)
    }()
    private var state: BackgroundUploadState?
    private var storedSession: StoredSession?
    private var progressHandler: (@MainActor (String, Double, Int, Int) -> Void)?
    private var finishHandler: (@Sendable (Result<Void, Error>) -> Void)?
    private var systemCompletionHandler: SystemCompletionBox?
    private var backgroundEventsFinished = false
    private var schedulingScope: UploadScope?
    private var isFinalizing = false
    private var pendingSystemCompletionScope: UploadScope?
    private var retryAttemptsByTransfer: [String: Int] = [:]
    private var retryNotBeforeByTransfer: [String: Date] = [:]
    private var isPausedAfterFailure = false
    private var finalizationTask: Task<Void, Never>?
    private var finalizationTaskID: UUID?
    private var finalizationRetryTask: Task<Void, Never>?
    private var finalizationRetryID: UUID?
    private var cancellationCleanupTask: Task<Void, Never>?
    private var cancellationCleanupID: UUID?
    private var cancellationCleanupWaiters: [UUID: [@Sendable (Bool) -> Void]] = [:]
    private var cancellationRequested = false
    private var sentBytesByTask: [Int: TaskProgress] = [:]
    private var lastDeliveredProgress = 0.0

    private override init() {
        super.init()
        state = Self.loadStateFromDisk()
        if let state {
            isPausedAfterFailure = state.pausedAfterFailure
            cancellationRequested = state.cancellationRequested
            retryAttemptsByTransfer = state.retryAttemptsByTransfer
            retryNotBeforeByTransfer = state.retryNotBeforeByTransfer
            saveStateLocked()
        }
    }

    var hasPendingUpload: Bool {
        lock.withLock { state != nil }
    }

    var currentPreviewDescriptor: UploadPreviewDescriptor? {
        lock.withLock { state?.currentPreviewDescriptor }
    }

    var requiresExplicitRetry: Bool {
        lock.withLock {
            state != nil && isPausedAfterFailure && !cancellationRequested
        }
    }

    var requiresCancellationCleanupRetry: Bool {
        lock.withLock {
            state != nil && cancellationRequested
        }
    }

    // MARK: - Public API

    func startUpload(
        items: [BackgroundUploadState.Item],
        context: BackgroundUploadContext,
        activityID: String?,
        progress: @escaping @MainActor (String, Double, Int, Int) -> Void,
        completion: @escaping @Sendable (Result<Void, Error>) -> Void
    ) throws {
        guard lock.withLock({ state == nil }) else {
            throw AfterimageError.uploadPlanInvalid
        }
        let stagedItems = try stage(items)
        lock.withLock {
            state = BackgroundUploadState(
                generationID: UUID(),
                authContext: context.session.context,
                baseURL: context.baseURL,
                activityID: activityID,
                items: stagedItems,
                currentIndex: 0
            )
            storedSession = context.session
            progressHandler = progress
            finishHandler = completion
            retryAttemptsByTransfer.removeAll()
            retryNotBeforeByTransfer.removeAll()
            sentBytesByTask.removeAll()
            lastDeliveredProgress = 0
            finalizationRetryTask?.cancel()
            finalizationRetryTask = nil
            finalizationRetryID = nil
            isPausedAfterFailure = false
            isFinalizing = false
            cancellationRequested = false
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
        progress: (@MainActor (String, Double, Int, Int) -> Void)? = nil,
        completion: (@Sendable (Result<Void, Error>) -> Void)? = nil,
        retryAfterFailure: Bool = false
    ) -> Bool {
        var shouldFinishCancellation = false
        let pending = lock.withLock { () -> Bool in
            guard state != nil else { return false }
            if let context {
                guard let state,
                      BackgroundUploadAuthorizationPolicy.canUse(
                          owner: state.authContext,
                          current: context.session.context
                      ) else {
                    return false
                }
                storedSession = context.session
                var rebound = state
                rebound.authContext = context.session.context
                self.state = rebound
                saveStateLocked()
            }
            if let progress { progressHandler = progress }
            if let completion { finishHandler = completion }
            if cancellationRequested {
                shouldFinishCancellation = true
                return true
            }
            if retryAfterFailure, isPausedAfterFailure, !cancellationRequested {
                retryAttemptsByTransfer.removeAll()
                retryNotBeforeByTransfer.removeAll()
                finalizationRetryTask?.cancel()
                finalizationRetryTask = nil
                finalizationRetryID = nil
                isPausedAfterFailure = false
                if var currentState = state {
                    currentState.pausedAfterFailure = false
                    state = currentState
                    saveStateLocked()
                }
            }
            return true
        }
        if shouldFinishCancellation {
            cancelAll()
        } else if pending {
            processCurrentItem()
        }
        return pending
    }

    func handleBackgroundSessionEvents(completionHandler: @escaping () -> Void) {
        lock.withLock {
            systemCompletionHandler = SystemCompletionBox(completionHandler)
            backgroundEventsFinished = false
        }
        _ = backgroundSession
        _ = resumePendingUpload()
    }

    func cancelAllAndWaitForCleanup() async -> Bool {
        await withCheckedContinuation { continuation in
            cancelAll(cleanupCompletion: { succeeded in
                continuation.resume(returning: succeeded)
            })
        }
    }

    func discardAfterAccountDeletionAndWait() async -> Bool {
        await withCheckedContinuation { continuation in
            let expectedGenerationID = lock.withLock { () -> UUID? in
                let generationID = state?.generationID
                cancellationRequested = true
                isPausedAfterFailure = true
                state?.cancellationRequested = true
                finalizationTask?.cancel()
                finalizationTask = nil
                finalizationTaskID = nil
                finalizationRetryTask?.cancel()
                finalizationRetryTask = nil
                finalizationRetryID = nil
                cancellationCleanupTask?.cancel()
                cancellationCleanupTask = nil
                cancellationCleanupID = nil
                saveStateLocked()
                return generationID
            }
            backgroundSession.getAllTasks { [weak self] tasks in
                guard let self else {
                    continuation.resume(returning: false)
                    return
                }
                tasks.forEach { $0.cancel() }
                let result = self.lock.withLock { () -> (
                    succeeded: Bool,
                    waiters: [@Sendable (Bool) -> Void],
                    activityID: String?,
                    completion: (@Sendable (Result<Void, Error>) -> Void)?
                ) in
                    guard self.state?.generationID == expectedGenerationID else {
                        return (false, [], nil, nil)
                    }
                    let waiters = cancellationCleanupWaiters.values.flatMap { $0 }
                    cancellationCleanupWaiters.removeAll()
                    let activityID = state?.activityID
                    let completion = finishHandler
                    finishHandler = nil
                    progressHandler = nil
                    do {
                        if FileManager.default.fileExists(
                            atPath: Self.storageDirectory.path
                        ) {
                            let stagedURLs = try FileManager.default
                                .contentsOfDirectory(
                                    at: Self.storageDirectory,
                                    includingPropertiesForKeys: nil
                                )
                                .filter { $0 != Self.stateFileURL }
                            for stagedURL in stagedURLs {
                                try FileManager.default.removeItem(at: stagedURL)
                            }
                        }
                        if FileManager.default.fileExists(atPath: Self.stateFileURL.path) {
                            try FileManager.default.removeItem(at: Self.stateFileURL)
                        }
                        clearStateLocked()
                        return (true, waiters, activityID, completion)
                    } catch {
                        cancellationRequested = true
                        isPausedAfterFailure = true
                        state?.cancellationRequested = true
                        saveStateLocked()
                        return (false, waiters, activityID, completion)
                    }
                }
                result.waiters.forEach { $0(result.succeeded) }
                result.completion?(.failure(AfterimageError.cancelled))
                Task { @MainActor in
                    UploadLiveActivityManager.shared.cancel(
                        activityID: result.activityID
                    )
                }
                continuation.resume(returning: result.succeeded)
            }
        }
    }

    func cancelAll(
        cleanupCompletion: (@Sendable (Bool) -> Void)? = nil
    ) {
        var completeImmediately = false
        let cancellation = lock.withLock { () -> (
            generationID: UUID,
            activityID: String?,
            completion: (@Sendable (Result<Void, Error>) -> Void)?
        )? in
            guard var state else {
                completeImmediately = true
                return nil
            }
            if let cleanupCompletion {
                cancellationCleanupWaiters[state.generationID, default: []].append(cleanupCompletion)
            }
            cancellationRequested = true
            isPausedAfterFailure = true
            isFinalizing = false
            state.cancellationRequested = true
            self.state = state
            finalizationTask?.cancel()
            finalizationTask = nil
            finalizationTaskID = nil
            finalizationRetryTask?.cancel()
            finalizationRetryTask = nil
            finalizationRetryID = nil
            let completion = finishHandler
            finishHandler = nil
            progressHandler = nil
            saveStateLocked()
            return (state.generationID, state.activityID, completion)
        }
        guard let (generationID, activityID, completion) = cancellation else {
            if completeImmediately {
                cleanupCompletion?(true)
            }
            return
        }
        Task { @MainActor in
            UploadLiveActivityManager.shared.cancel(activityID: activityID)
        }
        completion?(.failure(AfterimageError.cancelled))
        backgroundSession.getAllTasks { [weak self] tasks in
            guard let self,
                  self.lock.withLock({
                      self.cancellationRequested && self.state?.generationID == generationID
                  }) else { return }
            tasks.forEach { $0.cancel() }
            self.finishCancellation(ifCurrentGeneration: generationID)
        }
    }

    // MARK: - Persistence and staging

    private static func loadStateFromDisk() -> BackgroundUploadState? {
        guard let data = try? Data(contentsOf: stateFileURL) else { return nil }
        return try? JSONDecoder().decode(BackgroundUploadState.self, from: data)
    }

    private func saveStateLocked() {
        guard var state else { return }
        state.retryAttemptsByTransfer = retryAttemptsByTransfer
        state.retryNotBeforeByTransfer = retryNotBeforeByTransfer
        self.state = state
        guard let data = try? JSONEncoder().encode(state) else { return }
        try? data.write(to: Self.stateFileURL, options: .atomic)
    }

    private func isCurrentLocked(_ scope: UploadScope) -> Bool {
        guard let state else { return false }
        return state.generationID == scope.generationID
            && state.currentItem?.assetID == scope.assetID
    }

    private func isActiveCurrentLocked(_ scope: UploadScope) -> Bool {
        !cancellationRequested && !isPausedAfterFailure && isCurrentLocked(scope)
    }

    private func clearStateLocked() {
        finalizationTask?.cancel()
        finalizationTask = nil
        finalizationTaskID = nil
        finalizationRetryTask?.cancel()
        finalizationRetryTask = nil
        finalizationRetryID = nil
        cancellationCleanupTask?.cancel()
        cancellationCleanupTask = nil
        cancellationCleanupID = nil
        schedulingScope = nil
        pendingSystemCompletionScope = nil
        isPausedAfterFailure = false
        isFinalizing = false
        cancellationRequested = false
        lastDeliveredProgress = 0
        storedSession = nil
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
        let current = lock.withLock { () -> (UploadScope, Bool)? in
            guard !isPausedAfterFailure,
                  !cancellationRequested,
                  let state,
                  let item = state.currentItem else { return nil }
            return (
                UploadScope(generationID: state.generationID, assetID: item.assetID),
                item.transferComplete
            )
        }
        guard let (scope, transferComplete) = current else {
            finishSuccessIfNeeded()
            return
        }
        if transferComplete {
            finalizeCurrentItem(ifCurrent: scope)
        } else {
            scheduleCurrentTransfers(ifCurrent: scope)
        }
    }

    private func scheduleCurrentTransfers(ifCurrent expectedScope: UploadScope? = nil) {
        let scope = lock.withLock { () -> UploadScope? in
            guard !isPausedAfterFailure,
                  !cancellationRequested,
                  schedulingScope == nil,
                  let state,
                  let item = state.currentItem else { return nil }
            let scope = UploadScope(generationID: state.generationID, assetID: item.assetID)
            if let expectedScope, expectedScope != scope { return nil }
            schedulingScope = scope
            return scope
        }
        guard let scope else { return }

        backgroundSession.getAllTasks { [weak self] tasks in
            self?.scheduleAfterInspecting(tasks, ifCurrent: scope)
        }
    }

    private func scheduleAfterInspecting(_ tasks: [URLSessionTask], ifCurrent expectedScope: UploadScope) {
        var schedulingFailure: (error: Error, scope: UploadScope)?
        lock.lock()
        defer {
            if schedulingScope == expectedScope {
                schedulingScope = nil
            }
            lock.unlock()
            if let schedulingFailure {
                fail(schedulingFailure.error, ifCurrent: schedulingFailure.scope)
            }
            completeSystemBackgroundEventsAfterSchedulingIfNeeded(ifCurrent: expectedScope)
        }

        guard !isPausedAfterFailure,
              !cancellationRequested,
              let state,
              let item = state.currentItem,
              !item.transferComplete else { return }
        let scope = UploadScope(generationID: state.generationID, assetID: item.assetID)
        guard scope == expectedScope else { return }
        guard let session = storedSession ?? (try? KeychainSessionStore().load()),
              BackgroundUploadAuthorizationPolicy.canUse(
                  owner: state.authContext,
                  current: session.context
              ) else { return }
        storedSession = session

        let activeDescriptions = Set(tasks.compactMap { task -> String? in
            guard let description = task.taskDescription,
                  let identity = parseTaskDescription(description),
                  identity.generationID == state.generationID,
                  identity.assetID == item.assetID else {
                task.cancel()
                return nil
            }
            return description
        })
        switch item.plan.mode {
        case .single:
            let description = taskDescription(
                generationID: state.generationID,
                assetID: item.assetID,
                partNumber: nil
            )
            guard !activeDescriptions.contains(description) else { return }
            guard let path = item.plan.url else {
                schedulingFailure = (AfterimageError.uploadPlanInvalid, scope)
                return
            }
            do {
                let request = try BackgroundUploadRequestFactory.make(
                    path: path,
                    baseURL: state.baseURL,
                    bearerToken: session.token,
                    contentType: item.contentType,
                    contentLength: item.byteSize,
                    additionalHeaders: item.plan.headers
                )
                let task = backgroundSession.uploadTask(with: request, fromFile: item.mediaURL)
                configure(task, description: description, expectedBytes: item.byteSize)
                task.resume()
            } catch {
                schedulingFailure = (error, scope)
            }

        case .multipart:
            guard let partSize = item.plan.partSize, partSize > 0 else {
                schedulingFailure = (AfterimageError.uploadPlanInvalid, scope)
                return
            }
            let chunks = MultipartChunkPlanner.chunks(fileSize: item.byteSize, partSize: partSize)
            let activePartNumbers = Set(activeDescriptions.compactMap { description -> Int? in
                guard let parsed = parseTaskDescription(description),
                      parsed.generationID == state.generationID,
                      parsed.assetID == item.assetID else { return nil }
                return parsed.partNumber
            })
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
                        bearerToken: session.token,
                        contentType: "application/octet-stream",
                        contentLength: Int64(chunk.length),
                        additionalHeaders: item.plan.headers
                    )
                    let task = backgroundSession.uploadTask(with: request, fromFile: chunkURL)
                    let description = taskDescription(
                        generationID: state.generationID,
                        assetID: item.assetID,
                        partNumber: chunk.partNumber
                    )
                    configure(task, description: description, expectedBytes: Int64(chunk.length))
                    task.resume()
                } catch {
                    schedulingFailure = (error, scope)
                    return
                }
            }
        }
    }

    private func configure(_ task: URLSessionTask, description: String, expectedBytes: Int64) {
        task.taskDescription = description
        task.countOfBytesClientExpectsToSend = expectedBytes
        task.countOfBytesClientExpectsToReceive = 1_024
        if let retryDate = retryNotBeforeByTransfer[description] {
            task.earliestBeginDate = retryDate
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

    private func finalizeCurrentItem(ifCurrent expectedScope: UploadScope? = nil) {
        var deferredForCredentials = false
        var deferredForBackoff = false
        let payload = lock.withLock { () -> (BackgroundUploadState.Item, URL, StoredSession, UploadScope)? in
            guard !isPausedAfterFailure,
                  !cancellationRequested,
                  !isFinalizing,
                  let state,
                  let item = state.currentItem,
                  item.transferComplete else { return nil }
            let scope = UploadScope(generationID: state.generationID, assetID: item.assetID)
            if let expectedScope, expectedScope != scope { return nil }
            if finalizationRetryTask != nil {
                deferredForBackoff = true
                return nil
            }
            let retryDescription = "finalize:\(scope.generationID.uuidString):\(scope.assetID)"
            if let retryDate = retryNotBeforeByTransfer[retryDescription], retryDate > Date() {
                let retryID = UUID()
                let delay = max(0, retryDate.timeIntervalSinceNow)
                let retryTask = Task { [weak self] in
                    do {
                        try await Task.sleep(for: .seconds(delay))
                    } catch {
                        return
                    }
                    self?.retryFinalizationIfCurrent(scope: scope, retryID: retryID)
                }
                finalizationRetryTask = retryTask
                finalizationRetryID = retryID
                deferredForBackoff = true
                return nil
            }
            if retryNotBeforeByTransfer.removeValue(forKey: retryDescription) != nil {
                saveStateLocked()
            }
            guard let session = storedSession ?? (try? KeychainSessionStore().load()),
                  BackgroundUploadAuthorizationPolicy.canUse(
                      owner: state.authContext,
                      current: session.context
                  ) else {
                deferredForCredentials = true
                return nil
            }
            storedSession = session
            isFinalizing = true
            return (item, state.baseURL, session, scope)
        }
        guard let (item, baseURL, session, scope) = payload else {
            if deferredForCredentials || deferredForBackoff {
                completeSystemEventsIfPossible()
            }
            return
        }

        let taskID = UUID()
        lock.withLock {
            guard isActiveCurrentLocked(scope),
                  isFinalizing,
                  finalizationTask == nil else { return }
            finalizationTaskID = taskID
            finalizationTask = Task { [weak self] in
                guard let self, !Task.isCancelled else { return }
                do {
                    let api = APIClient(baseURL: baseURL)
                    await api.setSession(session)
                    _ = try await api.completeUpload(assetID: item.assetID)
                    if let thumbnailURL = item.thumbnailURL {
                        try? await api.uploadThumbnail(thumbnailURL, assetID: item.assetID)
                    }
                    self.finalizationSucceeded(item: item, scope: scope, taskID: taskID)
                } catch {
                    self.finalizationFailed(error, scope: scope, taskID: taskID)
                }
            }
        }
    }

    private func finalizationSucceeded(
        item: BackgroundUploadState.Item,
        scope: UploadScope,
        taskID: UUID
    ) {
        var shouldContinue = false
        var didApply = false
        var completion: (@Sendable (Result<Void, Error>) -> Void)?
        let activityID = lock.withLock { () -> String? in
            guard isActiveCurrentLocked(scope),
                  finalizationTaskID == taskID,
                  var state,
                  state.currentItem?.assetID == item.assetID else { return nil }
            finalizationTask = nil
            finalizationTaskID = nil
            finalizationRetryTask?.cancel()
            finalizationRetryTask = nil
            finalizationRetryID = nil
            removeStagedFiles(for: item)
            retryAttemptsByTransfer.removeAll()
            retryNotBeforeByTransfer.removeAll()
            state.currentIndex += 1
            lastDeliveredProgress = 0
            self.state = state
            isFinalizing = false
            didApply = true
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

        guard didApply else {
            completeSystemEventsIfPossible()
            return
        }

        if shouldContinue {
            processCurrentItem()
        } else {
            Task { @MainActor in
                UploadLiveActivityManager.shared.end(activityID: activityID)
            }
            if let completion { completion(.success(Void())) }
        }
        completeSystemEventsIfPossible()
    }

    private func finalizationFailed(_ error: Error, scope: UploadScope, taskID: UUID) {
        var failureDelivery: FailureDelivery?
        let retryScheduled = lock.withLock { () -> Bool in
            guard isActiveCurrentLocked(scope),
                  finalizationTaskID == taskID else { return false }
            finalizationTask = nil
            finalizationTaskID = nil
            isFinalizing = false
            let description = "finalize:\(scope.generationID.uuidString):\(scope.assetID)"
            let attempt = (retryAttemptsByTransfer[description] ?? 0) + 1
            retryAttemptsByTransfer[description] = attempt
            let disposition = BackgroundUploadRetryPolicy.disposition(
                error: error,
                httpStatus: httpStatus(from: error),
                attempt: attempt
            )

            guard case let .retry(delay) = disposition else {
                failureDelivery = applyFailureLocked(ifCurrent: scope)
                return false
            }

            retryNotBeforeByTransfer[description] = Date().addingTimeInterval(delay)
            let retryID = UUID()
            let retryTask = Task { [weak self] in
                do {
                    try await Task.sleep(for: .seconds(delay))
                } catch {
                    return
                }
                self?.retryFinalizationIfCurrent(scope: scope, retryID: retryID)
            }
            finalizationRetryTask?.cancel()
            finalizationRetryTask = retryTask
            finalizationRetryID = retryID
            saveStateLocked()
            return true
        }

        if retryScheduled {
            updateLiveActivity(
                stage: L10n.string("upload.stage.retrying"),
                progress: currentProgress(ifCurrent: scope),
                ifCurrent: scope
            )
            completeSystemEventsIfPossible()
        }
        if let failureDelivery {
            deliverFailure(failureDelivery, error: error)
        }
    }

    private func retryFinalizationIfCurrent(
        scope: UploadScope,
        retryID: UUID
    ) {
        let shouldRetry = lock.withLock { () -> Bool in
            guard isActiveCurrentLocked(scope),
                  finalizationRetryID == retryID else { return false }
            finalizationRetryTask = nil
            finalizationRetryID = nil
            return true
        }
        if shouldRetry { finalizeCurrentItem(ifCurrent: scope) }
    }

    private func finishSuccessIfNeeded() {
        var didApply = false
        var completion: (@Sendable (Result<Void, Error>) -> Void)?
        let activityID = lock.withLock { () -> String? in
            guard let state, state.allComplete else { return nil }
            let id = state.activityID
            clearStateLocked()
            didApply = true
            completion = finishHandler
            finishHandler = nil
            progressHandler = nil
            return id
        }
        guard didApply else { return }
        Task { @MainActor in
            UploadLiveActivityManager.shared.end(activityID: activityID)
        }
        if let completion { completion(.success(Void())) }
        completeSystemEventsIfPossible()
    }

    private func applyFailureLocked(ifCurrent scope: UploadScope) -> FailureDelivery? {
        guard isActiveCurrentLocked(scope) else { return nil }
        isPausedAfterFailure = true
        if var state {
            state.pausedAfterFailure = true
            self.state = state
        }
        isFinalizing = false
        finalizationRetryTask?.cancel()
        finalizationRetryTask = nil
        finalizationRetryID = nil
        saveStateLocked()
        let handler = finishHandler
        finishHandler = nil
        return FailureDelivery(scope: scope, completion: handler)
    }

    private func deliverFailure(_ delivery: FailureDelivery, error: Error) {
        updateLiveActivity(
            stage: L10n.string("upload.stage.retrying"),
            progress: currentProgress(ifCurrent: delivery.scope),
            ifCurrent: delivery.scope
        )
        delivery.completion?(.failure(error))
        completeSystemEventsIfPossible()
    }

    private func fail(_ error: Error, ifCurrent scope: UploadScope) {
        guard let delivery = lock.withLock({ applyFailureLocked(ifCurrent: scope) }) else { return }
        deliverFailure(delivery, error: error)
    }

    private func finishCancellation(ifCurrentGeneration generationID: UUID) {
        var unavailableWaiters: [@Sendable (Bool) -> Void] = []
        lock.withLock {
            guard cancellationRequested,
                  let state,
                  state.generationID == generationID,
                  cancellationCleanupTask == nil else {
                return
            }
            guard let session = storedSession ?? (try? KeychainSessionStore().load()),
                  BackgroundUploadAuthorizationPolicy.canUse(
                      owner: state.authContext,
                      current: session.context
                  ) else {
                unavailableWaiters = cancellationCleanupWaiters.removeValue(forKey: generationID) ?? []
                return
            }
            storedSession = session
            let baseURL = state.baseURL
            let assetIDs = Array(Set(state.items.map(\.assetID)))
            let cleanupID = UUID()
            cancellationCleanupID = cleanupID
            cancellationCleanupTask = Task { [weak self] in
                guard let self, !Task.isCancelled else { return }
                let api = APIClient(baseURL: baseURL)
                await api.setSession(session)
                do {
                    for assetID in assetIDs {
                        do {
                            try await api.deleteAsset(assetID: assetID)
                        } catch {
                            if case let .some(.api(status, _, _)) = error as? AfterimageError,
                               status == 404 {
                                continue
                            }
                            throw error
                        }
                    }
                    self.finishCancellationCleanup(
                        ifCurrentGeneration: generationID,
                        cleanupID: cleanupID
                    )
                } catch {
                    self.cancellationCleanupFailed(
                        ifCurrentGeneration: generationID,
                        cleanupID: cleanupID
                    )
                }
            }
        }
        unavailableWaiters.forEach { $0(false) }
        completeSystemEventsIfPossible()
    }

    private func finishCancellationCleanup(
        ifCurrentGeneration generationID: UUID,
        cleanupID: UUID
    ) {
        let waiters = lock.withLock { () -> [@Sendable (Bool) -> Void]? in
            guard cancellationRequested,
                  let state,
                  state.generationID == generationID,
                  cancellationCleanupID == cleanupID else { return nil }
            cancellationCleanupTask = nil
            cancellationCleanupID = nil
            let waiters = cancellationCleanupWaiters.removeValue(forKey: generationID) ?? []
            state.items.forEach(removeStagedFiles)
            sentBytesByTask.removeAll()
            retryAttemptsByTransfer.removeAll()
            retryNotBeforeByTransfer.removeAll()
            clearStateLocked()
            return waiters
        }
        if let waiters {
            waiters.forEach { $0(true) }
            completeSystemEventsIfPossible()
        }
    }

    private func cancellationCleanupFailed(
        ifCurrentGeneration generationID: UUID,
        cleanupID: UUID
    ) {
        let waiters = lock.withLock { () -> [@Sendable (Bool) -> Void]? in
            guard cancellationRequested,
                  state?.generationID == generationID,
                  cancellationCleanupID == cleanupID else { return nil }
            cancellationCleanupTask = nil
            cancellationCleanupID = nil
            let waiters = cancellationCleanupWaiters.removeValue(forKey: generationID) ?? []
            saveStateLocked()
            return waiters
        }
        if let waiters {
            waiters.forEach { $0(false) }
            completeSystemEventsIfPossible()
        }
    }

    private func handleTransferFailure(
        task: URLSessionTask,
        error: Error?,
        httpStatus: Int?
    ) {
        if let error,
           (error as NSError).code == NSURLErrorCancelled,
           lock.withLock({ cancellationRequested }) {
            return
        }
        guard let description = task.taskDescription,
              let parsed = parseTaskDescription(description) else {
            return
        }
        let scope = UploadScope(generationID: parsed.generationID, assetID: parsed.assetID)

        let disposition = lock.withLock { () -> BackgroundUploadRetryDisposition? in
            guard isActiveCurrentLocked(scope) else { return nil }
            let attempt = (retryAttemptsByTransfer[description] ?? 0) + 1
            retryAttemptsByTransfer[description] = attempt
            return BackgroundUploadRetryPolicy.disposition(
                error: error,
                httpStatus: httpStatus,
                attempt: attempt
            )
        }
        guard let disposition else { return }

        switch disposition {
        case let .retry(delay):
            let isCurrent = lock.withLock { () -> Bool in
                guard isActiveCurrentLocked(scope) else { return false }
                retryNotBeforeByTransfer[description] = Date().addingTimeInterval(delay)
                saveStateLocked()
                return true
            }
            guard isCurrent else { return }
            updateLiveActivity(
                stage: L10n.string("upload.stage.retrying"),
                progress: currentProgress(ifCurrent: scope),
                ifCurrent: scope
            )
            scheduleCurrentTransfers(ifCurrent: scope)
        case .reconcile:
            let reconciled = lock.withLock { () -> Bool in
                guard isActiveCurrentLocked(scope),
                      var state,
                      var item = state.currentItem else { return false }
                item.transferComplete = true
                state.items[state.currentIndex] = item
                self.state = state
                retryAttemptsByTransfer.removeValue(forKey: description)
                retryNotBeforeByTransfer.removeValue(forKey: description)
                saveStateLocked()
                return true
            }
            guard reconciled else { return }
            updateLiveActivity(
                stage: L10n.string("upload.stage.finishing"),
                progress: 0.96,
                ifCurrent: scope
            )
            finalizeCurrentItem(ifCurrent: scope)
        case .expireSession:
            let session = lock.withLock { storedSession }
            let error = AfterimageError.api(
                status: 401,
                code: .unauthorized,
                message: "expired"
            )
            fail(error, ifCurrent: scope)
            if let session {
                Task {
                    await AuthGenerationGate.shared.invalidate(session.context)
                }
            }
        case .fail:
            if let error {
                fail(error, ifCurrent: scope)
            } else if let httpStatus {
                fail(AfterimageError.api(
                    status: httpStatus,
                    code: .backgroundUploadFailed,
                    message: HTTPURLResponse.localizedString(forStatusCode: httpStatus)
                ), ifCurrent: scope)
            } else {
                fail(AfterimageError.invalidResponse, ifCurrent: scope)
            }
        }
    }

    private func httpStatus(from error: Error) -> Int? {
        guard let error = error as? AfterimageError,
              case let .api(status, _, _) = error else { return nil }
        return status
    }

    // MARK: - Progress

    private func currentProgress(ifCurrent scope: UploadScope? = nil) -> Double {
        lock.withLock {
            if let scope, !isCurrentLocked(scope) { return 0 }
            return currentProgressLocked()
        }
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
        let scope = UploadScope(generationID: state.generationID, assetID: item.assetID)
        let inFlightBytes = sentBytesByTask.values
            .filter { $0.scope == scope }
            .reduce(0) { $0 + $1.bytesSent }
        return min(1, Double(completedBytes + inFlightBytes) / Double(item.byteSize))
    }

    private func reportProgress(
        taskID: Int,
        taskDescription: String?,
        totalBytesSent: Int64
    ) {
        guard let taskDescription,
              let parsed = parseTaskDescription(taskDescription) else { return }
        let scope = UploadScope(generationID: parsed.generationID, assetID: parsed.assetID)
        let payload = lock.withLock { () -> (String, Int, Int)? in
            guard isActiveCurrentLocked(scope),
                  let state,
                  let item = state.currentItem else { return nil }
            sentBytesByTask[taskID] = TaskProgress(scope: scope, bytesSent: totalBytesSent)
            return (
                item.filename,
                state.currentIndex + 1,
                state.items.count
            )
        }
        guard let (filename, current, total) = payload else { return }
        Task { @MainActor [weak self] in
            guard let self else { return }
            let progress = self.lock.withLock { () -> Double? in
                guard self.isActiveCurrentLocked(scope),
                      let item = self.state?.currentItem,
                      !item.transferComplete else { return nil }
                let progress = max(self.currentProgressLocked(), self.lastDeliveredProgress)
                self.lastDeliveredProgress = progress
                self.progressHandler?(filename, progress, current, total)
                return progress
            }
            guard let progress else { return }
            self.updateLiveActivity(
                stage: L10n.string("upload.stage.uploading"),
                progress: 0.50 + progress * 0.44,
                ifCurrent: scope
            )
        }
    }

    private func updateLiveActivity(
        stage: String,
        progress: Double,
        ifCurrent scope: UploadScope
    ) {
        let payload = lock.withLock { () -> (String?, Int, Int)? in
            guard !cancellationRequested,
                  isCurrentLocked(scope),
                  let state else { return nil }
            return (state.activityID, state.currentIndex + 1, state.items.count)
        }
        guard let (activityID, current, total) = payload else { return }
        Task { @MainActor [weak self] in
            guard let self else { return }
            guard self.lock.withLock({
                !self.cancellationRequested && self.isCurrentLocked(scope)
            }) else { return }
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

    private func taskDescription(generationID: UUID, assetID: String, partNumber: Int?) -> String {
        BackgroundUploadTaskIdentity(
            generationID: generationID,
            assetID: assetID,
            partNumber: partNumber
        ).description
    }

    private func parseTaskDescription(_ description: String) -> BackgroundUploadTaskIdentity? {
        BackgroundUploadTaskIdentity(description: description)
    }

    private func completeSystemBackgroundEventsAfterSchedulingIfNeeded(ifCurrent scope: UploadScope) {
        let shouldComplete = lock.withLock { () -> Bool in
            guard pendingSystemCompletionScope == scope else { return false }
            pendingSystemCompletionScope = nil
            return true
        }
        if shouldComplete {
            completeSystemEventsIfPossible()
        }
    }

    private func completeSystemEventsIfPossible() {
        let completion = lock.withLock { () -> SystemCompletionBox? in
            guard backgroundEventsFinished,
                  pendingSystemCompletionScope == nil else { return nil }
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
        reportProgress(
            taskID: task.taskIdentifier,
            taskDescription: task.taskDescription,
            totalBytesSent: totalBytesSent
        )
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        defer {
            _ = lock.withLock { sentBytesByTask.removeValue(forKey: task.taskIdentifier) }
        }
        if let error {
            handleTransferFailure(task: task, error: error, httpStatus: nil)
            return
        }
        guard let response = task.response as? HTTPURLResponse else {
            handleTransferFailure(task: task, error: AfterimageError.invalidResponse, httpStatus: nil)
            return
        }
        guard (200..<300).contains(response.statusCode) else {
            handleTransferFailure(task: task, error: nil, httpStatus: response.statusCode)
            return
        }
        guard let description = task.taskDescription,
              let parsed = parseTaskDescription(description) else {
            return
        }
        let scope = UploadScope(generationID: parsed.generationID, assetID: parsed.assetID)

        var transferFinished = false
        var shouldScheduleMore = false
        lock.withLock {
            guard isActiveCurrentLocked(scope),
                  var state,
                  var item = state.currentItem else { return }
            retryAttemptsByTransfer.removeValue(forKey: description)
            retryNotBeforeByTransfer.removeValue(forKey: description)
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
            updateLiveActivity(
                stage: L10n.string("upload.stage.finishing"),
                progress: 0.96,
                ifCurrent: scope
            )
            finalizeCurrentItem(ifCurrent: scope)
        } else if shouldScheduleMore {
            scheduleCurrentTransfers(ifCurrent: scope)
        }
    }

    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        let action = lock.withLock { () -> (scope: UploadScope?, finalize: Bool) in
            backgroundEventsFinished = true
            guard !isPausedAfterFailure,
                  !cancellationRequested,
                  !isFinalizing,
                  finalizationRetryTask == nil,
                  let state,
                  let item = state.currentItem else {
                return (nil, false)
            }
            let scope = UploadScope(generationID: state.generationID, assetID: item.assetID)
            if item.transferComplete {
                return (scope, true)
            }
            pendingSystemCompletionScope = scope
            return (scope, false)
        }

        if action.finalize, let scope = action.scope {
            finalizeCurrentItem(ifCurrent: scope)
            completeSystemEventsIfPossible()
        } else if let scope = action.scope {
            scheduleCurrentTransfers(ifCurrent: scope)
        } else {
            completeSystemEventsIfPossible()
        }
    }
}

private extension NSRecursiveLock {
    func withLock<T>(_ operation: () throws -> T) rethrows -> T {
        lock()
        defer { unlock() }
        return try operation()
    }
}
