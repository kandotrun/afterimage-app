import AuthenticationServices
import SwiftUI

struct ChallengeBoundAppleSignInButton: View {
    @EnvironmentObject private var model: AppModel

    let onCredential: (ASAuthorizationAppleIDCredential, AppleAuthRequestBinding) async -> Void

    @State private var attemptState = AppleAuthAttemptState()
    @State private var isAuthorizing = false
    @State private var isPreparing = false

    var body: some View {
        Group {
            if attemptState.prepared != nil {
                SignInWithAppleButton(.continue) { request in
                    guard let prepared = attemptState.prepared else { return }
                    AppleAuthRequestPolicy.configure(request, binding: prepared)
                    do {
                        _ = try attemptState.consume()
                        isAuthorizing = true
                    } catch {
                        attemptState.finish()
                        model.presentAppleAuthorizationError(error)
                    }
                } onCompletion: { result in
                    Task { @MainActor in
                        await complete(result)
                    }
                }
                .signInWithAppleButtonStyle(.black)
            } else {
                Button {
                    Task { await prepare() }
                } label: {
                    if isPreparing {
                        ProgressView()
                            .tint(.white)
                            .accessibilityLabel(L10n.string("auth.challenge_loading"))
                    } else {
                        Text(L10n.string("auth.retry"))
                            .frame(maxWidth: .infinity)
                    }
                }
                .buttonStyle(.borderedProminent)
            }
        }
        .frame(height: 50)
        .disabled(isAuthorizing || isPreparing)
        .task {
            await prepare()
        }
    }

    @MainActor
    private func complete(_ result: Result<ASAuthorization, Error>) async {
        defer {
            isAuthorizing = false
            attemptState.finish()
            Task { await prepare() }
        }
        guard let binding = attemptState.active else {
            return
        }
        switch result {
        case .success(let authorization):
            guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential else {
                model.presentAppleAuthorizationError(AfterimageError.missingCredential)
                return
            }
            await onCredential(credential, binding)
        case .failure(let error):
            model.presentAppleAuthorizationError(error)
        }
    }

    @MainActor
    private func prepare() async {
        guard !isPreparing, !isAuthorizing, attemptState.prepared == nil else {
            return
        }
        isPreparing = true
        defer { isPreparing = false }
        guard let binding = await model.prepareAppleAuthorization() else {
            return
        }
        attemptState.prepare(binding)
    }
}
