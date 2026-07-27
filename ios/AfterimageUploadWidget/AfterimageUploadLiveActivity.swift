import ActivityKit
import SwiftUI
import WidgetKit

struct AfterimageUploadLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: UploadActivityAttributes.self) { context in
            // Lock screen / StandBy banner
            lockScreenView(context: context)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.title2)
                        .foregroundStyle(.orange)
                }
                DynamicIslandExpandedRegion(.center) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(context.state.stage)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Text(context.attributes.filename)
                            .font(.caption2)
                            .lineLimit(1)
                            .foregroundStyle(.tertiary)
                    }
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Text("\(Int(context.state.progress * 100))%")
                        .font(.caption.monospacedDigit().bold())
                        .foregroundStyle(.orange)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    ProgressView(value: context.state.progress)
                        .tint(.orange)
                }
            } compactLeading: {
                Image(systemName: "arrow.up.circle.fill")
                    .foregroundStyle(.orange)
            } compactTrailing: {
                Text("\(Int(context.state.progress * 100))%")
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(.orange)
            } minimal: {
                Image(systemName: "arrow.up.circle.fill")
                    .foregroundStyle(.orange)
            }
        }
    }

    private func lockScreenView(context: ActivityViewContext<UploadActivityAttributes>) -> some View {
        HStack(spacing: 12) {
            Image(systemName: "arrow.up.circle.fill")
                .font(.title3)
                .foregroundStyle(.orange)

            VStack(alignment: .leading, spacing: 3) {
                Text(context.state.stage)
                    .font(.subheadline.weight(.medium))
                if context.state.total > 1 {
                    Text("\(context.state.current) / \(context.state.total)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            Spacer()

            VStack(alignment: .trailing, spacing: 3) {
                Text("\(Int(context.state.progress * 100))%")
                    .font(.subheadline.monospacedDigit().bold())
                    .foregroundStyle(.orange)
                ProgressView(value: context.state.progress)
                    .frame(width: 60)
                    .tint(.orange)
            }
        }
        .padding(16)
        .activityBackgroundTint(.black.opacity(0.85))
    }
}
