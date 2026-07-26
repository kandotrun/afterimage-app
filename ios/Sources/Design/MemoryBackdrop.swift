import SwiftUI

struct MemoryBackdrop<Content: View>: View {
    @ViewBuilder let content: () -> Content

    var body: some View {
        ZStack {
            Color(.systemBackground).ignoresSafeArea()
            RadialGradient(
                colors: [Color.orange.opacity(0.18), .clear],
                center: .topLeading,
                startRadius: 10,
                endRadius: 420
            )
            .ignoresSafeArea()
            RadialGradient(
                colors: [Color.blue.opacity(0.12), .clear],
                center: .bottomTrailing,
                startRadius: 20,
                endRadius: 460
            )
            .ignoresSafeArea()
            content()
        }
    }
}

struct AfterglowMark: View {
    var body: some View {
        ZStack {
            Circle()
                .fill(Color.orange.opacity(0.55))
                .frame(width: 92, height: 92)
                .blur(radius: 20)
                .offset(x: -12, y: -8)
            Circle()
                .fill(Color.blue.opacity(0.42))
                .frame(width: 80, height: 80)
                .blur(radius: 18)
                .offset(x: 18, y: 12)
            Circle()
                .strokeBorder(.white.opacity(0.78), lineWidth: 1.5)
                .frame(width: 70, height: 70)
            Circle()
                .fill(.white.opacity(0.92))
                .frame(width: 10, height: 10)
        }
        .frame(width: 120, height: 120)
        .accessibilityHidden(true)
    }
}
