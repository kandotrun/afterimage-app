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
            if model.backgroundUploadNeedsRetry || model.localCleanupNeedsRetry {
                return Alert(
                    title: Text(notice.title),
                    message: Text(notice.message),
                    primaryButton: .default(Text(L10n.string("action.retry"))) {
                        Task {
                            if model.localCleanupNeedsRetry {
                                await model.retryLocalCleanup()
                            } else {
                                await model.retryBackgroundUpload()
                            }
                        }
                    },
                    secondaryButton: .cancel(Text(L10n.string("action.cancel"))) {
                        if !model.localCleanupNeedsRetry {
                            model.cancelUpload()
                        }
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
            await model.resumeBackgroundUploadIfNeeded(retryAfterFailure: false)
            return
        }
        #endif
        await model.bootstrap()
    }
}
