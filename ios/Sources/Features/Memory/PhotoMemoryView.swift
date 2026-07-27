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
                ZoomableImageView(image: image, onSingleTap: onSingleTap)
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
                    Button("再試行") {
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
            }
        }
    }
}
