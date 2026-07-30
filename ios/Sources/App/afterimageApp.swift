import SwiftUI

@main
struct AfterimageApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
    @StateObject private var model = AppModel.live()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(model)
                .tint(Color(red: 1.0, green: 0.40, blue: 0.36))
        }
    }
}

struct RootView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        Group {
            if model.isBootstrapping {
                MemoryBackdrop {
                    LaunchMomentView()
                }
                .transition(.opacity)
            } else if model.isAuthenticated {
                TimelineView()
                    .transition(.opacity)
            } else {
                LoginView()
                    .transition(.opacity)
            }
        }
        .animation(.easeInOut(duration: 0.35), value: model.isBootstrapping)
        .task { await launch() }
        .onChange(of: scenePhase) {
            guard scenePhase == .active else { return }
            Task { await model.resumeBackgroundUploadIfNeeded(retryAfterFailure: false) }
        }
        .alert(item: $model.notice) { notice in
            if model.backgroundUploadNeedsRetry {
                return Alert(
                    title: Text(notice.title),
                    message: Text(notice.message),
                    primaryButton: .default(Text(L10n.string("action.retry"))) {
                        Task { await model.retryBackgroundUpload() }
                    },
                    secondaryButton: .cancel(Text(L10n.string("action.cancel"))) {
                        model.cancelUpload()
                    }
                )
            }
            return Alert(
                title: Text(notice.title),
                message: Text(notice.message),
                dismissButton: .default(Text("閉じる"))
            )
        }
    }

    private func launch() async {
        let arguments = ProcessInfo.processInfo.arguments
        #if DEBUG
        if let index = arguments.firstIndex(of: "-afterimageDevSession"),
           arguments.indices.contains(index + 1) {
            await model.applyDevSessionToken(arguments[index + 1])
            await model.resumeBackgroundUploadIfNeeded(retryAfterFailure: false)
            return
        }
        #endif
        await model.bootstrap()
    }
}

/// The daily front door: the brand mark breathing instead of an anonymous spinner.
private struct LaunchMomentView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var pulsing = false

    var body: some View {
        VStack(spacing: 18) {
            Image("BrandMark")
                .resizable()
                .scaledToFit()
                .frame(width: 88, height: 88)
                .clipShape(.rect(cornerRadius: 20))
                .opacity(pulsing && !reduceMotion ? 0.55 : 1)
                .animation(
                    reduceMotion ? nil : .easeInOut(duration: 1.1).repeatForever(autoreverses: true),
                    value: pulsing
                )
            Text(verbatim: "afterimage")
                .font(.title2.bold())
        }
        .onAppear { pulsing = true }
        .accessibilityHidden(true)
    }
}
