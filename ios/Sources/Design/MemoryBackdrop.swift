import SwiftUI

struct MemoryBackdrop<Content: View>: View {
    @ViewBuilder let content: () -> Content

    var body: some View {
        ZStack {
            Color(.systemBackground).ignoresSafeArea()
            content()
        }
    }
}
