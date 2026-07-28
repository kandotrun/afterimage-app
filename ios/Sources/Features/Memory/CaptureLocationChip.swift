import SwiftUI

struct CaptureLocationChip: View {
    let location: CaptureLocation

    var body: some View {
        Group {
            if let destination = location.appleMapsURL {
                Link(destination: destination) {
                    content
                }
            }
        }
        .accessibilityLabel(
            L10n.format(
                "capture.location.accessibility",
                location.coordinateLabel as NSString
            )
        )
    }

    private var content: some View {
        Label(location.coordinateLabel, systemImage: "mappin.and.ellipse")
            .font(.caption2.weight(.semibold).monospacedDigit())
            .lineLimit(1)
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .background(.black.opacity(0.58), in: .capsule)
            .foregroundStyle(.white)
    }
}
