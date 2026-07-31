import SwiftUI

struct MemorySearchView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss

    @State private var query = ""
    @State private var results: [MemorySearchResult] = []
    @State private var nextCursor: String?
    @State private var hasSearched = false
    @State private var isLoading = false
    @State private var isLoadingMore = false
    @State private var loadError: String?
    @State private var paginationError: String?
    @State private var requestGeneration = 0
    @State private var searchTask: Task<Void, Never>?
    @State private var paginationTask: Task<Void, Never>?

    var body: some View {
        NavigationStack {
            MemoryBackdrop {
                content
            }
            .navigationTitle(L10n.string("memory.search.title"))
            .navigationBarTitleDisplayMode(.inline)
            .searchable(
                text: $query,
                prompt: Text(L10n.string("memory.search.prompt"))
            )
            .navigationDestination(for: MemorySearchResult.self) { result in
                MemoryDetailView(
                    asset: result.asset,
                    standalone: true,
                    initialSeekMs: result.match.startMs
                )
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(L10n.string("action.cancel")) { dismiss() }
                }
            }
        }
        .onChange(of: query) { _, input in
            beginSearch(for: input, debounced: true)
        }
        .onDisappear {
            searchTask?.cancel()
            paginationTask?.cancel()
        }
    }

    @ViewBuilder
    private var content: some View {
        if isLoading {
            ProgressView(L10n.string("memory.search.loading"))
                .controlSize(.large)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let loadError {
            ContentUnavailableView {
                Label(L10n.string("memory.search.error_title"), systemImage: "exclamationmark.magnifyingglass")
            } description: {
                Text(verbatim: loadError)
            } actions: {
                Button(L10n.string("action.retry")) {
                    model.playHaptic(.lift)
                    beginSearch(for: query, debounced: false)
                }
                .buttonStyle(.borderedProminent)
            }
        } else if !hasSearched {
            ContentUnavailableView {
                Label(L10n.string("memory.search.initial_title"), systemImage: "sparkle.magnifyingglass")
            } description: {
                Text(L10n.string("memory.search.initial_detail"))
            }
        } else if results.isEmpty {
            ContentUnavailableView {
                Label(L10n.string("memory.search.empty_title"), systemImage: "magnifyingglass")
            } description: {
                Text(L10n.string("memory.search.empty_detail"))
            }
        } else {
            resultList
        }
    }

    private var resultList: some View {
        ScrollView {
            LazyVStack(spacing: 12) {
                ForEach(results) { result in
                    NavigationLink(value: result) {
                        MemorySearchResultCard(result: result)
                    }
                    .buttonStyle(.plain)
                    .simultaneousGesture(
                        TapGesture().onEnded { model.playHaptic(.selection) }
                    )
                    .accessibilityHint(accessibilityHint(for: result))
                    .onAppear {
                        loadMoreIfNeeded(after: result)
                    }
                }

                if isLoadingMore {
                    ProgressView(L10n.string("memory.search.loading"))
                        .padding(.vertical, 20)
                } else if let paginationError {
                    VStack(spacing: 10) {
                        Text(verbatim: paginationError)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                        Button(L10n.string("action.retry")) {
                            guard let last = results.last else { return }
                            model.playHaptic(.lift)
                            loadMoreIfNeeded(after: last)
                        }
                        .buttonStyle(.bordered)
                    }
                    .padding(.vertical, 16)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
        }
    }

    private func beginSearch(for input: String, debounced: Bool) {
        searchTask?.cancel()
        paginationTask?.cancel()
        requestGeneration += 1
        let generation = requestGeneration

        results = []
        nextCursor = nil
        hasSearched = false
        isLoading = false
        isLoadingMore = false
        loadError = nil
        paginationError = nil

        guard let normalizedQuery = MemorySearchPolicy.query(from: input) else { return }

        searchTask = Task { @MainActor in
            do {
                if debounced {
                    try await Task.sleep(for: .milliseconds(300))
                }
                try Task.checkCancellation()
                guard requestGeneration == generation else { return }
                hasSearched = true
                isLoading = true

                let page = try await model.searchMemories(query: normalizedQuery)
                try Task.checkCancellation()
                guard requestGeneration == generation else { return }

                results = page.items
                nextCursor = page.nextCursor
                isLoading = false
            } catch {
                guard !Task.isCancelled, requestGeneration == generation else { return }
                hasSearched = true
                isLoading = false
                loadError = error.localizedDescription
            }
        }
    }

    private func loadMoreIfNeeded(after result: MemorySearchResult) {
        guard result.id == results.last?.id,
              let cursor = nextCursor,
              !isLoadingMore,
              let normalizedQuery = MemorySearchPolicy.query(from: query) else { return }

        let generation = requestGeneration
        isLoadingMore = true
        paginationError = nil

        paginationTask = Task { @MainActor in
            do {
                let page = try await model.searchMemories(query: normalizedQuery, cursor: cursor)
                try Task.checkCancellation()
                guard requestGeneration == generation else { return }

                let existingIDs = Set(results.map(\.id))
                results.append(contentsOf: page.items.filter { !existingIDs.contains($0.id) })
                nextCursor = page.nextCursor
                isLoadingMore = false
            } catch {
                guard !Task.isCancelled, requestGeneration == generation else { return }
                isLoadingMore = false
                paginationError = error.localizedDescription
            }
        }
    }

    private func accessibilityHint(for result: MemorySearchResult) -> String {
        guard let startMs = result.match.startMs else {
            return L10n.string("memory.search.open_result")
        }
        return L10n.format(
            "memory.search.seek_at",
            PlaybackClock.label(TimeInterval(max(0, startMs)) / 1_000)
        )
    }
}

private struct MemorySearchResultCard: View {
    let result: MemorySearchResult

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                Color(.tertiarySystemFill)
                    .frame(width: 92, height: 92)
                    .overlay {
                        AuthenticatedThumbnail(asset: result.asset)
                    }
                    .clipShape(.rect(cornerRadius: 14))

                VStack(alignment: .leading, spacing: 7) {
                    Text(result.asset.capturedAt.formatted(.dateTime.year().month(.abbreviated).day().hour().minute()))
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.primary)

                    HStack(spacing: 8) {
                        Label(
                            matchKindTitle,
                            systemImage: matchKindImage
                        )
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.tint)

                        if let startMs = result.match.startMs {
                            Label(
                                PlaybackClock.label(TimeInterval(max(0, startMs)) / 1_000),
                                systemImage: "clock"
                            )
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(.secondary)
                        }
                    }

                    Text(verbatim: result.match.text)
                        .font(.callout)
                        .foregroundStyle(.primary)
                        .lineLimit(3)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }

            if let visualSummary = result.visualSummary?.trimmingCharacters(in: .whitespacesAndNewlines),
               !visualSummary.isEmpty {
                Divider()
                VStack(alignment: .leading, spacing: 5) {
                    Label(L10n.string("memory.search.visual_summary"), systemImage: "sparkles")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                    Text(verbatim: visualSummary)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .lineLimit(3)
                }
            }
        }
        .padding(14)
        .background(Color(.secondarySystemBackground), in: .rect(cornerRadius: 18))
        .contentShape(.rect(cornerRadius: 18))
    }

    private var matchKindTitle: String {
        switch result.match.kind {
        case .filename: L10n.string("memory.search.match.filename")
        case .transcript: L10n.string("memory.search.match.transcript")
        case .visual: L10n.string("memory.search.match.visual")
        }
    }

    private var matchKindImage: String {
        switch result.match.kind {
        case .filename: "doc.text"
        case .transcript: "captions.bubble"
        case .visual: "eye"
        }
    }
}
