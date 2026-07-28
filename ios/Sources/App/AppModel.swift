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
    @Published private(set) var isAuthenticated = false
    @Published private(set) var isBootstrapping = true
    @Published private(set) var assets: [Asset] = []
    @Published private(set) var isLoadingTimeline = false
    @Published var upload: UploadPresentation?
    @Published private(set) var importSelectionSummary: ImportSelectionSummary?
    @Published var notice: AppNotice?

    private let api: APIClient
    private let compressor: MediaCompressor
    private let sessionStore: SessionStoring
    private let haptics: HapticEngine
    private var nextCursor: String?
    private var didBootstrap = false
    private var uploadTask: Task<Void, Never>?

    init(
        api: APIClient,
        sessionStore: SessionStoring = KeychainSessionStore(),
        compressor: MediaCompressor = MediaCompressor(),
        haptics: HapticEngine = HapticEngine()
    ) {
        self.api = api
        self.sessionStore = sessionStore
        self.compressor = compressor
        self.haptics = haptics
    }

    static func live() -> AppModel {
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
        do {
            guard let token = try sessionStore.load() else { return }
            await api.setBearerToken(token)
            isAuthenticated = true
            await resumeBackgroundUploadIfNeeded()
            do {
                try await refreshTimeline()
            } catch {
                if (error as? AfterimageError)?.invalidatesSession == true {
                    clearLocalSession()
                    await api.setBearerToken(nil)
                } else {
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
        await api.setBearerToken(token)
        isAuthenticated = true
        do {
            try await refreshTimeline()
        } catch {
            show(error: error)
        }
    }
    #endif

    func signIn(credential: ASAuthorizationAppleIDCredential) async {
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
            let response = try await api.signIn(identityToken: identityToken, displayName: displayName)
            try sessionStore.save(response.token)
            await api.setBearerToken(response.token)
            isAuthenticated = true
            haptics.play(.success)
            try await refreshTimeline()
        } catch {
            haptics.play(.failure)
            show(error: error)
        }
    }

    func signOut() async {
        BackgroundUploadManager.shared.cancelAll()
        uploadTask?.cancel()
        uploadTask = nil
        upload = nil
        importSelectionSummary = nil
        clearLocalSession()
        try? await api.revokeSession()
        haptics.play(.selection)
    }

    func refreshTimeline() async throws {
        guard !isLoadingTimeline else { return }
        isLoadingTimeline = true
        defer { isLoadingTimeline = false }
        let page = try await api.timeline()
        assets = page.assets.filter { $0.status == .ready }
        nextCursor = page.nextCursor
    }

    func loadMoreIfNeeded(after asset: Asset) async {
        guard asset.id == assets.last?.id, let cursor = nextCursor, !isLoadingTimeline else { return }
        isLoadingTimeline = true
        defer { isLoadingTimeline = false }
        do {
            let page = try await api.timeline(cursor: cursor)
            let existing = Set(assets.map(\.id))
            assets.append(contentsOf: page.assets.filter { $0.status == .ready && !existing.contains($0.id) })
            nextCursor = page.nextCursor
        } catch {
            show(error: error)
        }
    }

    func importItems(_ items: [PhotosPickerItem]) {
        guard !items.isEmpty,
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
                    for (position, index) in plan.uploadIndexes.enumerated() {
                        if Task.isCancelled { break }
                        do {
                            try await self.process(
                                item: items[index],
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
                            if !Task.isCancelled {
                                self.haptics.play(.failure)
                                self.show(error: error)
                            }
                            break
                        }
                    }
                }
            } catch {
                if !Task.isCancelled {
                    self.haptics.play(.failure)
                    self.show(error: error)
                }
            }

            self.upload = nil
            self.uploadTask = nil
        }
    }

    func cancelUpload() {
        BackgroundUploadManager.shared.cancelAll()
        uploadTask?.cancel()
        haptics.play(.delete)
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
        try await api.thumbnailData(assetID: asset.id)
    }

    func photoData(for asset: Asset) async throws -> Data {
        try await api.contentData(assetID: asset.id)
    }

    func playbackGrant(for asset: Asset) async throws -> ResolvedPlaybackGrant {
        try await api.playbackGrant(assetID: asset.id)
    }

    func dailyPlayback(in interval: DateInterval) async throws -> DailyPlaybackResponse {
        try await api.dailyPlayback(startAt: interval.start, endAt: interval.end)
    }

    func transcript(for asset: Asset) async throws -> TranscriptResponse {
        try await api.transcript(assetID: asset.id)
    }

    func transcript(for asset: Asset) async throws -> AssetTranscript {
        try await api.transcript(assetID: asset.id)
    }

    func mcpEndpoint() async throws -> URL {
        try await api.mcpEndpoint()
    }

    func mcpTokens() async throws -> [MCPToken] {
        try await api.mcpTokens()
    }

    func createMCPToken(name: String) async throws -> MCPTokenCreationResponse {
        try await api.createMCPToken(name: name)
    }

    func revokeMCPToken(id: String) async throws {
        try await api.revokeMCPToken(id: id)
        haptics.play(.delete)
    }

    private func process(
        item: PhotosPickerItem,
        identity: ImportIdentity?,
        current: Int,
        total: Int
    ) async throws {
        upload = UploadPresentation(stage: .importing, progress: 0.02, current: current, total: total)
        let imported = try await MediaImporter.load(item)
        var optimized: OptimizedMedia?
        var remoteAssetID: String?
        var activityID: String?
        var didHandOff = false
        defer { imported.removeTemporaryFile() }

        do {
            upload = UploadPresentation(stage: .compressing(imported.kind), progress: 0.04, current: current, total: total)
            optimized = try await compressor.optimize(imported) { [weak self] value in
                Task { @MainActor in
                    self?.upload?.progress = 0.04 + value * 0.46
                }
            }
            try Task.checkCancellation()
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
                capturedAt: optimized.capturedAt
            ))
            remoteAssetID = created.asset.id
            let context = try await api.backgroundUploadContext()

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
                            Task { @MainActor in
                                self?.upload?.progress = 0.50 + progress * 0.44
                            }
                        },
                        completion: { result in
                            Task { @MainActor [weak self] in
                                guard let self else {
                                    continuation.resume(throwing: AfterimageError.cancelled)
                                    return
                                }
                                switch result {
                                case .success:
                                    try? await self.refreshTimeline()
                                    self.haptics.play(.success)
                                    continuation.resume()
                                case .failure(let error):
                                    continuation.resume(throwing: error)
                                }
                            }
                        }
                    )
                    didHandOff = true
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

            if !didHandOff {
                optimized?.removeTemporaryFiles()
                UploadLiveActivityManager.shared.cancel(activityID: activityID)
            }
            if let remoteAssetID, !didHandOff || wasCancelled {
                try? await api.deleteAsset(assetID: remoteAssetID)
            }
            if wasCancelled { throw AfterimageError.cancelled }
            throw error
        }
    }

    private func resumeBackgroundUploadIfNeeded() async {
        guard let context = try? await api.backgroundUploadContext() else { return }
        let resumed = BackgroundUploadManager.shared.resumePendingUpload(
            context: context,
            progress: { [weak self] _, progress, current, total in
                Task { @MainActor in
                    guard let self else { return }
                    self.upload = UploadPresentation(
                        stage: .uploading,
                        progress: 0.50 + progress * 0.44,
                        current: current,
                        total: total
                    )
                }
            },
            completion: { [weak self] result in
                Task { @MainActor in
                    guard let self else { return }
                    self.upload = nil
                    switch result {
                    case .success:
                        try? await self.refreshTimeline()
                        self.haptics.play(.success)
                    case .failure(let error):
                        self.show(error: error)
                    }
                }
            }
        )
        if resumed, upload == nil {
            upload = UploadPresentation(stage: .uploading, progress: 0.50, current: 1, total: 1)
        }
    }

    private func updateImportSelectionSummary(selectedCount: Int, skippedCount: Int) {
        importSelectionSummary = skippedCount > 0
            ? ImportSelectionSummary(selectedCount: selectedCount, skippedCount: skippedCount)
            : nil
    }

    private func clearLocalSession() {
        try? sessionStore.clear()
        assets = []
        nextCursor = nil
        isAuthenticated = false
    }

    private func show(error: Error) {
        let message = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        notice = AppNotice(title: L10n.string("error.generic_title"), message: message)
    }
}
