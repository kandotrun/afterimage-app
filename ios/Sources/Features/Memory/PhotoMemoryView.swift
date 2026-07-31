import SwiftUI
import UIKit

struct PhotoMemoryView: View {
    @EnvironmentObject private var model: AppModel
    let asset: Asset
    let onSingleTap: () -> Void

    @State private var thumbnail: UIImage?
    @State private var fullImage: UIImage?
    @State private var loadError: String?

    var body: some View {
        ZStack {
            if let image = fullImage ?? thumbnail {
                ZoomableImageView(
                    image: image,
                    onSingleTap: onSingleTap,
                    onDoubleTap: { model.playHaptic(.lift) }
                )
                    // UIImageView is invisible to VoiceOver by default; without
                    // this, the photo page reads as an empty screen.
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(
                        L10n.format(
                            "accessibility.photo_at",
                            asset.capturedAt.formatted() as NSString
                        )
                    )
                    .accessibilityAddTraits(.isImage)
                    .accessibilityAction { onSingleTap() }
            } else if loadError == nil {
                ProgressView().tint(.white)
            }
            if let loadError {
                VStack(spacing: 14) {
                    Image(systemName: "exclamationmark.circle")
                        .font(.largeTitle)
                    Text(loadError)
                        .font(.callout)
                        .multilineTextAlignment(.center)
                    Button(L10n.string("action.retry")) {
                        model.playHaptic(.lift)
                        Task { await load() }
                    }
                    .buttonStyle(.glass)
                }
                .foregroundStyle(.white.opacity(0.82))
                .padding(28)
            }
        }
        .task(id: asset.id) { await load() }
    }

    private func load() async {
        loadError = nil
        guard fullImage == nil else { return }
        if thumbnail == nil, asset.thumbnailUrl != nil,
           let data = try? await model.thumbnailData(for: asset) {
            thumbnail = UIImage(data: data)
        }
        do {
            let data = try await model.photoData(for: asset)
            guard let image = UIImage(data: data) else { throw AfterimageError.invalidResponse }
            fullImage = image
        } catch {
            if fullImage == nil, thumbnail == nil {
                loadError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
                model.playHaptic(.failure)
            }
        }
    }
}
