import SwiftUI
import UIKit

struct CameraCaptureReviewView: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    let video: CameraCapturedVideo
    let onClose: () -> Void
    let onRetake: () -> Void
    let onUseVideo: () -> Void

    var body: some View {
        ZStack {
            ReviewVideoView(url: video.url)
                .ignoresSafeArea()
            VStack {
                HStack {
                    Button(action: onClose) {
                        Image(systemName: "xmark")
                            .frame(width: 44, height: 44)
                    }
                    .buttonStyle(.glass)
                    .buttonBorderShape(.circle)
                    .accessibilityLabel(
                        L10n.string("camera.action.close")
                    )
                    Spacer()
                }
                Spacer()
                if !video.hasAudio {
                    Text(L10n.string("camera.status.no_audio"))
                        .font(.caption.weight(.semibold))
                        .padding(.horizontal, 12)
                        .padding(.vertical, 7)
                        .glassEffect(.regular, in: .capsule)
                        .padding(.bottom, 12)
                }
                reviewActions
            }
            .padding(20)
        }
    }

    private var reviewActions: some View {
        let layout = dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(spacing: 12))
            : AnyLayout(HStackLayout(spacing: 12))
        return layout {
            Button(
                L10n.string("camera.action.retake"),
                systemImage: "arrow.counterclockwise",
                action: onRetake
            )
            .buttonStyle(.glass)
            .frame(
                maxWidth: dynamicTypeSize.isAccessibilitySize
                    ? .infinity
                    : nil
            )
            .accessibilityLabel(
                L10n.string("camera.action.retake")
            )

            Button(
                L10n.string("camera.action.use_video"),
                systemImage: "checkmark",
                action: onUseVideo
            )
            .buttonStyle(.glassProminent)
            .frame(
                maxWidth: dynamicTypeSize.isAccessibilitySize
                    ? .infinity
                    : nil
            )
            .accessibilityLabel(
                L10n.string("camera.action.use_video")
            )
        }
    }
}

struct CameraCaptureStatusView: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    let systemImage: String
    let title: String
    let message: String?
    let opensSettings: Bool
    let canRetry: Bool
    let onRetry: () -> Void
    let onClose: () -> Void

    @ViewBuilder
    var body: some View {
        if dynamicTypeSize.isAccessibilitySize {
            scrollableStatusContent
        } else {
            ViewThatFits(in: .vertical) {
                statusContent
                scrollableStatusContent
            }
        }
    }

    private var scrollableStatusContent: some View {
        ScrollView {
            statusContent
                .containerRelativeFrame(.vertical, alignment: .center)
        }
        .scrollBounceBehavior(.basedOnSize)
    }

    private var statusContent: some View {
        VStack(spacing: 18) {
            Image(systemName: systemImage)
                .font(.system(size: 44))
            Text(title)
                .font(.title3.weight(.semibold))
                .multilineTextAlignment(.center)
            if let message {
                Text(message)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
            if opensSettings {
                Button(L10n.string("camera.action.open_settings")) {
                    guard let url = URL(
                        string: UIApplication.openSettingsURLString
                    ) else {
                        return
                    }
                    UIApplication.shared.open(url)
                }
                .buttonStyle(.glassProminent)
                .accessibilityLabel(
                    L10n.string("camera.action.open_settings")
                )
            }
            if canRetry {
                Button(
                    L10n.string("camera.action.retry"),
                    action: onRetry
                )
                .buttonStyle(.glassProminent)
                .accessibilityLabel(L10n.string("camera.action.retry"))
                .accessibilityIdentifier("cameraRetryButton")
            }
            Button(
                L10n.string("camera.action.close"),
                action: onClose
            )
            .buttonStyle(.glass)
        }
        .frame(maxWidth: .infinity)
        .padding(30)
    }
}
