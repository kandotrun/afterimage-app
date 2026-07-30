import SwiftUI

struct SettingsView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss

    @State private var legalURLs: [LegalPage: URL] = [:]
    @State private var confirmsConsentWithdrawal = false
    @State private var confirmsAccountDeletion = false

    var body: some View {
        NavigationStack {
            Form {
                aiConsentSection
                legalSection
                accountSection
            }
            .navigationTitle(L10n.string("account.settings.title"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button(L10n.string("action.close")) {
                        dismiss()
                    }
                }
            }
            .task {
                await model.refreshAIConsent(showFailure: false)
                legalURLs[.privacy] = try? await model.legalURL(.privacy)
                legalURLs[.support] = try? await model.legalURL(.support)
                legalURLs[.terms] = try? await model.legalURL(.terms)
            }
            .confirmationDialog(
                L10n.string("privacy.ai.withdraw_confirm"),
                isPresented: $confirmsConsentWithdrawal,
                titleVisibility: .visible
            ) {
                Button(
                    L10n.string("privacy.ai.withdraw"),
                    role: .destructive
                ) {
                    Task {
                        _ = await model.updateAIConsent(granted: false)
                    }
                }
                Button(L10n.string("action.cancel"), role: .cancel) {}
            } message: {
                Text(L10n.string("privacy.ai.existing_data"))
            }
            .confirmationDialog(
                L10n.string("account.delete.confirm"),
                isPresented: $confirmsAccountDeletion,
                titleVisibility: .visible
            ) {
                Button(
                    L10n.string("account.delete.action"),
                    role: .destructive
                ) {
                    Task { await model.deleteAccount() }
                }
                Button(L10n.string("account.delete.cancel"), role: .cancel) {}
            } message: {
                Text(L10n.string("account.delete.scope"))
            }
        }
    }

    @ViewBuilder
    private var aiConsentSection: some View {
        Section {
            Text(L10n.string("privacy.ai.introduction"))
            LabeledContent {
                Text(L10n.string(consentStatusKey))
                    .foregroundStyle(
                        AIConsentPolicy.canTransferExternally(consent: model.aiConsent)
                            ? .green
                            : .secondary
                    )
            } label: {
                Label(
                    L10n.string("privacy.ai.title"),
                    systemImage: "brain.head.profile"
                )
            }
            VStack(alignment: .leading, spacing: 10) {
                Text(L10n.string("privacy.ai.destination_title"))
                    .font(.headline)
                Label(
                    L10n.string("privacy.ai.soniox"),
                    systemImage: "waveform"
                )
                Label(
                    L10n.string("privacy.ai.qwen"),
                    systemImage: "sparkles"
                )
                Label(
                    L10n.string("privacy.ai.mcp"),
                    systemImage: "link"
                )
                Text(L10n.string("privacy.ai.purpose"))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                Text(L10n.string("privacy.ai.existing_data"))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            if AIConsentPolicy.canTransferExternally(consent: model.aiConsent) {
                NavigationLink {
                    AIConnectionView()
                } label: {
                    Label(
                        L10n.string("settings.ai_connection"),
                        systemImage: "cpu"
                    )
                }
                Button(
                    L10n.string("privacy.ai.withdraw"),
                    role: .destructive
                ) {
                    confirmsConsentWithdrawal = true
                }
                .disabled(model.isUpdatingAIConsent)
            } else {
                Button(L10n.string("privacy.ai.grant")) {
                    Task {
                        _ = await model.updateAIConsent(granted: true)
                    }
                }
                .disabled(model.isUpdatingAIConsent)
            }
        }
    }

    @ViewBuilder
    private var legalSection: some View {
        Section(L10n.string("settings.legal")) {
            legalLink(.privacy, title: "legal.privacy")
            legalLink(.support, title: "legal.support")
            legalLink(.terms, title: "legal.terms")
        }
    }

    @ViewBuilder
    private var accountSection: some View {
        Section {
            Button(L10n.string("settings.reload")) {
                Task {
                    try? await model.refreshTimeline()
                    await model.recordTodayWeather()
                    await model.refreshAIConsent(showFailure: true)
                }
            }
            Button(L10n.string("settings.sign_out"), role: .destructive) {
                Task {
                    await model.signOut()
                    if !model.isAuthenticated {
                        dismiss()
                    }
                }
            }
            Button(
                L10n.string("account.delete.action"),
                role: .destructive
            ) {
                confirmsAccountDeletion = true
            }
            .disabled(
                model.accountDeletionState == .deleting
                    || model.accountDeletionState == .cleaningLocalData
            )

            switch model.accountDeletionState {
            case .deleting, .cleaningLocalData:
                HStack {
                    ProgressView()
                    Text(L10n.string("account.delete.progress"))
                }
            case .reauthenticationRequired:
                Text(L10n.string("account.delete.reauth_detail"))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                ChallengeBoundAppleSignInButton { credential, binding in
                    await model.reauthenticateAndDeleteAccount(
                        credential: credential,
                        challengeID: binding.challengeID
                    )
                }
                .accessibilityLabel(L10n.string("account.delete.reauth"))
            case .backendFailed(let message):
                Text(verbatim: message)
                    .font(.footnote)
                    .foregroundStyle(.red)
                Button(L10n.string("account.delete.retry")) {
                    Task { await model.deleteAccount() }
                }
            case .localCleanupFailed:
                Button(L10n.string("account.delete.cleanup_retry")) {
                    Task { await model.retryLocalCleanup() }
                }
            case .idle, .completed:
                EmptyView()
            }
        } header: {
            Text(L10n.string("account.settings.title"))
        } footer: {
            Text(L10n.string("account.delete.scope"))
        }
    }

    private var consentStatusKey: String {
        guard let consent = model.aiConsent else {
            return "privacy.ai.not_granted"
        }
        if AIConsentPolicy.canTransferExternally(consent: consent) {
            return "privacy.ai.granted"
        }
        return consent.withdrawnAt == nil
            ? "privacy.ai.not_granted"
            : "privacy.ai.withdrawn"
    }

    @ViewBuilder
    private func legalLink(_ page: LegalPage, title: String) -> some View {
        if let url = legalURLs[page] {
            Link(destination: url) {
                Label(L10n.string(title), systemImage: "arrow.up.right.square")
            }
        }
    }
}
