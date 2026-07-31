import SwiftUI

struct VideoAnalysisSheet: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let asset: Asset
    let onSeek: (Int) -> Void

    @State private var analysis: VideoAnalysisResponse?
    @State private var isLoading = true
    @State private var loadError: String?
    @State private var retryGeneration = 0

    var body: some View {
        NavigationStack {
            MemoryBackdrop {
                content
            }
            .navigationTitle(L10n.string("memory.analysis.title"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(L10n.string("action.cancel")) { dismiss() }
                }
            }
        }
        .task(id: retryGeneration) {
            await loadUntilSettled()
        }
    }

    @ViewBuilder
    private var content: some View {
        if isLoading, analysis == nil {
            ProgressView(L10n.string("memory.analysis.loading"))
                .controlSize(.large)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let loadError {
            ContentUnavailableView {
                Label(L10n.string("memory.analysis.error_title"), systemImage: "exclamationmark.triangle")
            } description: {
                Text(verbatim: loadError)
            } actions: {
                Button(L10n.string("memory.analysis.retry")) {
                    model.playHaptic(.lift)
                    retryGeneration += 1
                }
                .buttonStyle(.borderedProminent)
            }
        } else if let analysis {
            switch analysis.status {
            case .queued:
                statusView(
                    titleKey: "memory.analysis.queued_title",
                    detailKey: "memory.analysis.queued_detail",
                    systemImage: "clock.badge"
                )
            case .processing:
                statusView(
                    titleKey: "memory.analysis.processing_title",
                    detailKey: "memory.analysis.processing_detail",
                    systemImage: "sparkles"
                )
            case .failed:
                statusView(
                    titleKey: "memory.analysis.failed_title",
                    detailKey: "memory.analysis.failed_detail",
                    systemImage: "exclamationmark.triangle"
                )
            case .unavailable:
                statusView(
                    titleKey: "memory.analysis.queued_title",
                    detailKey: "memory.analysis.queued_detail",
                    systemImage: "clock.badge"
                )
            case .completed:
                completedContent(analysis)
            }
        }
    }

    private func statusView(titleKey: String, detailKey: String, systemImage: String) -> some View {
        ContentUnavailableView {
            Label(L10n.string(titleKey), systemImage: systemImage)
        } description: {
            Text(L10n.string(detailKey))
        }
    }

    @ViewBuilder
    private func completedContent(_ analysis: VideoAnalysisResponse) -> some View {
        let summary = analysis.summary?.trimmingCharacters(in: .whitespacesAndNewlines)
        if (summary?.isEmpty ?? true), analysis.segments.isEmpty {
            ContentUnavailableView {
                Label(L10n.string("memory.analysis.completed_empty"), systemImage: "rectangle.stack")
            }
        } else {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 24) {
                    if let summary, !summary.isEmpty {
                        VStack(alignment: .leading, spacing: 10) {
                            Label(L10n.string("memory.analysis.summary"), systemImage: "sparkles")
                                .font(.headline)
                            Text(verbatim: summary)
                                .font(.body)
                                .textSelection(.enabled)
                        }
                    }

                    if !analysis.segments.isEmpty {
                        VStack(alignment: .leading, spacing: 12) {
                            Label(L10n.string("memory.analysis.segments"), systemImage: "list.bullet.rectangle")
                                .font(.headline)
                            ForEach(analysis.segments) { segment in
                                Button {
                                    model.playHaptic(.selection)
                                    onSeek(segment.startMs)
                                    dismiss()
                                } label: {
                                    HStack(alignment: .top, spacing: 12) {
                                        Text(PlaybackClock.label(TimeInterval(max(0, segment.startMs)) / 1_000))
                                            .font(.caption.weight(.semibold).monospacedDigit())
                                            .foregroundStyle(.tint)
                                            .frame(minWidth: 46, alignment: .leading)
                                        Text(verbatim: segment.caption)
                                            .font(.callout)
                                            .foregroundStyle(.primary)
                                            .multilineTextAlignment(.leading)
                                        Spacer(minLength: 0)
                                        Image(systemName: "play.fill")
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                    }
                                    .padding(14)
                                    .background(Color(.secondarySystemBackground), in: .rect(cornerRadius: 16))
                                }
                                .buttonStyle(.plain)
                                .accessibilityHint(
                                    L10n.format(
                                        "memory.analysis.seek_at",
                                        PlaybackClock.label(TimeInterval(max(0, segment.startMs)) / 1_000)
                                    )
                                )
                            }
                        }
                    }
                }
                .padding(20)
            }
        }
    }

    @MainActor
    private func loadUntilSettled() async {
        isLoading = analysis == nil
        loadError = nil
        while !Task.isCancelled {
            do {
                let response = try await model.videoAnalysis(for: asset)
                try Task.checkCancellation()
                analysis = response
                isLoading = false
                guard VideoAnalysisPollingPolicy.shouldPoll(status: response.status, isVisible: true) else {
                    return
                }
                try await Task.sleep(for: .seconds(6))
            } catch is CancellationError {
                return
            } catch {
                isLoading = false
                loadError = error.localizedDescription
                model.playHaptic(.failure)
                return
            }
        }
    }
}
