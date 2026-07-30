import SwiftUI

struct UploadStatusBar: View {
    let upload: UploadPresentation
    let isPreviewPlaybackAllowed: Bool

    private var title: String {
        upload.stage == .uploading
            ? L10n.string("upload.status.saving")
            : upload.stage.title
    }

    var body: some View {
        HStack(spacing: 12) {
            UploadPreviewPlayer(
                upload: upload,
                isPlaybackAllowed: isPreviewPlaybackAllowed
            )
                .frame(width: 88)

            VStack(alignment: .leading, spacing: 6) {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)

                if upload.total > 1 && upload.current > 0 {
                    Text(verbatim: "\(upload.current) / \(upload.total)")
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(.secondary)
                }

                ProgressView(value: upload.progress, total: 1)
                    .progressViewStyle(.linear)
                    .tint(.accentColor)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassEffect(
            .regular,
            in: RoundedRectangle(cornerRadius: 20, style: .continuous)
        )
        .accessibilityElement(children: .combine)
        .accessibilityValue(
            L10n.format(
                "accessibility.upload_progress",
                upload.progress.formatted(.percent.precision(.fractionLength(0))) as NSString
            )
        )
    }
}
