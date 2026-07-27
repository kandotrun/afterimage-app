import SwiftUI

@main
struct AfterimageApp: App {
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
        .alert(item: $model.notice) { notice in
            Alert(title: Text(notice.title), message: Text(notice.message), dismissButton: .default(Text("閉じる")))
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
