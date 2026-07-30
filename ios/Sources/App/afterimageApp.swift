import SwiftUI

@main
struct AfterimageApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
    @StateObject private var model = AppModel.live()

    var body: some Scene {
        WindowGroup {
            #if DEBUG
            if let scene = AppStoreScreenshotScene.launchScene {
                AppStoreScreenshotFixtureView(scene: scene)
                    .tint(.accentColor)
            } else {
                RootView()
                    .environmentObject(model)
                    .tint(.accentColor)
            }
            #else
            RootView()
                .environmentObject(model)
                .tint(.accentColor)
            #endif
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
            if model.localCleanupNeedsRetry {
                return Alert(
                    title: Text(notice.title),
                    message: Text(notice.message),
                    primaryButton: .default(Text(L10n.string("action.retry"))) {
                        Task { await model.retryLocalCleanup() }
                    },
                    secondaryButton: .cancel()
                )
            }
            if model.isAuthenticated && model.backgroundUploadNeedsRetry {
                if model.requiresCancellationCleanup {
                    return Alert(
                        title: Text(notice.title),
                        message: Text(notice.message),
                        primaryButton: .default(Text(L10n.string("action.retry"))) {
                            Task { await model.retryBackgroundUpload() }
                        },
                        secondaryButton: .cancel()
                    )
                }
                return Alert(
                    title: Text(notice.title),
                    message: Text(notice.message),
                    primaryButton: .default(Text(L10n.string("action.retry"))) {
                        Task { await model.retryBackgroundUpload() }
                    },
                    secondaryButton: .destructive(Text(L10n.string("upload.discard"))) {
                        Task { await model.discardBackgroundUpload() }
                    }
                )
            }
            return Alert(
                title: Text(notice.title),
                message: Text(notice.message),
                dismissButton: .default(Text(L10n.string("action.close")))
            )
        }
    }

    private func launch() async {
        let arguments = ProcessInfo.processInfo.arguments
        #if DEBUG
        if let index = arguments.firstIndex(of: "-afterimageDevSession"),
           arguments.indices.contains(index + 1) {
            let accountID: String?
            if let accountIndex = arguments.firstIndex(of: "-afterimageDevAccountID"),
               arguments.indices.contains(accountIndex + 1) {
                accountID = arguments[accountIndex + 1]
            } else {
                accountID = nil
            }
            await model.applyDevSessionToken(
                arguments[index + 1],
                accountID: accountID
            )
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
