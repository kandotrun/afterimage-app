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
        .task { await model.bootstrap() }
        .alert(item: $model.notice) { notice in
            Alert(title: Text(notice.title), message: Text(notice.message), dismissButton: .default(Text("閉じる")))
        }
    }
}
