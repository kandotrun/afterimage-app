import SwiftUI

struct LoginView: View {
    @EnvironmentObject private var model: AppModel
    @State private var legalURLs: [LegalPage: URL] = [:]

    var body: some View {
        MemoryBackdrop {
            VStack(spacing: 0) {
                Spacer()
                AppIconMark()
                    .padding(.bottom, 20)
                Text("afterimage")
                    .font(.largeTitle.bold())
                Text("撮った日々が、あとから見つかる。")
                    .font(.title3)
                    .foregroundStyle(.secondary)
                    .padding(.top, 8)
                Spacer()
                ChallengeBoundAppleSignInButton { credential, binding in
                    await model.signIn(
                        credential: credential,
                        challengeID: binding.challengeID
                    )
                }
                .disabled(model.localCleanupNeedsRetry)

                Text("写真と動画は非公開で保存されます。動画の音は変えません。")
                    .font(.footnote)
                    .foregroundStyle(.tertiary)
                    .multilineTextAlignment(.center)
                    .padding(.top, 14)
                    .padding(.bottom, 12)

                HStack(spacing: 18) {
                    legalLink(.privacy, title: "legal.privacy")
                    legalLink(.support, title: "legal.support")
                    legalLink(.terms, title: "legal.terms")
                }
                .font(.caption)
                .padding(.bottom, 18)

                if model.localCleanupNeedsRetry {
                    Button(L10n.string("account.delete.cleanup_retry")) {
                        Task { await model.retryLocalCleanup() }
                    }
                    .padding(.bottom, 18)
                }
            }
            .padding(.horizontal, 24)
            .frame(maxWidth: 520)
        }
        .task {
            legalURLs[.privacy] = try? await model.legalURL(.privacy)
            legalURLs[.support] = try? await model.legalURL(.support)
            legalURLs[.terms] = try? await model.legalURL(.terms)
        }
    }

    @ViewBuilder
    private func legalLink(_ page: LegalPage, title: String) -> some View {
        if let url = legalURLs[page] {
            Link(L10n.string(title), destination: url)
        }
    }
}

/// Keeps the in-app brand mark in sync with the system app icon.
private struct AppIconMark: View {
    var body: some View {
        Image("BrandMark")
            .resizable()
            .scaledToFit()
            .frame(width: 88, height: 88)
            .clipShape(.rect(cornerRadius: 20))
            .accessibilityHidden(true)
    }
}
