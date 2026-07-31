import SwiftUI
import UIKit

struct TranscriptSheet: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let asset: Asset

    @State private var transcript: TranscriptResponse?
    @State private var loadError: String?

    var body: some View {
        NavigationStack {
            Group {
                if let transcript {
                    ScrollView {
                        Text(transcript.text)
                            .font(.body)
                            .lineSpacing(5)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(20)
                            .textSelection(.enabled)
                    }
                } else if transcriptIsInProgress {
                    ContentUnavailableView(
                        L10n.string("transcript.pending_title"),
                        systemImage: "waveform",
                        description: Text(L10n.string("transcript.pending_detail"))
                    )
                } else if asset.transcriptionStatus == .failed && asset.transcriptUrl == nil {
                    ContentUnavailableView(
                        L10n.string("transcript.failed_title"),
                        systemImage: "text.badge.xmark"
                    )
                } else if let loadError {
                    ContentUnavailableView {
                        Label("読み込めませんでした", systemImage: "exclamationmark.circle")
                    } description: {
                        Text(loadError)
                    } actions: {
                        Button(L10n.string("action.retry")) {
                            model.playHaptic(.lift)
                            self.loadError = nil
                            Task { await load() }
                        }
                        .buttonStyle(.glass)
                    }
                } else {
                    ProgressView()
                }
            }
            .navigationTitle("ことば")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("閉じる") { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("コピー", systemImage: "doc.on.doc") {
                        UIPasteboard.general.string = transcript?.text
                        model.playHaptic(.copy)
                    }
                    .disabled(transcript == nil)
                }
            }
        }
        .presentationDetents([.medium, .large])
        .task { await load() }
    }

    private var transcriptIsInProgress: Bool {
        asset.transcriptUrl == nil
            && (asset.transcriptionStatus == .pending || asset.transcriptionStatus == .processing)
    }

    private func load() async {
        guard asset.transcriptUrl != nil else { return }
        do {
            transcript = try await model.transcript(for: asset)
        } catch {
            loadError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            model.playHaptic(.failure)
        }
    }
}
