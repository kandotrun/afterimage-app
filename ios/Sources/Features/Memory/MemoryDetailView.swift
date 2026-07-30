import SwiftUI

struct MemoryDetailView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let asset: Asset
    let standalone: Bool

    @State private var selectedAssetID: String?
    @State private var chromeVisible = true
    @State private var confirmDelete = false
    @State private var showTranscript = false
    @State private var showAnalysis = false
    @State private var requestedSeek: MemorySeekRequest?
    @State private var isUpdatingAgentAccess = false

    init(asset: Asset, standalone: Bool = false, initialSeekMs: Int? = nil) {
        self.asset = asset
        self.standalone = standalone
        _selectedAssetID = State(initialValue: asset.id)
        _requestedSeek = State(
            initialValue: initialSeekMs.map { MemorySeekRequest(assetID: asset.id, startMs: $0) }
        )
    }

    private var pageAssets: [Asset] {
        MemoryPagerPolicy.assets(
            openedAsset: asset,
            timelineAssets: model.assets,
            standalone: standalone
        )
    }

    private var currentAsset: Asset? {
        pageAssets.first { $0.id == selectedAssetID }
    }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            TabView(selection: $selectedAssetID) {
                ForEach(pageAssets) { entry in
                    MemoryPageView(
                        asset: entry,
                        isActive: entry.id == selectedAssetID,
                        chromeVisible: $chromeVisible,
                        showTranscript: $showTranscript,
                        showAnalysis: $showAnalysis,
                        requestedSeek: $requestedSeek
                    )
                    .tag(Optional(entry.id))
                    .task {
                        if !standalone {
                            await model.loadMoreIfNeeded(after: entry)
                        }
                    }
                }
            }
            .tabViewStyle(.page(indexDisplayMode: .never))

            if chromeVisible,
               let location = MemoryPagerPolicy.visibleLocation(
                   currentAsset: currentAsset,
                   openedAsset: asset
               ) {
                VStack {
                    HStack {
                        CaptureLocationChip(location: location)
                        Spacer()
                    }
                    Spacer()
                }
                .padding(.horizontal, 16)
                .padding(.top, 12)
                .transition(.opacity)
            }
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbarColorScheme(.dark, for: .navigationBar)
        .toolbarVisibility(chromeVisible ? .visible : .hidden, for: .navigationBar)
        .statusBarHidden(!chromeVisible)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    if let currentAsset {
                        Text(Self.fileSize(currentAsset.byteSize))
                        if currentAsset.canShareWithAgent {
                            Button {
                                updateAgentAccess(!currentAsset.agentAccessEnabled)
                            } label: {
                                Label {
                                    Text("AIエージェント共有")
                                } icon: {
                                    Image(
                                        systemName: currentAsset.agentAccessEnabled
                                            ? "checkmark.circle.fill"
                                            : "circle"
                                    )
                                }
                            }
                            .disabled(
                                isUpdatingAgentAccess
                                    || (
                                        !currentAsset.agentAccessEnabled
                                            && !AIConsentPolicy.canEnableAgentAccess(
                                                consent: model.aiConsent
                                            )
                                    )
                            )
                            .accessibilityLabel("AIエージェントに共有")
                            .accessibilityValue(currentAsset.agentAccessEnabled ? "オン" : "オフ")
                        }
                        Button("削除", systemImage: "trash", role: .destructive) {
                            confirmDelete = true
                        }
                    }
                } label: {
                    Image(systemName: "ellipsis")
                }
                .accessibilityLabel("その他")
            }
        }
        .sheet(isPresented: $showTranscript) {
            if let currentAsset {
                TranscriptSheet(asset: currentAsset)
            }
        }
        .sheet(isPresented: $showAnalysis) {
            if let currentAsset, currentAsset.mediaType == .video {
                VideoAnalysisSheet(asset: currentAsset) { startMs in
                    requestedSeek = MemorySeekRequest(assetID: currentAsset.id, startMs: startMs)
                }
            }
        }
        .confirmationDialog("この残像を削除しますか？", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("削除", role: .destructive) { deleteCurrent() }
            Button("キャンセル", role: .cancel) {}
        } message: {
            Text("サーバーに保存された写真・動画も完全に削除され、元に戻せません。")
        }
        .onChange(of: model.assets) { _, assets in
            guard !standalone else { return }
            guard currentAsset == nil else { return }
            // A background refresh can drop the current asset from the first
            // page. Fall back to the memory this screen was opened with rather
            // than teleporting to the newest one; dismiss if that is gone too.
            if assets.contains(where: { $0.id == asset.id }) {
                selectedAssetID = asset.id
            } else {
                dismiss()
            }
        }
    }

    private var title: String {
        (currentAsset ?? asset).capturedAt.formatted(.dateTime.month(.wide).day().hour().minute())
    }

    private func updateAgentAccess(_ enabled: Bool) {
        guard let target = currentAsset,
              target.agentAccessEnabled != enabled,
              !isUpdatingAgentAccess else { return }
        isUpdatingAgentAccess = true
        Task {
            _ = await model.setAgentAccess(target, enabled: enabled)
            isUpdatingAgentAccess = false
        }
    }

    private func deleteCurrent() {
        guard let target = currentAsset else { return }
        if standalone {
            Task {
                if await model.delete(target) {
                    dismiss()
                }
            }
            return
        }
        guard let index = model.assets.firstIndex(where: { $0.id == target.id }) else { return }
        let remaining = model.assets.filter { $0.id != target.id }
        let nextID = MemoryPagerPolicy.selectionAfterDeletion(of: index, count: model.assets.count)
            .flatMap { remaining.indices.contains($0) ? remaining[$0].id : nil }
        // Move selection before the row disappears so the assets onChange
        // fallback never has to guess a page.
        if let nextID { selectedAssetID = nextID }
        Task {
            if await model.delete(target) {
                if nextID == nil { dismiss() }
            } else if model.assets.contains(where: { $0.id == target.id }) {
                selectedAssetID = target.id
            }
        }
    }

    private static func fileSize(_ bytes: Int64) -> String {
        ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file)
    }
}

private struct MemoryPageView: View {
    let asset: Asset
    let isActive: Bool
    @Binding var chromeVisible: Bool
    @Binding var showTranscript: Bool
    @Binding var showAnalysis: Bool
    @Binding var requestedSeek: MemorySeekRequest?

    var body: some View {
        if asset.mediaType == .video {
            VideoMemoryView(
                asset: asset,
                isActive: isActive,
                chromeVisible: $chromeVisible,
                showTranscript: $showTranscript,
                showAnalysis: $showAnalysis,
                requestedSeek: $requestedSeek
            )
        } else {
            PhotoMemoryView(asset: asset) {
                withAnimation(.easeInOut(duration: 0.2)) {
                    chromeVisible.toggle()
                }
            }
        }
    }
}
