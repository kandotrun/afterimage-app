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
                    .tint(Color(red: 1.0, green: 0.40, blue: 0.36))
            } else {
                RootView()
                    .environmentObject(model)
                    .tint(Color(red: 1.0, green: 0.40, blue: 0.36))
            }
            #else
            RootView()
                .environmentObject(model)
                .tint(Color(red: 1.0, green: 0.40, blue: 0.36))
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
                    ProgressView()
                        .controlSize(.large)
                }
            } else if model.isAuthenticated {
                TimelineView()
            } else {
                LoginView()
            }
        }
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
            await model.applyDevSessionToken(arguments[index + 1])
            return
        }
        #endif
        await model.bootstrap()
    }
}
