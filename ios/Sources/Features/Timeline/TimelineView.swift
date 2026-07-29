import PhotosUI
import SwiftUI
import UIKit

struct TimelineView: View {
    @EnvironmentObject private var model: AppModel
    @ObservedObject private var notificationIntents = NotificationIntentRouter.shared
    @State private var selection: [PhotosPickerItem] = []
    @State private var pendingOpen: Asset?
    @State private var pendingDay: DailyPlaybackRoute?
    @State private var isShowingMemorySearch = false
    @State private var isShowingAIConnection = false
    @State private var isConfirmingSignOut = false
    @State private var cameraRoute: CameraRoute?
    @Namespace private var zoomTransition

    private var sections: [MemoryDay] {
        let calendar = Calendar.autoupdatingCurrent
        let grouped = Dictionary(grouping: model.assets) { calendar.startOfDay(for: $0.capturedAt) }
        return grouped.keys.sorted(by: >).map { day in
            MemoryDay(day: day, assets: grouped[day, default: []].sorted { $0.capturedAt > $1.capturedAt })
        }
    }

    private var standaloneTodayWeather: DailyWeather? {
        TimelineWeatherPresentationPolicy.standaloneTodayWeather(
            weather: model.weather(for: .now),
            assetDates: model.assets.map(\.capturedAt)
        )
    }

    var body: some View {
        NavigationStack {
            MemoryBackdrop {
                ScrollView {
                    if sections.isEmpty && standaloneTodayWeather == nil {
                        switch model.timelineLoadState {
                        case .loading:
                            ProgressView()
                                .controlSize(.large)
                                .frame(maxWidth: .infinity)
                                .padding(.top, 160)
                        case .failed:
                            TimelineLoadFailedView {
                                Task { await model.refreshTimelineReportingFailure() }
                            }
                            .padding(.top, 120)
                        case .loaded:
                            EmptyTimelineView()
                                .padding(.top, 120)
                        }
                    } else {
                        LazyVStack(alignment: .leading, spacing: 40) {
                            if let weather = standaloneTodayWeather {
                                StandaloneDailyWeatherSection(
                                    title: L10n.string("timeline.today"),
                                    weather: weather
                                )
                                .padding(.horizontal, 20)
                            }
                            ForEach(sections) { section in
                                if let story = DayStoryPolicy.story(for: section.assets) {
                                    DayStorySection(
                                        title: section.title,
                                        weather: model.weather(for: section.day),
                                        day: section.day,
                                        readyVideos: section.readyVideos,
                                        story: story,
                                        namespace: zoomTransition
                                    )
                                    .padding(.horizontal, 20)
                                    .task { await model.loadMoreIfNeeded(after: section.assets.last ?? story.hero) }
                                }
                            }
                            timelineFooter
                        }
                        .padding(.top, 8)
                        .padding(.bottom, 100)
                    }
                }
                .refreshable {
                    await model.refreshTimelineReportingFailure()
                    await model.recordTodayWeather()
                }
            }
            .task { await model.recordTodayWeather() }
            .navigationTitle(L10n.string("timeline.title"))
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
                    Button {
                        isShowingMemorySearch = true
                    } label: {
                        Image(systemName: "magnifyingglass")
                    }
                    .accessibilityLabel(L10n.string("memory.search.open"))
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button("AI連携", systemImage: "brain.head.profile") {
                            isShowingAIConnection = true
                        }
                        Button("再読み込み", systemImage: "arrow.clockwise") {
                            Task {
                                await model.refreshTimelineReportingFailure()
                                await model.recordTodayWeather()
                            }
                        }
                        Button("サインアウト", systemImage: "rectangle.portrait.and.arrow.right", role: .destructive) {
                            isConfirmingSignOut = true
                        }
                    } label: {
                        Image(systemName: "person.crop.circle")
                    }
                    .accessibilityLabel("アカウント")
                }
            }
            .confirmationDialog(
                "サインアウトしますか？",
                isPresented: $isConfirmingSignOut,
                titleVisibility: .visible
            ) {
                Button("サインアウト", role: .destructive) {
                    Task { await model.signOut() }
                }
                Button(L10n.string("camera.action.cancel"), role: .cancel) {}
            } message: {
                Text(
                    model.upload == nil
                        ? "記録はサーバーに残ります。サインインし直せば、いつでも戻れます。"
                        : "アップロード中の動画は中断されます。記録済みの内容はサーバーに残ります。"
                )
            }
            .onChange(of: notificationIntents.wantsCameraCapture) { _, wants in
                guard wants, model.isAuthenticated else { return }
                notificationIntents.wantsCameraCapture = false
                cameraRoute = .capture
            }
            .task {
                if model.isAuthenticated, notificationIntents.consumeCameraCaptureRequest() {
                    cameraRoute = .capture
                }
            }
            .sheet(isPresented: $isShowingAIConnection) {
                AIConnectionView()
            }
            .sheet(isPresented: $isShowingMemorySearch) {
                MemorySearchView()
            }
            .fullScreenCover(item: $cameraRoute) { _ in
                CameraCaptureView()
            }
            .safeAreaInset(edge: .bottom) {
                UploadDock(
                    selection: $selection,
                    previewPlaybackAllowed: cameraRoute == nil
                        && !isShowingMemorySearch
                        && !isShowingAIConnection,
                    recordVideo: { cameraRoute = .capture }
                )
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

    @ViewBuilder
    private var timelineFooter: some View {
        if model.isLoadingMore {
            ProgressView()
                .frame(maxWidth: .infinity)
                .padding(.vertical, 12)
        } else if model.paginationFailed {
            HStack(spacing: 12) {
                Text(L10n.string("timeline.pagination_failed"))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                Spacer(minLength: 8)
                Button(L10n.string("action.retry")) {
                    Task { await model.retryPagination() }
                }
                .buttonStyle(.glass)
                .font(.footnote.weight(.semibold))
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .glassEffect(.regular, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .padding(.horizontal, 20)
        }
    }
}

private struct TimelineLoadFailedView: View {
    let retry: () -> Void

    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "wifi.exclamationmark")
                .font(.system(size: 52, weight: .light))
                .foregroundStyle(.secondary)
            Text(L10n.string("timeline.load_failed_title"))
                .font(.title3.weight(.semibold))
            Text(L10n.string("timeline.load_failed_detail"))
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .lineSpacing(3)
            Button(L10n.string("action.retry"), action: retry)
                .buttonStyle(.glass)
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 30)
    }
}

private enum CameraRoute: Identifiable {
    case capture

    var id: String { "capture" }
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
        .task(id: "\(asset.id)-\(model.timelineGeneration)") {
            // Retries with backoff, and a successful pull-to-refresh bumps the
            // generation so failed thumbnails get one more chance to load.
            guard asset.thumbnailUrl != nil, image == nil else { return }
            for attempt in 0..<3 {
                if attempt > 0 {
                    try? await Task.sleep(for: .seconds(Double(attempt) * 0.8))
                }
                if Task.isCancelled { return }
                if let data = try? await model.thumbnailData(for: asset),
                   let loaded = UIImage(data: data) {
                    image = loaded
                    return
                }
            }
        }
    }
}

private struct EmptyTimelineView: View {
    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "video.fill")
                .font(.system(size: 52, weight: .light))
                .foregroundStyle(.secondary)
            Text("最初のafterimageを残そう")
                .font(.title3.weight(.semibold))
            Text("下の＋から撮影するか動画を選ぶと、\n音を変えずに軽くして保存します。")
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
    let previewPlaybackAllowed: Bool
    let recordVideo: () -> Void
    @State private var isShowingLibrary = false
    @State private var isConfirmingCancel = false
    @State private var isConfirmingDiscardStalled = false

    var body: some View {
        VStack(alignment: .trailing, spacing: 9) {
            if let message = model.transientNotice {
                TransientNoticeView(message: message)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }

            if let summary = model.importSelectionSummary {
                ImportSelectionSummaryView(summary: summary)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }

            GlassEffectContainer(spacing: 8) {
                HStack(spacing: 12) {
                    if let upload = model.upload {
                        UploadStatusBar(
                            upload: upload,
                            isPreviewPlaybackAllowed: previewPlaybackAllowed && !isShowingLibrary
                        )

                        Button(role: .cancel) {
                            if upload.total > 1 {
                                isConfirmingCancel = true
                            } else {
                                model.cancelUpload()
                            }
                        } label: {
                            Image(systemName: "xmark")
                                .frame(width: 44, height: 44)
                        }
                        .buttonStyle(.glass)
                        .buttonBorderShape(.circle)
                        .tint(.accentColor)
                        .accessibilityLabel(L10n.string("upload.action.cancel"))
                    } else if model.backgroundUploadNeedsRetry {
                        Button {
                            Task { await model.retryBackgroundUpload() }
                        } label: {
                            Label(L10n.string("upload.resume"), systemImage: "arrow.clockwise")
                                .font(.headline)
                                .frame(minHeight: 44)
                                .padding(.horizontal, 4)
                        }
                        .buttonStyle(.glassProminent)

                        Button(role: .destructive) {
                            isConfirmingDiscardStalled = true
                        } label: {
                            Image(systemName: "trash")
                                .frame(width: 44, height: 44)
                        }
                        .buttonStyle(.glass)
                        .accessibilityLabel(L10n.string("upload.discard"))
                    } else {
                        Spacer(minLength: 0)
                        Menu {
                            Button(
                                L10n.string("camera.source.record"),
                                systemImage: "video.badge.plus"
                            ) {
                                recordVideo()
                            }
                            Button(
                                L10n.string("camera.source.library"),
                                systemImage: "photo.on.rectangle"
                            ) {
                                isShowingLibrary = true
                            }
                        } label: {
                            Image(systemName: "plus")
                                .font(.headline)
                                .frame(width: 44, height: 44)
                        }
                        .buttonStyle(.glassProminent)
                        .buttonBorderShape(.circle)
                        .accessibilityLabel("動画を追加")
                        .accessibilityHint(L10n.string("accessibility.upload_picker_duplicate_hint"))
                    }
                }
            }
        }
        .animation(.snappy(duration: 0.3), value: model.upload)
        .animation(.snappy(duration: 0.3), value: model.importSelectionSummary)
        .animation(.snappy(duration: 0.3), value: model.transientNotice)
        .animation(.snappy(duration: 0.3), value: model.backgroundUploadNeedsRetry)
        .frame(maxWidth: .infinity, alignment: .trailing)
        .confirmationDialog(
            "残りのアップロードを中止しますか？",
            isPresented: $isConfirmingCancel,
            titleVisibility: .visible
        ) {
            Button("中止する", role: .destructive) { model.cancelUpload() }
            Button(L10n.string("camera.action.cancel"), role: .cancel) {}
        } message: {
            Text("まだ保存されていない動画は失われます。")
        }
        .confirmationDialog(
            "アップロードを破棄しますか？",
            isPresented: $isConfirmingDiscardStalled,
            titleVisibility: .visible
        ) {
            Button("破棄する", role: .destructive) { model.discardPendingUpload() }
            Button(L10n.string("camera.action.cancel"), role: .cancel) {}
        } message: {
            Text("途中まで送られた動画は保存されません。")
        }
        .photosPicker(
            isPresented: $isShowingLibrary,
            selection: $selection,
            maxSelectionCount: 12,
            matching: .videos,
            preferredItemEncoding: .current,
            photoLibrary: .shared()
        )
    }
}

private struct TransientNoticeView: View {
    let message: String

    var body: some View {
        Label {
            Text(verbatim: message)
        } icon: {
            Image(systemName: "exclamationmark.circle")
        }
        .font(.caption.weight(.semibold))
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .glassEffect(.regular, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .accessibilityElement(children: .combine)
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
