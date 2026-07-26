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
        let configured = Bundle.main.object(forInfoDictionaryKey: "AFTERIMAGE_API_BASE_URL") as? String
        let baseURL = configured.flatMap(URL.init(string:)) ?? URL(string: "http://127.0.0.1:8787")!
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
            try await refreshTimeline()
        } catch {
            try? sessionStore.clear()
            await api.setBearerToken(nil)
            isAuthenticated = false
        }
    }

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

    func signOut() {
        uploadTask?.cancel()
        uploadTask = nil
        upload = nil
        try? sessionStore.clear()
        Task { await api.setBearerToken(nil) }
        assets = []
        nextCursor = nil
        isAuthenticated = false
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

    func playbackURL(for asset: Asset) async throws -> URL {
        try await api.playbackURL(assetID: asset.id)
    }

    private func process(item: PhotosPickerItem, current: Int, total: Int) async throws {
        upload = UploadPresentation(stage: .importing, progress: 0.02, current: current, total: total)
        let imported = try await MediaImporter.load(item)
        var optimized: OptimizedMedia?
        var remoteAssetID: String?
        var uploadCompleted = false
        defer {
            imported.removeTemporaryFile()
            optimized?.removeTemporaryFiles()
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
            upload = UploadPresentation(stage: .uploading, progress: 0.50, current: current, total: total)
            let ready = try await uploader.upload(
                media: optimized,
                assetID: created.asset.id,
                plan: created.upload
            ) { [weak self] value in
                Task { @MainActor in
                    guard let self else { return }
                    self.upload?.progress = 0.50 + value * 0.44
                }
            }
            uploadCompleted = true
            upload = UploadPresentation(stage: .finishing, progress: 0.96, current: current, total: total)
            try? await api.uploadThumbnail(optimized.thumbnailURL, assetID: ready.id)
            try await refreshTimeline()
            haptics.play(.success)
        } catch {
            if let remoteAssetID, !uploadCompleted {
                try? await api.deleteAsset(assetID: remoteAssetID)
            }
            if error is CancellationError { throw AfterimageError.cancelled }
            throw error
        }
    }

    private func show(error: Error) {
        let message = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        notice = AppNotice(title: "うまくいきませんでした", message: message)
    }
}
