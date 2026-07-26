import AuthenticationServices
import SwiftUI

struct LoginView: View {
    @EnvironmentObject private var model: AppModel
    @State private var isSigningIn = false

    var body: some View {
        MemoryBackdrop {
            VStack(alignment: .leading, spacing: 0) {
                Spacer()
                AfterglowMark()
                    .padding(.bottom, 24)
                Text("afterimage")
                    .font(.system(size: 48, weight: .bold, design: .rounded))
                    .tracking(-2)
                Text("撮った日々が、\nあとから見つかる。")
                    .font(.title2.weight(.medium))
                    .foregroundStyle(.secondary)
                    .padding(.top, 12)
                    .lineSpacing(4)
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
                .signInWithAppleButtonStyle(.whiteOutline)
                .frame(height: 54)
                .clipShape(.rect(cornerRadius: 17))
                .disabled(isSigningIn)

                Text("写真と動画は非公開で保存されます。動画の音は変えません。")
                    .font(.footnote)
                    .foregroundStyle(.tertiary)
                    .padding(.top, 14)
                    .padding(.bottom, 24)
            }
            .padding(.horizontal, 28)
            .frame(maxWidth: 520)
        }
    }
}
