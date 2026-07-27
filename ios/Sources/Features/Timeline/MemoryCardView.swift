import SwiftUI

struct MemoryCardView: View {
    let asset: Asset
    let layout: MemoryCardLayout

    var body: some View {
        VStack(spacing: 0) {
            media
            narrative
        }
        .frame(width: layout.cardWidth)
        .background(Color(.secondarySystemBackground))
        .clipShape(.rect(cornerRadius: 30, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 30, style: .continuous)
                .stroke(Color(.separator).opacity(0.22), lineWidth: 0.5)
        }
        .shadow(color: .black.opacity(0.08), radius: 18, y: 10)
        .contentShape(.rect(cornerRadius: 30, style: .continuous))
        .accessibilityElement(children: .combine)
    }

    private var media: some View {
        ZStack(alignment: .bottom) {
            AuthenticatedThumbnail(asset: asset)
                .frame(width: layout.cardWidth, height: layout.mediaHeight)
                .clipped()

            LinearGradient(
                colors: [.clear, .black.opacity(0.56)],
                startPoint: .center,
                endPoint: .bottom
            )

            HStack(alignment: .center, spacing: 8) {
                Text(asset.capturedAt.formatted(.dateTime.hour().minute()))
                    .font(.caption.weight(.semibold))

                Spacer()

                if asset.mediaType == .video, let duration = asset.durationMs {
                    Label(Self.duration(duration), systemImage: "play.fill")
                        .font(.caption.weight(.semibold))
                }
            }
            .foregroundStyle(.white)
            .padding(16)
        }
        .frame(width: layout.cardWidth, height: layout.mediaHeight)
    }

    private var narrative: some View {
        VStack(alignment: .leading, spacing: 14) {
            narrativeText
                .frame(maxWidth: .infinity, minHeight: 66, alignment: .topLeading)

            Divider()

            HStack(spacing: 8) {
                Image(systemName: asset.mediaType == .video ? "waveform" : "camera.fill")
                    .foregroundStyle(.tint)
                Text(asset.mediaType == .video ? "音のある記憶" : "一枚の記憶")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.secondary)
                Spacer()
                Image(systemName: "arrow.up.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(18)
    }

    @ViewBuilder
    private var narrativeText: some View {
        if asset.transcriptionStatus == .completed,
           let preview = asset.transcriptPreview?.trimmingCharacters(in: .whitespacesAndNewlines),
           !preview.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Text("ことば")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(.tint)
                    .textCase(.uppercase)
                    .tracking(1.4)
                Text(preview)
                    .font(.body.weight(.medium))
                    .lineSpacing(3)
                    .lineLimit(3)
            }
        } else if asset.transcriptionStatus == .pending || asset.transcriptionStatus == .processing {
            Label {
                Text("ことばを残しています…")
                    .font(.body.weight(.medium))
            } icon: {
                Image(systemName: "waveform")
                    .foregroundStyle(.tint)
                    .symbolEffect(.variableColor.iterative)
            }
        } else if asset.transcriptionStatus == .failed {
            Label("ことばを残せませんでした", systemImage: "exclamationmark.bubble")
                .font(.body.weight(.medium))
                .foregroundStyle(.secondary)
        } else if asset.mediaType == .video {
            Text("映像と音で残した記憶")
                .font(.body.weight(.medium))
        } else {
            Text("写真に残した瞬間")
                .font(.body.weight(.medium))
        }
    }

    private static func duration(_ milliseconds: Int) -> String {
        let seconds = max(0, milliseconds / 1_000)
        return String(format: "%d:%02d", seconds / 60, seconds % 60)
    }
}
