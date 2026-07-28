import PhotosUI
import SwiftUI
import UIKit

struct TimelineView: View {
    @EnvironmentObject private var model: AppModel
    @State private var selection: [PhotosPickerItem] = []
    @State private var pendingOpen: Asset?
    @State private var pendingDay: DailyPlaybackRoute?
    @Namespace private var zoomTransition

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
                        LazyVStack(alignment: .leading, spacing: 40) {
                            ForEach(sections) { section in
                                if let story = DayStoryPolicy.story(for: section.assets) {
                                    DayStorySection(
                                        title: section.title,
                                        day: section.day,
                                        readyVideos: section.readyVideos,
                                        story: story,
                                        namespace: zoomTransition
                                    )
                                    .padding(.horizontal, 20)
                                    .task { await model.loadMoreIfNeeded(after: section.assets.last ?? story.hero) }
                                }
                            }
                        }
                        .padding(.top, 8)
                        .padding(.bottom, 100)
                    }
                }
                .refreshable { try? await model.refreshTimeline() }
            }
            .navigationTitle("ライブラリ")
            .navigationDestination(for: DailyPlaybackRoute.self) { route in
                DailyPlaybackView(day: route.day)
            }
            .navigationDestination(for: Asset.self) { asset in
                MemoryDetailView(asset: asset)
                    .navigationTransition(.zoom(sourceID: asset.id, in: zoomTransition))
            }
            .navigationDestination(item: $pendingOpen) { asset in
                MemoryDetailView(asset: asset)
            }
            .navigationDestination(item: $pendingDay) { route in
                DailyPlaybackView(day: route.day)
            }
            .task {
                #if DEBUG
                let arguments = ProcessInfo.processInfo.arguments
                try? await Task.sleep(for: .milliseconds(900))
                if let index = arguments.firstIndex(of: "-afterimageOpenDay"),
                   arguments.indices.contains(index + 1) {
                    let formatter = DateFormatter()
                    formatter.calendar = Calendar(identifier: .gregorian)
                    formatter.locale = Locale(identifier: "en_US_POSIX")
                    formatter.timeZone = .autoupdatingCurrent
                    formatter.dateFormat = "yyyy-MM-dd"
                    if let day = formatter.date(from: arguments[index + 1]) {
                        pendingDay = DailyPlaybackRoute(day: day)
                        return
                    }
                }
                guard arguments.contains("-afterimageOpenFirst"),
                      pendingOpen == nil else { return }
                pendingOpen = model.assets.first
                #endif
            }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button("再読み込み", systemImage: "arrow.clockwise") {
                            Task { try? await model.refreshTimeline() }
                        }
                        Button("サインアウト", systemImage: "rectangle.portrait.and.arrow.right", role: .destructive) {
                            Task { await model.signOut() }
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
    var readyVideos: [Asset] {
        assets
            .filter { $0.mediaType == .video && $0.status == .ready }
            .sorted { $0.capturedAt < $1.capturedAt }
    }
    var title: String {
        if Calendar.autoupdatingCurrent.isDateInToday(day) { return L10n.string("timeline.today") }
        if Calendar.autoupdatingCurrent.isDateInYesterday(day) { return L10n.string("timeline.yesterday") }
        if Calendar.autoupdatingCurrent.isDate(day, equalTo: .now, toGranularity: .year) {
            return day.formatted(.dateTime.month(.wide).day().weekday(.wide))
        }
        return day.formatted(.dateTime.year().month(.wide).day().weekday(.wide))
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
                    Color(.tertiarySystemFill)
                    Image(systemName: asset.mediaType == .video ? "video.fill" : "photo.fill")
                        .font(.title3)
                        .foregroundStyle(.tertiary)
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
        VStack(spacing: 16) {
            Image(systemName: "photo.on.rectangle.angled")
                .font(.system(size: 52, weight: .light))
                .foregroundStyle(.secondary)
            Text("最初のafterimageを残そう")
                .font(.title3.weight(.semibold))
            Text("下の＋から写真や動画を選ぶと、\n音を変えずに軽くして保存します。")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .lineSpacing(3)
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 30)
    }
}

private struct UploadDock: View {
    @EnvironmentObject private var model: AppModel
    @Binding var selection: [PhotosPickerItem]

    var body: some View {
        VStack(alignment: .trailing, spacing: 9) {
            if let summary = model.importSelectionSummary {
                ImportSelectionSummaryView(summary: summary)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }

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
                            preferredItemEncoding: .current,
                            photoLibrary: .shared()
                        ) {
                            Image(systemName: "plus")
                                .font(.headline)
                                .frame(width: 44, height: 44)
                        }
                        .buttonStyle(.glassProminent)
                        .buttonBorderShape(.circle)
                        .accessibilityLabel("写真や動画を追加")
                        .accessibilityHint(L10n.string("accessibility.upload_picker_duplicate_hint"))
                    }
                }
            }
        }
        .animation(.snappy(duration: 0.3), value: model.upload)
        .animation(.snappy(duration: 0.3), value: model.importSelectionSummary)
        .frame(maxWidth: .infinity, alignment: .trailing)
    }
}

private struct ImportSelectionSummaryView: View {
    let summary: ImportSelectionSummary

    var body: some View {
        VStack(alignment: .trailing, spacing: 3) {
            Label {
                Text(verbatim: summary.title)
            } icon: {
                Image(systemName: "checkmark.circle.fill")
            }
            .font(.caption.weight(.semibold))
            Text(verbatim: summary.detail)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .multilineTextAlignment(.trailing)
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .glassEffect(.regular, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .accessibilityElement(children: .combine)
    }
}
