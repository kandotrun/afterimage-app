import AVKit
import SwiftUI
import UIKit

struct MemoryDetailView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let asset: Asset

    @State private var image: UIImage?
    @State private var player: AVPlayer?
    @State private var isLoading = true
    @State private var loadError: String?
    @State private var confirmDelete = false

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            if asset.mediaType == .video {
                if let player {
                    VideoPlayer(player: player)
                        .ignoresSafeArea(edges: .horizontal)
                } else if isLoading {
                    ProgressView().tint(.white)
                } else {
                    failureView
                }
            } else if let image {
                ScrollView([.horizontal, .vertical]) {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFit()
                        .containerRelativeFrame([.horizontal, .vertical])
                }
            } else if isLoading {
                ProgressView().tint(.white)
            } else {
                failureView
            }
        }
        .navigationTitle(asset.capturedAt.formatted(.dateTime.month(.wide).day().hour().minute()))
        .navigationBarTitleDisplayMode(.inline)
        .toolbarColorScheme(.dark, for: .navigationBar)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Text(Self.fileSize(asset.byteSize))
                    Button("削除", systemImage: "trash", role: .destructive) {
                        confirmDelete = true
                    }
                } label: {
                    Image(systemName: "ellipsis")
                }
                .accessibilityLabel("その他")
            }
        }
        .task(id: asset.id) { await load() }
        .onDisappear { player?.pause() }
        .confirmationDialog("このafterimageを削除しますか？", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("削除", role: .destructive) {
                Task {
                    if await model.delete(asset) { dismiss() }
                }
            }
            Button("キャンセル", role: .cancel) {}
        } message: {
            Text("R2上の写真・動画も完全に削除されます。")
        }
    }

    private var failureView: some View {
        VStack(spacing: 14) {
            Image(systemName: "exclamationmark.circle")
                .font(.largeTitle)
            Text(loadError ?? "読み込めませんでした")
                .font(.callout)
                .multilineTextAlignment(.center)
        }
        .foregroundStyle(.white.opacity(0.82))
        .padding(28)
    }

    private func load() async {
        isLoading = true
        loadError = nil
        do {
            if asset.mediaType == .video {
                let url = try await model.playbackURL(for: asset)
                player = AVPlayer(url: url)
            } else {
                let data = try await model.photoData(for: asset)
                guard let loaded = UIImage(data: data) else { throw AfterimageError.invalidResponse }
                image = loaded
            }
        } catch {
            loadError = error.localizedDescription
        }
        isLoading = false
    }

    private static func fileSize(_ bytes: Int64) -> String {
        ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file)
    }
}
