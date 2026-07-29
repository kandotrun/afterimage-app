import SwiftUI

struct CaptureLocationChip: View {
    let location: CaptureLocation
    @State private var placeName: String?

    private var label: String {
        placeName ?? L10n.string("capture.location.open_maps")
    }

    var body: some View {
        Group {
            if let destination = location.appleMapsURL {
                Link(destination: destination) {
                    content
                }
            }
        }
        .task(id: location) {
            placeName = nil
            let resolvedName = await CapturePlaceNameResolver.shared.name(for: location)
            guard !Task.isCancelled else { return }
            placeName = resolvedName
        }
        .accessibilityLabel(
            L10n.format(
                "capture.location.accessibility",
                label as NSString
            )
        )
    }

    private var content: some View {
        Label {
            Text(verbatim: label)
        } icon: {
            Image(systemName: "mappin.and.ellipse")
        }
            .font(.caption2.weight(.semibold))
            .lineLimit(1)
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .background(.black.opacity(0.58), in: .capsule)
            .foregroundStyle(.white)
    }
}
