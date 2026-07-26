import SwiftUI

struct GlassProgressPill: View {
    let upload: UploadPresentation

    var body: some View {
        HStack(spacing: 12) {
            ProgressView(value: upload.progress)
                .progressViewStyle(.circular)
                .controlSize(.small)
            VStack(alignment: .leading, spacing: 2) {
                Text(upload.stage.title)
                    .font(.caption.weight(.semibold))
                    .lineLimit(1)
                if upload.total > 1 {
                    Text("\(upload.current) / \(upload.total)")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding(.horizontal, 14)
        .frame(height: 52)
        .glassEffect(.regular, in: .capsule)
        .accessibilityElement(children: .combine)
        .accessibilityValue("\(Int(upload.progress * 100))パーセント")
    }
}
