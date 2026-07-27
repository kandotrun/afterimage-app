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
                } else if let loadError {
                    ContentUnavailableView(
                        "読み込めませんでした",
                        systemImage: "exclamationmark.circle",
                        description: Text(loadError)
                    )
                } else {
                    ProgressView()
                }
            }
            .navigationTitle("文字起こし")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("閉じる") { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("コピー", systemImage: "doc.on.doc") {
                        UIPasteboard.general.string = transcript?.text
                    }
                    .disabled(transcript == nil)
                }
            }
        }
        .presentationDetents([.medium, .large])
        .task { await load() }
    }

    private func load() async {
        do {
            transcript = try await model.transcript(for: asset)
        } catch {
            loadError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }
}
