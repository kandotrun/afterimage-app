import AuthenticationServices
import SwiftUI

struct LoginView: View {
    @EnvironmentObject private var model: AppModel
    @State private var isSigningIn = false

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
                SignInWithAppleButton(.continue) { request in
                    request.requestedScopes = [.fullName, .email]
                } onCompletion: { result in
                    guard case let .success(authorization) = result,
                          let credential = authorization.credential as? ASAuthorizationAppleIDCredential else {
                        isSigningIn = false
                        return
                    }
                    isSigningIn = true
                    Task {
                        await model.signIn(credential: credential)
                        isSigningIn = false
                    }
                }
                .signInWithAppleButtonStyle(.black)
                .frame(height: 50)
                .disabled(isSigningIn)

                Text("写真と動画は非公開で保存されます。動画の音は変えません。")
                    .font(.footnote)
                    .foregroundStyle(.tertiary)
                    .multilineTextAlignment(.center)
                    .padding(.top, 14)
                    .padding(.bottom, 12)
            }
            .padding(.horizontal, 24)
            .frame(maxWidth: 520)
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
