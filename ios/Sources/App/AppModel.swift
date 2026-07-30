import AuthenticationServices
import Foundation
import PhotosUI
import SwiftUI

struct AppNotice: Identifiable, Equatable {
    let id = UUID()
    let title: String
    let message: String
}

enum UploadStage: Equatable {
    case checking
    case importing
    case compressing(MediaKind)
    case uploading
    case finishing

    var title: String {
        switch self {
        case .checking: L10n.string("upload.stage.checking")
        case .importing: L10n.string("upload.stage.importing")
        case .compressing(.video): L10n.string("upload.stage.compressing_video")
        case .compressing(.image): L10n.string("upload.stage.compressing_photo")
        case .uploading: L10n.string("upload.stage.uploading")
        case .finishing: L10n.string("upload.stage.finishing")
        }
    }
}

struct UploadPresentation: Equatable {
    var stage: UploadStage
    var progress: Double
    var current: Int
    var total: Int
    var preview: UploadPreviewDescriptor? = nil

    mutating func beginFinalizing() {
        stage = .finishing
        progress = 1
        preview = nil
    }
}

enum UploadHandoffGate {
    static func checkCancellation() throws {
        try Task.checkCancellation()
    }
}

enum UploadCancellationCleanup {
    static func run(_ operation: @escaping @Sendable () async -> Void) async {
        let cleanup = Task.detached {
            await operation()
        }
        await cleanup.value
    }
}

enum TimelineLoadState: Equatable {
    case loading
    case loaded
    case failed
}

struct ImportSelectionSummary: Equatable {
    let selectedCount: Int
    let skippedCount: Int

    var uploadCount: Int { max(0, selectedCount - skippedCount) }

    var title: String {
        if uploadCount == 0 {
            return L10n.format("upload.duplicates.all_title", Int64(selectedCount))
        }
        return L10n.format(
            "upload.duplicates.partial_title",
            Int64(selectedCount),
            Int64(skippedCount)
        )
    }

    var detail: String {
        if uploadCount == 0 {
            return L10n.string("upload.duplicates.all_detail")
        }
        return L10n.format("upload.duplicates.partial_detail", Int64(uploadCount))
    }
}

@MainActor
final class AppModel: ObservableObject {
    private struct AuthScope: Equatable, Sendable {
        let ownerID: String
        let generationID: UUID
    }

    private struct TimelineRefresh {
        let id: UUID
        let authScope: AuthScope
        let task: Task<Void, Error>
    }

    @Published private(set) var isAuthenticated = false
    @Published private(set) var isBootstrapping = true
    @Published private(set) var assets: [Asset] = []
    @Published private(set) var dailyWeather: [String: DailyWeather] = [:]
    @Published private(set) var isLoadingTimeline = false
    @Published private(set) var timelineLoadState: TimelineLoadState = .loading
    @Published private(set) var isLoadingMore = false
    @Published private(set) var paginationFailed = false
    @Published private(set) var timelineGeneration = 0
    @Published private(set) var transientNotice: String?
    @Published private(set) var isDiscardingBackgroundUpload = false
    @Published var upload: UploadPresentation?
    @Published private(set) var importSelectionSummary: ImportSelectionSummary?
    @Published private(set) var backgroundUploadNeedsRetry = false
    @Published private(set) var localCleanupNeedsRetry = false
    @Published private(set) var aiConsent: AIConsent?
    @Published private(set) var isUpdatingAIConsent = false
    @Published private(set) var accountDeletionState: AccountDeletionState = .idle
    @Published var notice: AppNotice?

    private let api: APIClient
    private let authGeneration: AuthGenerationGate
    private let compressor: MediaCompressor
    private let sessionStore: SessionStoring
    private let accountDeletionCleanupStore: AccountDeletionCleanupStoring
    private let haptics: HapticEngine
    private let weatherRecorder: WeatherKitDailyWeatherRecorder
    private let postReminderScheduler: DailyPostReminderScheduler
    private var nextCursor: String?
    private var didBootstrap = false
    private var currentSession: StoredSession?
    private var uploadTask: Task<Void, Never>?
    private var discardsPendingUploadOnRetry = false
    private var pendingAccountDeletionAuthorizationCode: String?
    private var isRecordingDailyWeather = false
    private var shouldRepeatDailyWeatherRecording = false
    private var authScopeGeneration = UUID()
    private var authScope: AuthScope?
    private var timelineRefresh: TimelineRefresh?
    private var transientNoticeTask: Task<Void, Never>?

    var hasActiveBackgroundUpload: Bool {
        uploadTask != nil
            || isDiscardingBackgroundUpload
            || BackgroundUploadManager.shared.hasPendingUpload
    }

    var hasPersistedBackgroundUpload: Bool {
        BackgroundUploadManager.shared.hasPendingUpload
    }

    var requiresCancellationCleanup: Bool {
        BackgroundUploadManager.shared.requiresCancellationCleanup
    }

    init(
        api: APIClient,
        authGeneration: AuthGenerationGate = .shared,
        sessionStore: SessionStoring = KeychainSessionStore(),
        accountDeletionCleanupStore: AccountDeletionCleanupStoring =
            AccountDeletionCleanupStore(),
        compressor: MediaCompressor = MediaCompressor(),
        haptics: HapticEngine = HapticEngine(),
        weatherRecorder: WeatherKitDailyWeatherRecorder = WeatherKitDailyWeatherRecorder(),
        postReminderScheduler: DailyPostReminderScheduler = DailyPostReminderScheduler()
    ) {
        self.api = api
        self.authGeneration = authGeneration
        self.sessionStore = sessionStore
        self.accountDeletionCleanupStore = accountDeletionCleanupStore
        self.compressor = compressor
        self.haptics = haptics
        self.weatherRecorder = weatherRecorder
        self.postReminderScheduler = postReminderScheduler
    }

    static func live() -> AppModel {
        do {
            try CameraTemporaryFileStore.purgeOrphans()
        } catch {
        }
        #if DEBUG
        let arguments = ProcessInfo.processInfo.arguments
        if let index = arguments.firstIndex(of: "-afterimageApiBase"),
           arguments.indices.contains(index + 1),
           let url = URL(string: arguments[index + 1]) {
            return AppModel(api: APIClient(baseURL: url))
        }
        #endif
        let configured = Bundle.main.object(forInfoDictionaryKey: "AFTERIMAGE_API_BASE_URL") as? String
        let baseURL = configured.flatMap(URL.init(string:)) ?? URL(string: "https://afterimage.2-38.com")!
        return AppModel(api: APIClient(baseURL: baseURL))
    }

    func bootstrap() async {
        guard !didBootstrap else { return }
        didBootstrap = true
        defer { isBootstrapping = false }
        await installSessionTerminationHandler()
        if accountDeletionCleanupStore.pendingGenerationID != nil {
            accountDeletionState = .cleaningLocalData
            discardsPendingUploadOnRetry = true
            let cleanupSucceeded = await finishAcceptedAccountDeletionCleanup()
            if cleanupSucceeded {
                accountDeletionState = .completed
                localCleanupNeedsRetry = false
                discardsPendingUploadOnRetry = false
            } else {
                accountDeletionState = .localCleanupFailed
                localCleanupNeedsRetry = true
                return
            }
        }
        do {
            guard let session = try sessionStore.load() else {
                if BackgroundUploadManager.shared.requiresCancellationCleanupRetry {
                    localCleanupNeedsRetry = true
                    accountDeletionState = .localCleanupFailed
                }
                return
            }
            try sessionStore.save(session)
            guard await authGeneration.bind(session.context) else {
                _ = try? sessionStore.clear(ifCurrent: session.context)
                return
            }
            currentSession = session
            await api.setSession(session)
            let user = try await api.currentUser()
            guard session.context.accountID == nil
                    || session.context.accountID == user.id else {
                await clearLocalSession(ifCurrent: session.context)
                throw AfterimageError.invalidResponse
            }
            if session.context.accountID == nil {
                let resolvedSession = StoredSession(
                    token: session.token,
                    context: AuthSessionContext(
                        generationID: session.context.generationID,
                        accountID: user.id
                    )
                )
                try sessionStore.save(resolvedSession)
                await authGeneration.unbind(ifCurrent: session.context)
                guard await authGeneration.bind(resolvedSession.context) else {
                    throw AfterimageError.invalidResponse
                }
                currentSession = resolvedSession
                await api.setSession(resolvedSession)
            }
            guard await beginAuthGeneration(
                ownerID: user.id,
                cleanupContext: nil,
                cleanupPendingUpload: false
            ) else { return }
            accountDeletionState = .idle
            isAuthenticated = true
            await resumeBackgroundUploadIfNeeded(
                retryAfterFailure: false,
                adoptLegacyOwner: true
            )
            do {
                try await refreshTimeline()
                await refreshAIConsent(showFailure: false)
            } catch {
                if (error as? AfterimageError)?.invalidatesSession != true {
                    show(error: error)
                }
            }
        } catch {
            isAuthenticated = false
            show(error: error)
        }
    }

    #if DEBUG
    /// Debug-only: enter the timeline with an externally issued session token
    /// (e.g. the local seed script) so screenshots can be taken without Apple sign-in.
    func applyDevSessionToken(_ token: String) async {
        guard !didBootstrap else { return }
        didBootstrap = true
        isBootstrapping = false
        await installSessionTerminationHandler()
        let session = StoredSession(
            token: token,
            context: AuthSessionContext(generationID: UUID(), accountID: nil)
        )
        guard await authGeneration.bind(session.context) else { return }
        currentSession = session
        await api.setSession(session)
        do {
            let user = try await api.currentUser()
            let resolvedSession = StoredSession(
                token: token,
                context: AuthSessionContext(
                    generationID: session.context.generationID,
                    accountID: user.id
                )
            )
            await authGeneration.unbind(ifCurrent: session.context)
            guard await authGeneration.bind(resolvedSession.context) else { return }
            currentSession = resolvedSession
            await api.setSession(resolvedSession)
            guard await beginAuthGeneration(
                ownerID: user.id,
                cleanupContext: nil,
                cleanupPendingUpload: false
            ) else { return }
        } catch {
            show(error: error)
            return
        }
        accountDeletionState = .idle
        isAuthenticated = true
        await resumeBackgroundUploadIfNeeded(
            retryAfterFailure: false,
            adoptLegacyOwner: true
        )
        do {
            try await refreshTimeline()
            await refreshAIConsent(showFailure: false)
        } catch {
            show(error: error)
        }
    }
    #endif

    func prepareAppleAuthorization() async -> AppleAuthRequestBinding? {
        do {
            return try AppleAuthRequestPolicy.binding(
                challenge: try await api.appleAuthChallenge()
            )
        } catch {
            show(error: error)
            return nil
        }
    }

    func presentAppleAuthorizationError(_ error: Error) {
        if let authorizationError = error as? ASAuthorizationError,
           authorizationError.code == .canceled {
            return
        }
        show(error: error)
    }

    func signIn(
        credential: ASAuthorizationAppleIDCredential,
        challengeID: String
    ) async {
        guard let tokenData = credential.identityToken,
              let identityToken = String(data: tokenData, encoding: .utf8) else {
            show(error: AfterimageError.missingCredential)
            return
        }
        let displayName: String?
        if let fullName = credential.fullName {
            let formatter = PersonNameComponentsFormatter()
            let value = formatter.string(from: fullName).trimmingCharacters(in: .whitespacesAndNewlines)
            displayName = value.isEmpty ? nil : value
        } else {
            displayName = nil
        }

        do {
            let response = try await api.signIn(
                identityToken: identityToken,
                challengeID: challengeID,
                displayName: displayName
            )
            try await establishSession(response)
            let cleanupContext = try await api.backgroundUploadContext()
            let manager = BackgroundUploadManager.shared
            let shouldDiscardPendingUpload = manager.hasPendingUpload
                && manager.pendingOwnerID != response.user.id
            guard await beginAuthGeneration(
                ownerID: response.user.id,
                cleanupContext: cleanupContext,
                cleanupPendingUpload: shouldDiscardPendingUpload
            ) else {
                _ = try? await refreshTimeline()
                haptics.play(.failure)
                return
            }
            await resumeBackgroundUploadIfNeeded(retryAfterFailure: false)
            haptics.play(.success)
            try await refreshTimeline()
            await refreshAIConsent(showFailure: false)
        } catch {
            haptics.play(.failure)
            show(error: error)
        }
    }

    func signOut() async {
        guard let session = currentSession else { return }
        importSelectionSummary = nil
        backgroundUploadNeedsRetry = false
        localCleanupNeedsRetry = false
        notice = nil

        let previousOwnerID = authScope?.ownerID
        let cleanupContext = try? await api.backgroundUploadContext()
        let cleanupSucceeded = await beginAuthGeneration(
            ownerID: nil,
            cleanupContext: cleanupContext,
            cleanupPendingUpload: true
        )
        guard cleanupSucceeded else {
            restoreAuthGeneration(ownerID: previousOwnerID)
            haptics.play(.failure)
            return
        }

        do {
            try await api.revokeSession()
        } catch {
            guard currentSession?.context == session.context,
                  await authGeneration.currentContext() == session.context else {
                return
            }
            restoreAuthGeneration(ownerID: previousOwnerID)
            haptics.play(.failure)
            show(error: error)
            return
        }
        await clearLocalSession(ifCurrent: session.context)
        backgroundUploadNeedsRetry = false
        haptics.play(.selection)
    }

    func refreshTimeline() async throws {
        guard let authScope else { throw AfterimageError.missingCredential }
        if let timelineRefresh, timelineRefresh.authScope == authScope {
            try await awaitTimelineRefresh(timelineRefresh)
            return
        }
        try await awaitTimelineRefresh(startTimelineRefresh(authScope: authScope))
    }

    func refreshTimelineEnsuringFresh() async throws {
        guard let authScope else { throw AfterimageError.missingCredential }
        if let timelineRefresh, timelineRefresh.authScope == authScope {
            _ = try? await awaitTimelineRefresh(timelineRefresh)
        }
        guard isCurrentAuthScope(authScope) else { throw CancellationError() }
        try await awaitTimelineRefresh(startTimelineRefresh(authScope: authScope))
    }

    func refreshTimelineReportingFailure() async {
        do {
            try await refreshTimeline()
        } catch {
            if await handleIfSessionExpired(error) { return }
            showTransient(L10n.string("timeline.refresh_failed"))
        }
    }

    private func startTimelineRefresh(authScope: AuthScope) -> TimelineRefresh {
        let id = UUID()
        let task = Task { @MainActor [weak self] in
            guard let self else { throw CancellationError() }
            try await self.fetchTimeline(authScope: authScope)
        }
        let refresh = TimelineRefresh(id: id, authScope: authScope, task: task)
        timelineRefresh = refresh
        return refresh
    }

    private func awaitTimelineRefresh(_ refresh: TimelineRefresh) async throws {
        defer {
            if timelineRefresh?.id == refresh.id {
                timelineRefresh = nil
            }
        }
        try await refresh.task.value
    }

    private func fetchTimeline(authScope: AuthScope) async throws {
        guard isCurrentAuthScope(authScope) else { throw CancellationError() }
        isLoadingTimeline = true
        defer {
            if isCurrentAuthScope(authScope) {
                isLoadingTimeline = false
            }
        }
        do {
            let page = try await api.timeline()
            guard isCurrentAuthScope(authScope), !Task.isCancelled else {
                throw CancellationError()
            }
            let readyAssets = page.assets.filter { $0.status == .ready }
            assets = readyAssets
            nextCursor = page.nextCursor
            timelineLoadState = .loaded
            paginationFailed = false
            timelineGeneration += 1
            await loadDailyWeather(for: readyAssets, authScope: authScope)
            guard isCurrentAuthScope(authScope), !Task.isCancelled else {
                throw CancellationError()
            }
            await postReminderScheduler.refresh(
                observedLastPostedAt: readyAssets.map(\.createdAt).max()
            )
        } catch {
            if await handleIfSessionExpired(error) { throw error }
            if isCurrentAuthScope(authScope), assets.isEmpty {
                timelineLoadState = .failed
            }
            throw error
        }
    }

    func loadMoreIfNeeded(after asset: Asset) async {
        guard let authScope,
              asset.id == assets.last?.id,
              let cursor = nextCursor,
              !paginationFailed,
              !isLoadingMore,
              !isLoadingTimeline else { return }
        isLoadingMore = true
        defer {
            if isCurrentAuthScope(authScope) {
                isLoadingMore = false
            }
        }
        do {
            let page = try await api.timeline(cursor: cursor)
            guard isCurrentAuthScope(authScope), !Task.isCancelled else { return }
            let existing = Set(assets.map(\.id))
            let additions = page.assets.filter { $0.status == .ready && !existing.contains($0.id) }
            assets.append(contentsOf: additions)
            nextCursor = page.nextCursor
            await loadDailyWeather(for: additions, authScope: authScope)
            await recordTodayWeather()
        } catch {
            if await handleIfSessionExpired(error) { return }
            paginationFailed = true
        }
    }

    func retryPagination() async {
        paginationFailed = false
        guard let last = assets.last else { return }
        await loadMoreIfNeeded(after: last)
    }

    func weather(for day: Date) -> DailyWeather? {
        dailyWeather[DailyWeatherDate.localDate(for: day)]
    }

    func recordTodayWeather() async {
        guard isAuthenticated else { return }
        guard !isRecordingDailyWeather else {
            shouldRepeatDailyWeatherRecording = true
            return
        }
        isRecordingDailyWeather = true
        defer { isRecordingDailyWeather = false }

        repeat {
            shouldRepeatDailyWeatherRecording = false
            await recordCurrentDailyWeatherIfNeeded()
            await backfillMissingDailyWeather()
        } while shouldRepeatDailyWeatherRecording
    }

    private func recordCurrentDailyWeatherIfNeeded() async {
        let localDate = DailyWeatherDate.localDate(for: .now)
        if dailyWeather[localDate] != nil { return }
        if let existing = try? await withSessionInvalidation({
            try await api.dailyWeather(in: localDate...localDate)
        }),
           let weather = existing.first {
            mergeDailyWeather([weather])
            return
        }
        guard isAuthenticated else { return }
        guard let draft = try? await weatherRecorder.snapshot(),
              let weather = try? await withSessionInvalidation({
                  try await api.saveDailyWeather(draft)
              }) else { return }
        mergeDailyWeather([weather])
    }

    private func backfillMissingDailyWeather() async {
        guard isAuthenticated else { return }
        let requests = DailyWeatherBackfillPlan.requests(
            assets: assets,
            storedLocalDates: Set(dailyWeather.keys)
        )
        let weather = await DailyWeatherBackfillExecutor.execute(
            requests: requests,
            existingWeather: { [self] localDate in
                let existing = try await withSessionInvalidation {
                    try await api.dailyWeather(in: localDate...localDate)
                }
                return existing.first
            },
            snapshot: { [weatherRecorder] request in
                try await weatherRecorder.snapshot(for: request)
            },
            save: { [self] draft in
                try await withSessionInvalidation {
                    try await api.saveDailyWeather(draft)
                }
            }
        )
        guard isAuthenticated else { return }
        mergeDailyWeather(weather)
    }

    private func loadDailyWeather(for assets: [Asset], authScope: AuthScope) async {
        guard let range = DailyWeatherDate.range(for: assets.map(\.capturedAt)) else { return }
        do {
            let weather = try await api.dailyWeather(in: range)
            guard isCurrentAuthScope(authScope) else { return }
            mergeDailyWeather(weather)
        } catch {
            _ = await handleIfSessionExpired(error)
        }
    }

    private func mergeDailyWeather(_ weather: [DailyWeather]) {
        for item in weather {
            dailyWeather[item.localDate] = item
        }
    }

    var canAddMedia: Bool {
        isAuthenticated
            && accountDeletionState == .idle
            && uploadTask == nil
            && !localCleanupNeedsRetry
            && !BackgroundUploadManager.shared.hasPendingUpload
    }

    func importItems(_ items: [PhotosPickerItem]) {
        guard !items.isEmpty,
              let authScope,
              canAddMedia,
              !hasActiveBackgroundUpload,
              uploadTask == nil,
              !BackgroundUploadManager.shared.hasPendingUpload else { return }
        haptics.play(.lift)
        importSelectionSummary = nil
        upload = UploadPresentation(stage: .checking, progress: 0.01, current: 0, total: items.count)
        uploadTask = Task { [weak self] in
            guard let self else { return }
            let identities = items.map { MediaImporter.identity(for: $0) }

            do {
                let candidates = ImportSelectionPolicy.candidates(from: identities)
                let existing = try await self.api.existingSourceFingerprints(for: candidates)
                let plan = ImportSelectionPolicy.plan(identities: identities, existing: existing)
                var skippedCount = plan.skippedCount
                self.updateImportSelectionSummary(
                    selectedCount: items.count,
                    skippedCount: skippedCount
                )

                if plan.uploadIndexes.isEmpty {
                    self.haptics.play(.selection)
                } else {
                    var failedItemCount = 0
                    for (position, index) in plan.uploadIndexes.enumerated() {
                        if Task.isCancelled { break }
                        do {
                            self.upload = UploadPresentation(
                                stage: .importing,
                                progress: 0.02,
                                current: position + 1,
                                total: plan.uploadIndexes.count
                            )
                            let media: ImportedMedia
                            do {
                                media = try await MediaImporter.load(items[index])
                            } catch {
                                if Task.isCancelled { break }
                                failedItemCount += 1
                                continue
                            }
                            try await self.process(
                                media: media,
                                identity: identities[index],
                                current: position + 1,
                                total: plan.uploadIndexes.count
                            )
                        } catch let error as AfterimageError where error.isDuplicateAsset {
                            skippedCount += 1
                            self.updateImportSelectionSummary(
                                selectedCount: items.count,
                                skippedCount: skippedCount
                            )
                            continue
                        } catch {
                            if Task.isCancelled { break }
                            if Self.isItemScopedFailure(error) {
                                failedItemCount += 1
                                continue
                            }
                            self.haptics.play(.failure)
                            self.show(error: error)
                            break
                        }
                    }
                    if failedItemCount > 0, self.isCurrentAuthScope(authScope) {
                        self.haptics.play(.failure)
                        self.showTransient(
                            L10n.format("upload.batch_failures", Int64(failedItemCount))
                        )
                    }
                }
            } catch {
                if !Task.isCancelled {
                    self.haptics.play(.failure)
                    self.show(error: error)
                }
            }

            if self.isCurrentAuthScope(authScope) {
                self.upload = nil
                self.uploadTask = nil
                self.syncBackgroundUploadRecovery()
            }
        }
    }

    private static func isItemScopedFailure(_ error: Error) -> Bool {
        switch error as? AfterimageError {
        case .unsupportedMedia, .captureDateUnavailable, .compressionFailed:
            return true
        default:
            return false
        }
    }

    @discardableResult
    func importCapturedMedia(_ media: ImportedMedia) -> Bool {
        guard let authScope,
              !hasActiveBackgroundUpload,
              CameraIngestPolicy.canAccept(
            hasUploadTask: uploadTask != nil,
            hasPendingBackgroundUpload: !canAddMedia
        ) else {
            return false
        }
        haptics.play(.lift)
        importSelectionSummary = nil
        upload = UploadPresentation(stage: .importing, progress: 0.02, current: 1, total: 1)
        uploadTask = Task { [weak self] in
            guard let self else { return }
            do {
                try await self.process(
                    media: media,
                    identity: nil,
                    current: 1,
                    total: 1
                )
            } catch {
                if !Task.isCancelled {
                    self.haptics.play(.failure)
                    self.show(error: error)
                }
            }
            if self.isCurrentAuthScope(authScope) {
                self.upload = nil
                self.uploadTask = nil
                self.syncBackgroundUploadRecovery()
            }
        }
        return true
    }

    func cancelUpload() async {
        await discardBackgroundUpload()
    }

    func discardBackgroundUpload() async {
        guard !localCleanupNeedsRetry,
              !isDiscardingBackgroundUpload else { return }
        let activeUploadTask = uploadTask
        activeUploadTask?.cancel()
        uploadTask = nil
        upload = nil
        backgroundUploadNeedsRetry = false
        isDiscardingBackgroundUpload = true
        let context = try? await api.backgroundUploadContext()
        let cleanupSucceeded = await BackgroundUploadManager.shared.cancelAllAndWaitForCleanup(
            context: context
        )
        if let activeUploadTask {
            await activeUploadTask.value
        }
        isDiscardingBackgroundUpload = false
        if cleanupSucceeded {
            backgroundUploadNeedsRetry = false
            notice = nil
            haptics.play(.delete)
        } else {
            backgroundUploadNeedsRetry = BackgroundUploadManager.shared.hasPendingUpload
            publishBackgroundUploadRecoveryFailure()
            haptics.play(.failure)
        }
    }

    func resumeBackgroundUpload() async {
        await resumeBackgroundUploadIfNeeded(retryAfterFailure: true)
    }

    func setAgentAccess(_ asset: Asset, enabled: Bool) async -> Bool {
        guard !enabled || AIConsentPolicy.canEnableAgentAccess(consent: aiConsent) else {
            show(error: AfterimageError.api(
                status: 403,
                code: .aiConsentRequired,
                message: "consent required"
            ))
            return false
        }
        do {
            let updated = try await api.setAgentAccess(assetID: asset.id, enabled: enabled)
            guard let index = assets.firstIndex(where: { $0.id == asset.id }) else { return false }
            assets[index] = updated
            haptics.play(.selection)
            return true
        } catch {
            haptics.play(.failure)
            show(error: error)
            return false
        }
    }

    func delete(_ asset: Asset) async -> Bool {
        do {
            try await api.deleteAsset(assetID: asset.id)
            assets.removeAll { $0.id == asset.id }
            haptics.play(.delete)
            return true
        } catch {
            haptics.play(.failure)
            show(error: error)
            return false
        }
    }

    func thumbnailData(for asset: Asset) async throws -> Data {
        try await withSessionInvalidation {
            try await api.thumbnailData(assetID: asset.id)
        }
    }

    func photoData(for asset: Asset) async throws -> Data {
        try await withSessionInvalidation {
            try await api.contentData(assetID: asset.id)
        }
    }

    func playbackGrant(for asset: Asset) async throws -> ResolvedPlaybackGrant {
        try await withSessionInvalidation {
            try await api.playbackGrant(assetID: asset.id)
        }
    }

    func dailyPlayback(in interval: DateInterval) async throws -> DailyPlaybackResponse {
        try await withSessionInvalidation {
            try await api.dailyPlayback(startAt: interval.start, endAt: interval.end)
        }
    }

    func dailySummary(in interval: DateInterval) async throws -> DailySummaryResponse {
        try await withSessionInvalidation {
            try await api.dailySummary(startAt: interval.start, endAt: interval.end)
        }
    }

    func searchMemories(query: String, cursor: String? = nil) async throws -> MemorySearchPage {
        guard let query = MemorySearchPolicy.query(from: query) else {
            throw AfterimageError.invalidConfiguration
        }
        return try await withSessionInvalidation {
            try await api.searchMemories(query: query, cursor: cursor)
        }
    }

    func videoAnalysis(for asset: Asset) async throws -> VideoAnalysisResponse {
        try await withSessionInvalidation {
            try await api.videoAnalysis(assetID: asset.id)
        }
    }

    func transcript(for asset: Asset) async throws -> TranscriptResponse {
        try await withSessionInvalidation {
            try await api.transcript(assetID: asset.id)
        }
    }

    func transcript(for asset: Asset) async throws -> AssetTranscript {
        try await withSessionInvalidation {
            try await api.transcript(assetID: asset.id)
        }
    }

    func mcpEndpoint() async throws -> URL {
        try await withSessionInvalidation {
            try await api.mcpEndpoint()
        }
    }

    func mcpTokens() async throws -> [MCPToken] {
        try await withSessionInvalidation {
            try await api.mcpTokens()
        }
    }

    func createMCPToken(name: String) async throws -> MCPTokenCreationResponse {
        guard AIConsentPolicy.canTransferExternally(consent: aiConsent) else {
            throw AfterimageError.api(
                status: 403,
                code: .aiConsentRequired,
                message: "consent required"
            )
        }
        try await withSessionInvalidation {
            try await api.createMCPToken(name: name)
        }
    }

    func revokeMCPToken(id: String) async throws {
        try await withSessionInvalidation {
            try await api.revokeMCPToken(id: id)
        }
        haptics.play(.delete)
    }

    func legalURL(_ page: LegalPage) async throws -> URL {
        try await api.legalURL(page)
    }

    func refreshAIConsent(showFailure: Bool = true) async {
        do {
            aiConsent = try await api.aiConsent()
        } catch {
            aiConsent = nil
            if showFailure {
                show(error: error)
            }
        }
    }

    @discardableResult
    func updateAIConsent(granted: Bool) async -> Bool {
        guard !isUpdatingAIConsent else { return false }
        isUpdatingAIConsent = true
        defer { isUpdatingAIConsent = false }
        do {
            aiConsent = try await api.updateAIConsent(granted: granted)
            if !granted {
                for index in assets.indices {
                    assets[index].agentAccessEnabled = false
                }
            }
            haptics.play(.selection)
            return true
        } catch {
            haptics.play(.failure)
            show(error: error)
            return false
        }
    }

    func deleteAccount() async {
        guard accountDeletionState != .deleting,
              accountDeletionState != .cleaningLocalData,
              let session = currentSession else {
            return
        }
        accountDeletionState = .deleting
        let authorizationCode = pendingAccountDeletionAuthorizationCode
        pendingAccountDeletionAuthorizationCode = nil
        do {
            try await api.deleteAccount(authorizationCode: authorizationCode)
        } catch {
            if let error = error as? AfterimageError,
               error.requiresAccountDeletionReauthentication {
                accountDeletionState = AccountDeletionPolicy.reduce(
                    .deleting,
                    event: .reauthenticationRequired
                )
                return
            }
            if (error as? AfterimageError)?.invalidatesSession == true {
                accountDeletionState = .idle
                return
            }
            accountDeletionState = AccountDeletionPolicy.reduce(
                .deleting,
                event: .backendFailed(error.localizedDescription)
            )
            haptics.play(.failure)
            return
        }

        accountDeletionState = AccountDeletionPolicy.reduce(
            .deleting,
            event: .backendAccepted
        )
        accountDeletionCleanupStore.markPending(
            generationID: session.context.generationID
        )
        let activeUploadTask = uploadTask
        activeUploadTask?.cancel()
        await clearLocalSession(ifCurrent: session.context)
        let cleanupSucceeded = await finishAcceptedAccountDeletionCleanup(
            activeUploadTask: activeUploadTask
        )
        if cleanupSucceeded {
            accountDeletionState = AccountDeletionPolicy.reduce(
                .cleaningLocalData,
                event: .localCleanupSucceeded
            )
            localCleanupNeedsRetry = false
            discardsPendingUploadOnRetry = false
            haptics.play(.delete)
        } else {
            accountDeletionState = AccountDeletionPolicy.reduce(
                .cleaningLocalData,
                event: .localCleanupFailed
            )
            localCleanupNeedsRetry = true
            haptics.play(.failure)
            show(error: LocalCleanupError.failed)
        }
    }

    func reauthenticateAndDeleteAccount(
        credential: ASAuthorizationAppleIDCredential,
        challengeID: String
    ) async {
        guard accountDeletionState == .reauthenticationRequired,
              let session = currentSession,
              let tokenData = credential.identityToken,
              let identityToken = String(data: tokenData, encoding: .utf8),
              let codeData = credential.authorizationCode,
              let authorizationCode = String(data: codeData, encoding: .utf8),
              !authorizationCode.isEmpty else {
            show(error: AfterimageError.missingCredential)
            return
        }
        do {
            let response = try await api.signIn(
                identityToken: identityToken,
                challengeID: challengeID,
                displayName: nil
            )
            if let expectedAccountID = session.context.accountID {
                try await establishSession(
                    response,
                    expectedAccountID: expectedAccountID
                )
            } else if currentSession?.context != session.context {
                throw AfterimageError.invalidResponse
            }
            pendingAccountDeletionAuthorizationCode = authorizationCode
            accountDeletionState = .idle
            await deleteAccount()
        } catch {
            pendingAccountDeletionAuthorizationCode = nil
            accountDeletionState = .reauthenticationRequired
            haptics.play(.failure)
            show(error: error)
        }
    }

    func retryLocalCleanup() async {
        guard localCleanupNeedsRetry else { return }
        let succeeded: Bool
        if accountDeletionState == .localCleanupFailed
            || discardsPendingUploadOnRetry {
            succeeded = await finishAcceptedAccountDeletionCleanup()
            if succeeded {
                discardsPendingUploadOnRetry = false
                if accountDeletionState == .localCleanupFailed {
                    accountDeletionState = AccountDeletionPolicy.reduce(
                        .localCleanupFailed,
                        event: .localCleanupSucceeded
                    )
                }
            }
        } else {
            succeeded = await BackgroundUploadManager.shared
                .cancelAllAndWaitForCleanup()
        }
        localCleanupNeedsRetry = !succeeded
        if succeeded {
            notice = nil
            upload = nil
        } else {
            show(error: LocalCleanupError.failed)
        }
    }

    private func process(
        media: ImportedMedia,
        identity: ImportIdentity?,
        current: Int,
        total: Int
    ) async throws {
        guard let operationScope = authScope else {
            throw AfterimageError.missingCredential
        }
        var optimized: OptimizedMedia?
        var remoteAssetID: String?
        var activityID: String?
        var didHandOff = false
        defer { media.removeTemporaryFile() }

        do {
            upload = UploadPresentation(stage: .compressing(media.kind), progress: 0.04, current: current, total: total)
            optimized = try await compressor.optimize(media) { [weak self] value in
                Task { @MainActor in
                    guard let self, self.isCurrentAuthScope(operationScope) else { return }
                    self.upload?.progress = 0.04 + value * 0.46
                }
            }
            try Task.checkCancellation()
            guard isCurrentAuthScope(operationScope) else { throw CancellationError() }
            guard let optimized else {
                throw AfterimageError.compressionFailed(L10n.string("compression.output_missing"))
            }

            let created = try await api.createAsset(CreateAssetRequest(
                mediaType: optimized.kind,
                sourceFingerprint: identity?.sourceFingerprint,
                filename: optimized.filename,
                contentType: optimized.contentType,
                byteSize: optimized.byteSize,
                width: optimized.width,
                height: optimized.height,
                durationMs: optimized.durationMs,
                capturedAt: optimized.capturedAt,
                location: optimized.location
            ))
            remoteAssetID = created.asset.id
            try Task.checkCancellation()
            guard isCurrentAuthScope(operationScope) else { throw CancellationError() }
            let context = try await api.backgroundUploadContext()
            guard context.ownerID == operationScope.ownerID else {
                throw CancellationError()
            }
            try UploadHandoffGate.checkCancellation()

            upload = UploadPresentation(stage: .uploading, progress: 0.50, current: current, total: total)
            activityID = UploadLiveActivityManager.shared.start(
                filename: optimized.filename,
                stage: UploadStage.uploading.title,
                current: current,
                total: total
            )

            let uploadItem = BackgroundUploadState.Item(
                assetID: created.asset.id,
                filename: optimized.filename,
                mediaURL: optimized.url,
                thumbnailURL: optimized.thumbnailURL,
                contentType: optimized.contentType,
                byteSize: optimized.byteSize,
                plan: created.upload,
                completedParts: [],
                transferComplete: false
            )

            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                do {
                    try BackgroundUploadManager.shared.startUpload(
                        items: [uploadItem],
                        context: context,
                        activityID: activityID,
                        progress: { [weak self] _, progress, _, _ in
                            guard let self, self.isCurrentAuthScope(operationScope) else { return }
                            self.upload?.progress = 0.50 + progress * 0.44
                            self.upload?.preview =
                                BackgroundUploadManager.shared.currentPreviewDescriptor
                        },
                        completion: { result in
                            Task { @MainActor [weak self] in
                                guard let self else {
                                    continuation.resume(throwing: AfterimageError.cancelled)
                                    return
                                }
                                guard self.isCurrentAuthScope(operationScope) else {
                                    continuation.resume(throwing: AfterimageError.cancelled)
                                    return
                                }
                                switch result {
                                case .success:
                                    self.upload?.beginFinalizing()
                                    await self.postReminderScheduler.recordPost()
                                    try? await self.refreshTimelineEnsuringFresh()
                                    self.haptics.play(.success)
                                    continuation.resume()
                                case .failure(let error):
                                    continuation.resume(throwing: error)
                                }
                            }
                        }
                    )
                    didHandOff = true
                    self.upload?.preview = BackgroundUploadManager.shared.currentPreviewDescriptor
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        } catch {
            let wasCancelled: Bool
            if error is CancellationError {
                wasCancelled = true
            } else if case .some(.cancelled) = error as? AfterimageError {
                wasCancelled = true
            } else {
                wasCancelled = false
            }

            if didHandOff,
               !wasCancelled,
               BackgroundUploadManager.shared.requiresExplicitRetry {
                backgroundUploadNeedsRetry = true
            }

            if !didHandOff {
                optimized?.removeTemporaryFiles()
                UploadLiveActivityManager.shared.cancel(activityID: activityID)
            }
            if let remoteAssetID, !didHandOff || wasCancelled {
                await UploadCancellationCleanup.run { [api] in
                    try? await api.deleteAsset(assetID: remoteAssetID)
                }
            }
            if wasCancelled { throw AfterimageError.cancelled }
            throw error
        }
    }

    func resumeBackgroundUploadIfNeeded(
        retryAfterFailure: Bool = false,
        adoptLegacyOwner: Bool = false
    ) async {
        guard isAuthenticated, let authScope else { return }
        let manager = BackgroundUploadManager.shared
        guard manager.hasPendingUpload else {
            backgroundUploadNeedsRetry = false
            return
        }
        if manager.requiresCancellationCleanup {
            backgroundUploadNeedsRetry = true
            upload = nil
            publishBackgroundUploadRecoveryFailure()
            return
        }
        if manager.requiresExplicitRetry && !retryAfterFailure {
            backgroundUploadNeedsRetry = true
            upload = nil
            if notice == nil {
                notice = AppNotice(
                    title: L10n.string("error.generic_title"),
                    message: L10n.string("api.upload_failed")
                )
            }
            return
        }
        guard uploadTask == nil else {
            _ = manager.resumePendingUpload(retryAfterFailure: retryAfterFailure)
            return
        }
        let context: BackgroundUploadContext
        do {
            context = try await api.backgroundUploadContext()
        } catch {
            backgroundUploadNeedsRetry = true
            show(error: error)
            return
        }
        guard isCurrentAuthScope(authScope),
              context.ownerID == authScope.ownerID else { return }
        let resumed = manager.resumePendingUpload(
            context: context,
            progress: { [weak self] _, progress, current, total in
                guard let self, self.isCurrentAuthScope(authScope) else { return }
                self.upload = UploadPresentation(
                    stage: .uploading,
                    progress: 0.50 + progress * 0.44,
                    current: current,
                    total: total,
                    preview: manager.currentPreviewDescriptor
                )
            },
            completion: { [weak self] result in
                Task { @MainActor in
                    guard let self, self.isCurrentAuthScope(authScope) else { return }
                    self.upload = nil
                    switch result {
                    case .success:
                        self.backgroundUploadNeedsRetry = false
                        await self.postReminderScheduler.recordPost()
                        try? await self.refreshTimelineEnsuringFresh()
                        self.haptics.play(.success)
                    case .failure(let error):
                        if case .some(.cancelled) = error as? AfterimageError {
                            self.syncBackgroundUploadRecovery()
                            return
                        }
                        if (error as? AfterimageError)?.invalidatesSession == true {
                            self.backgroundUploadNeedsRetry = false
                            return
                        }
                        self.backgroundUploadNeedsRetry = true
                        self.show(error: error)
                    }
                    self.syncBackgroundUploadRecovery()
                }
            },
            adoptLegacyOwner: adoptLegacyOwner,
            retryAfterFailure: retryAfterFailure
        )
        if !resumed, manager.hasPendingUpload {
            backgroundUploadNeedsRetry = true
            publishBackgroundUploadRecoveryFailure()
        }
        if resumed, upload == nil {
            backgroundUploadNeedsRetry = false
            upload = UploadPresentation(
                stage: .uploading,
                progress: 0.50,
                current: 1,
                total: 1,
                preview: manager.currentPreviewDescriptor
            )
        } else if !resumed {
            backgroundUploadNeedsRetry = true
            publishBackgroundUploadRecoveryFailure()
        }
    }

    func retryBackgroundUpload() async {
        if BackgroundUploadManager.shared.requiresCancellationCleanup {
            let context = try? await api.backgroundUploadContext()
            isDiscardingBackgroundUpload = true
            let cleanupSucceeded = await BackgroundUploadManager.shared.cancelAllAndWaitForCleanup(
                context: context
            )
            isDiscardingBackgroundUpload = false
            syncBackgroundUploadRecovery()
            if cleanupSucceeded && !backgroundUploadNeedsRetry {
                notice = nil
            } else {
                backgroundUploadNeedsRetry = true
                publishBackgroundUploadRecoveryFailure()
            }
            return
        }
        await resumeBackgroundUploadIfNeeded(retryAfterFailure: true)
        if BackgroundUploadManager.shared.requiresExplicitRetry {
            backgroundUploadNeedsRetry = true
            notice = AppNotice(
                title: L10n.string("error.generic_title"),
                message: L10n.string("api.upload_failed")
            )
        }
    }

    private func updateImportSelectionSummary(selectedCount: Int, skippedCount: Int) {
        importSelectionSummary = skippedCount > 0
            ? ImportSelectionSummary(selectedCount: selectedCount, skippedCount: skippedCount)
            : nil
    }

    private func installSessionTerminationHandler() async {
        await authGeneration.setTerminationHandler { [weak self] context in
            await self?.expireSession(ifCurrent: context)
        }
    }

    private func establishSession(
        _ response: AuthResponse,
        expectedAccountID: String? = nil
    ) async throws {
        if let expectedAccountID, response.user.id != expectedAccountID {
            throw AfterimageError.invalidResponse
        }
        let previousSession = currentSession
        let session = StoredSession(
            token: response.token,
            context: AuthSessionContext(
                generationID: UUID(),
                accountID: response.user.id
            )
        )
        guard await authGeneration.bind(session.context) else {
            throw AfterimageError.invalidResponse
        }
        do {
            try sessionStore.save(session)
        } catch {
            await authGeneration.unbind(ifCurrent: session.context)
            if let previousSession {
                _ = await authGeneration.bind(previousSession.context)
            }
            throw error
        }
        currentSession = session
        await api.setSession(session)
        _ = await beginAuthGeneration(
            ownerID: response.user.id,
            cleanupContext: nil,
            cleanupPendingUpload: false
        )
        accountDeletionState = .idle
        isAuthenticated = true
    }

    private func clearLocalSession(ifCurrent context: AuthSessionContext) async {
        _ = await api.clearSession(ifCurrent: context)
        _ = try? sessionStore.clear(ifCurrent: context)
        await authGeneration.unbind(ifCurrent: context)
        guard currentSession?.context == context else { return }
        currentSession = nil
        uploadTask?.cancel()
        _ = await beginAuthGeneration(
            ownerID: nil,
            cleanupContext: nil,
            cleanupPendingUpload: false
        )
        uploadTask = nil
        upload = nil
        importSelectionSummary = nil
        assets = []
        dailyWeather = [:]
        nextCursor = nil
        timelineLoadState = .loading
        paginationFailed = false
        aiConsent = nil
        pendingAccountDeletionAuthorizationCode = nil
        isAuthenticated = false
        await postReminderScheduler.clear()
    }

    private func beginAuthGeneration(
        ownerID: String?,
        cleanupContext: BackgroundUploadContext?,
        cleanupPendingUpload: Bool
    ) async -> Bool {
        authScopeGeneration = UUID()
        authScope = ownerID.map {
            AuthScope(ownerID: $0, generationID: authScopeGeneration)
        }
        timelineRefresh?.task.cancel()
        timelineRefresh = nil
        isLoadingTimeline = false
        isLoadingMore = false
        transientNoticeTask?.cancel()
        transientNoticeTask = nil
        transientNotice = nil

        guard cleanupPendingUpload else {
            if ownerID == nil {
                uploadTask?.cancel()
                uploadTask = nil
                upload = nil
            }
            syncBackgroundUploadRecovery()
            return true
        }

        let activeUploadTask = uploadTask
        activeUploadTask?.cancel()
        uploadTask = nil
        upload = nil
        importSelectionSummary = nil
        backgroundUploadNeedsRetry = false
        isDiscardingBackgroundUpload = activeUploadTask != nil
            || BackgroundUploadManager.shared.hasPendingUpload
        let cleanupSucceeded = await BackgroundUploadManager.shared.cancelAllAndWaitForCleanup(
            context: cleanupContext
        )
        if let activeUploadTask {
            await activeUploadTask.value
        }
        isDiscardingBackgroundUpload = false
        guard cleanupSucceeded else {
            backgroundUploadNeedsRetry = BackgroundUploadManager.shared.hasPendingUpload
            publishBackgroundUploadRecoveryFailure()
            return false
        }
        backgroundUploadNeedsRetry = false
        notice = nil
        return true
    }

    private func restoreAuthGeneration(ownerID: String?) {
        authScopeGeneration = UUID()
        authScope = ownerID.map {
            AuthScope(ownerID: $0, generationID: authScopeGeneration)
        }
        isAuthenticated = ownerID != nil
        syncBackgroundUploadRecovery()
        if BackgroundUploadManager.shared.hasPendingUpload {
            backgroundUploadNeedsRetry = true
            publishBackgroundUploadRecoveryFailure()
        }
    }

    private func isCurrentAuthScope(_ scope: AuthScope) -> Bool {
        authScope == scope
    }

    private func syncBackgroundUploadRecovery() {
        let manager = BackgroundUploadManager.shared
        backgroundUploadNeedsRetry = manager.requiresExplicitRetry
            || manager.requiresCancellationCleanup
    }

    private func publishBackgroundUploadRecoveryFailure() {
        let message = BackgroundUploadManager.shared.requiresCancellationCleanup
            ? L10n.string("upload.discard_retry")
            : L10n.string("api.upload_failed")
        notice = AppNotice(
            title: L10n.string("error.generic_title"),
            message: message
        )
    }

    private func withSessionInvalidation<T>(
        _ operation: () async throws -> T
    ) async throws -> T {
        do {
            return try await operation()
        } catch {
            _ = await handleIfSessionExpired(error)
            throw error
        }
    }

    @discardableResult
    private func handleIfSessionExpired(_ error: Error) async -> Bool {
        (error as? AfterimageError)?.invalidatesSession == true
    }

    private func expireSession(ifCurrent context: AuthSessionContext) async {
        guard currentSession?.context == context else { return }
        await clearLocalSession(ifCurrent: context)
        backgroundUploadNeedsRetry = BackgroundUploadManager.shared.hasPendingUpload
        notice = AppNotice(
            title: L10n.string("auth.session_expired_title"),
            message: L10n.string("auth.session_expired_message")
        )
    }

    private func finishAcceptedAccountDeletionCleanup(
        activeUploadTask: Task<Void, Never>? = nil
    ) async -> Bool {
        let initialUploadCleanupSucceeded = await BackgroundUploadManager.shared
            .discardAfterAccountDeletionAndWait()
        let uploadCleanupSucceeded: Bool
        if let activeUploadTask {
            await activeUploadTask.value
            uploadCleanupSucceeded = await BackgroundUploadManager.shared
                .discardAfterAccountDeletionAndWait()
        } else {
            uploadCleanupSucceeded = initialUploadCleanupSucceeded
        }
        uploadTask = nil
        upload = nil
        do {
            try LocalMediaFileCleanup.purge()
            await postReminderScheduler.clear()
            let sessionCleanupSucceeded =
                clearPersistedSessionForAcceptedDeletion()
            if uploadCleanupSucceeded && sessionCleanupSucceeded {
                accountDeletionCleanupStore.clear()
                return true
            }
            return false
        } catch {
            return false
        }
    }

    private func clearPersistedSessionForAcceptedDeletion() -> Bool {
        guard let expectedGenerationID =
                accountDeletionCleanupStore.pendingGenerationID else {
            return true
        }
        do {
            guard let storedSession = try sessionStore.load() else {
                return true
            }
            guard storedSession.context.generationID == expectedGenerationID else {
                return true
            }
            return try sessionStore.clear(ifCurrent: storedSession.context)
        } catch {
            return false
        }
    }

    private func show(error: Error) {
        let message = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        notice = AppNotice(title: L10n.string("error.generic_title"), message: message)
    }

    private func showTransient(_ message: String) {
        transientNoticeTask?.cancel()
        transientNotice = message
        transientNoticeTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(4))
            guard !Task.isCancelled else { return }
            self?.transientNotice = nil
        }
    }
}

private enum LocalCleanupError: LocalizedError {
    case failed

    var errorDescription: String? {
        L10n.string("error.local_cleanup_failed")
    }
}
