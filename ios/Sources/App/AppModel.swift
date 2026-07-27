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
    case importing
    case compressing(MediaKind)
    case uploading
    case finishing

    var title: String {
        switch self {
        case .importing: "記憶を受け取っています"
        case .compressing(.video): "音をそのままに、動画を軽くしています"
        case .compressing(.image): "写真をきれいに整えています"
        case .uploading: "あなたのafterimageへ保存しています"
        case .finishing: "あと少しです"
        }
    }
}

struct UploadPresentation: Equatable {
    var stage: UploadStage
    var progress: Double
    var current: Int
    var total: Int
}

@MainActor
final class AppModel: ObservableObject {
    @Published private(set) var isAuthenticated = false
    @Published private(set) var isBootstrapping = true
    @Published private(set) var assets: [Asset] = []
    @Published private(set) var isLoadingTimeline = false
    @Published var upload: UploadPresentation?
    @Published var notice: AppNotice?

    private let api: APIClient
    private let uploader: MediaUploader
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
        self.uploader = MediaUploader(api: api)
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
        uploadTask?.cancel()
        uploadTask = nil
        upload = nil
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
        guard !items.isEmpty, uploadTask == nil else { return }
        haptics.play(.lift)
        uploadTask = Task { [weak self] in
            guard let self else { return }
            for (index, item) in items.enumerated() {
                if Task.isCancelled { break }
                do {
                    try await self.process(item: item, current: index + 1, total: items.count)
                } catch {
                    if !Task.isCancelled {
                        self.haptics.play(.failure)
                        self.show(error: error)
                    }
                    break
                }
            }
            self.upload = nil
            self.uploadTask = nil
        }
    }

    func cancelUpload() {
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

    private func process(item: PhotosPickerItem, current: Int, total: Int) async throws {
        upload = UploadPresentation(stage: .importing, progress: 0.02, current: current, total: total)
        let imported = try await MediaImporter.load(item)
        var optimized: OptimizedMedia?
        var remoteAssetID: String?
        defer {
            imported.removeTemporaryFile()
        }

        do {
            upload = UploadPresentation(stage: .compressing(imported.kind), progress: 0.04, current: current, total: total)
            optimized = try await compressor.optimize(imported) { [weak self] value in
                Task { @MainActor in
                    guard let self else { return }
                    self.upload?.progress = 0.04 + value * 0.46
                }
            }
            try Task.checkCancellation()
            guard let optimized else { throw AfterimageError.compressionFailed("出力を確認できませんでした。") }

            let created = try await api.createAsset(CreateAssetRequest(
                mediaType: optimized.kind,
                filename: optimized.filename,
                contentType: optimized.contentType,
                byteSize: optimized.byteSize,
                width: optimized.width,
                height: optimized.height,
                durationMs: optimized.durationMs,
                capturedAt: optimized.capturedAt
            ))
            remoteAssetID = created.asset.id

            // Hand off to background upload so it survives app suspension.
            upload = UploadPresentation(stage: .uploading, progress: 0.50, current: current, total: total)
            let liveActivity = UploadLiveActivityManager.shared
            liveActivity.start(
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
                isComplete: false
            )

            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                BackgroundUploadManager.shared.startUpload(
                    items: [uploadItem],
                    progress: { [weak self] _, progress, itemCurrent, itemTotal in
                        Task { @MainActor in
                            guard let self else { return }
                            self.upload?.progress = 0.50 + progress * 0.44
                            liveActivity.update(
                                stage: UploadStage.uploading.title,
                                progress: 0.50 + progress * 0.44,
                                current: itemCurrent,
                                total: itemTotal
                            )
                        }
                    },
                    completion: { [weak self] result in
                        Task { @MainActor in
                            guard let self else { return }
                            switch result {
                            case .success:
                                // R2 transfer done — finalize via API.
                                self.upload = UploadPresentation(stage: .finishing, progress: 0.96, current: current, total: total)
                                liveActivity.update(stage: UploadStage.finishing.title, progress: 0.96, current: current, total: total)
                                do {
                                    _ = try await self.api.completeUpload(assetID: created.asset.id)
                                    if let thumbURL = optimized?.thumbnailURL {
                                        try? await self.api.uploadThumbnail(thumbURL, assetID: created.asset.id)
                                    }
                                    optimized?.removeTemporaryFiles()
                                    liveActivity.end()
                                    try? await self.refreshTimeline()
                                    self.haptics.play(.success)
                                    self.upload = nil
                                    self.uploadTask = nil
                                    continuation.resume()
                                } catch {
                                    liveActivity.cancel()
                                    continuation.resume(throwing: error)
                                }
                            case .failure(let error):
                                liveActivity.cancel()
                                continuation.resume(throwing: error)
                            }
                        }
                    }
                )
            }
        } catch {
            UploadLiveActivityManager.shared.cancel()
            if let remoteAssetID {
                try? await api.deleteAsset(assetID: remoteAssetID)
            }
            if error is CancellationError { throw AfterimageError.cancelled }
            throw error
        }
    }

    private func clearLocalSession() {
        try? sessionStore.clear()
        assets = []
        nextCursor = nil
        isAuthenticated = false
    }

    private func show(error: Error) {
        let message = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        notice = AppNotice(title: "うまくいきませんでした", message: message)
    }
}
