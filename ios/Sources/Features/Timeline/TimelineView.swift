import PhotosUI
import SwiftUI
import UIKit

struct TimelineView: View {
    @EnvironmentObject private var model: AppModel
    @State private var selection: [PhotosPickerItem] = []

    private var sections: [MemoryDay] {
        let calendar = Calendar.autoupdatingCurrent
        let grouped = Dictionary(grouping: model.assets) { calendar.startOfDay(for: $0.capturedAt) }
        return grouped.keys.sorted(by: >).map { day in
            MemoryDay(day: day, assets: grouped[day, default: []].sorted { $0.capturedAt > $1.capturedAt })
        }
    }

    var body: some View {
        NavigationStack {
            MemoryBackdrop {
                ScrollView {
                    if sections.isEmpty && !model.isLoadingTimeline {
                        EmptyTimelineView()
                            .padding(.top, 120)
                    } else {
                        LazyVStack(alignment: .leading, spacing: 30, pinnedViews: [.sectionHeaders]) {
                            ForEach(sections) { section in
                                Section {
                                    LazyVGrid(
                                        columns: [GridItem(.flexible(), spacing: 3), GridItem(.flexible(), spacing: 3)],
                                        spacing: 3
                                    ) {
                                        ForEach(section.assets) { asset in
                                            NavigationLink(value: asset) {
                                                MemoryTile(asset: asset)
                                            }
                                            .buttonStyle(.plain)
                                            .task { await model.loadMoreIfNeeded(after: asset) }
                                        }
                                    }
                                } header: {
                                    Text(section.title)
                                        .font(.headline.weight(.semibold))
                                        .padding(.horizontal, 16)
                                        .padding(.vertical, 8)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                }
                            }
                        }
                        .padding(.bottom, 100)
                    }
                }
                .refreshable { try? await model.refreshTimeline() }
            }
            .navigationTitle("afterimage")
            .navigationDestination(for: Asset.self) { asset in
                MemoryDetailView(asset: asset)
            }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button("再読み込み", systemImage: "arrow.clockwise") {
                            Task { try? await model.refreshTimeline() }
                        }
                        Button("サインアウト", systemImage: "rectangle.portrait.and.arrow.right", role: .destructive) {
                            model.signOut()
                        }
                    } label: {
                        Image(systemName: "person.crop.circle")
                    }
                    .accessibilityLabel("アカウント")
                }
            }
            .safeAreaInset(edge: .bottom) {
                UploadDock(selection: $selection)
                    .padding(.horizontal, 14)
                    .padding(.bottom, 6)
            }
            .onChange(of: selection) { _, items in
                guard !items.isEmpty else { return }
                model.importItems(items)
                selection = []
            }
        }
    }
}

private struct MemoryDay: Identifiable {
    let day: Date
    let assets: [Asset]
    var id: Date { day }
    var title: String {
        if Calendar.autoupdatingCurrent.isDateInToday(day) { return "今日" }
        if Calendar.autoupdatingCurrent.isDateInYesterday(day) { return "昨日" }
        return day.formatted(.dateTime.year().month(.wide).day())
    }
}

private struct MemoryTile: View {
    let asset: Asset

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            AuthenticatedThumbnail(asset: asset)
                .aspectRatio(1, contentMode: .fill)
                .frame(maxWidth: .infinity)
                .clipped()
            if asset.mediaType == .video {
                HStack(spacing: 4) {
                    Image(systemName: "play.fill")
                    if let duration = asset.durationMs {
                        Text(Self.duration(duration))
                    }
                }
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.white)
                .padding(.horizontal, 8)
                .padding(.vertical, 5)
                .background(.black.opacity(0.54), in: .capsule)
                .padding(8)
            }
        }
        .contentShape(.rect)
        .accessibilityLabel(asset.mediaType == .video ? "動画 \(asset.capturedAt.formatted())" : "写真 \(asset.capturedAt.formatted())")
    }

    private static func duration(_ milliseconds: Int) -> String {
        let seconds = max(0, milliseconds / 1_000)
        return String(format: "%d:%02d", seconds / 60, seconds % 60)
    }
}

struct AuthenticatedThumbnail: View {
    @EnvironmentObject private var model: AppModel
    let asset: Asset
    @State private var image: UIImage?

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
            } else {
                ZStack {
                    LinearGradient(
                        colors: asset.mediaType == .video
                            ? [Color.indigo.opacity(0.72), Color.orange.opacity(0.42)]
                            : [Color.orange.opacity(0.60), Color.pink.opacity(0.36)],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                    Image(systemName: asset.mediaType == .video ? "video.fill" : "photo.fill")
                        .font(.title2)
                        .foregroundStyle(.white.opacity(0.82))
                }
            }
        }
        .task(id: asset.id) {
            guard asset.thumbnailUrl != nil else { return }
            if let data = try? await model.thumbnailData(for: asset) {
                image = UIImage(data: data)
            }
        }
    }
}

private struct EmptyTimelineView: View {
    var body: some View {
        VStack(spacing: 18) {
            AfterglowMark()
            Text("最初のafterimageを残そう")
                .font(.title2.bold())
            Text("下の＋から写真や動画を選ぶと、
音を変えずに軽くして保存します。")
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .lineSpacing(4)
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 30)
    }
}

private struct UploadDock: View {
    @EnvironmentObject private var model: AppModel
    @Binding var selection: [PhotosPickerItem]

    var body: some View {
        GlassEffectContainer(spacing: 14) {
            HStack(spacing: 10) {
                if let upload = model.upload {
                    GlassProgressPill(upload: upload)

                    Button(role: .cancel) { model.cancelUpload() } label: {
                        Image(systemName: "xmark")
                            .frame(width: 32, height: 32)
                    }
                    .buttonStyle(.glass)
                    .accessibilityLabel("キャンセル")
                } else {
                    PhotosPicker(
                        selection: $selection,
                        maxSelectionCount: 12,
                        matching: .any(of: [.images, .videos]),
                        preferredItemEncoding: .current
                    ) {
                        Label("追加", systemImage: "plus")
                            .font(.headline)
                            .frame(minWidth: 82, minHeight: 44)
                    }
                    .buttonStyle(.glassProminent)
                    .accessibilityLabel("写真や動画を追加")
                }
            }
            .animation(.snappy(duration: 0.3), value: model.upload)
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
    }
}
