import SwiftUI

struct CameraLiveCaptureView: View {
    @EnvironmentObject private var appModel: AppModel
    @ObservedObject var model: CameraCaptureModel
    let onClose: () -> Void
    @State private var focusPoint: CGPoint?

    var body: some View {
        GeometryReader { proxy in
            ZStack {
                CameraPreview(model: model) { point in
                    focusPoint = point
                    appModel.playHaptic(.focus)
                    Task {
                        try? await Task.sleep(for: .seconds(1))
                        if focusPoint == point {
                            focusPoint = nil
                        }
                    }
                }
                .ignoresSafeArea()
                .accessibilityHidden(true)

                if let focusPoint {
                    RoundedRectangle(cornerRadius: 8)
                        .stroke(.yellow, lineWidth: 2)
                        .frame(width: 72, height: 72)
                        .position(focusPoint)
                        .allowsHitTesting(false)
                        .transition(.scale.combined(with: .opacity))
                }

                VStack {
                    topControls
                    Spacer()
                    if case .recording(let startedAt) = model.state {
                        RecordingDurationView(startedAt: startedAt)
                            .padding(.top, 10)
                    }
                    captureControl
                        .padding(.top, 18)
                        .padding(.bottom, max(proxy.safeAreaInsets.bottom, 18))
                }
                .padding(.horizontal, 20)
                .padding(.top, max(proxy.safeAreaInsets.top, 14))
            }
        }
    }

    private var topControls: some View {
        HStack {
            Button(action: onClose) {
                Image(systemName: "xmark")
                    .frame(width: 44, height: 44)
            }
            .buttonStyle(.glass)
            .buttonBorderShape(.circle)
            .accessibilityLabel(L10n.string("camera.action.close"))

            Spacer()

            if model.showsNoAudioBadge {
                Text(L10n.string("camera.status.no_audio"))
                    .font(.caption.weight(.semibold))
                    .padding(.horizontal, 12)
                    .padding(.vertical, 7)
                    .glassEffect(.regular, in: .capsule)
            }

            Spacer()

            Button {
                Task {
                    await model.switchCamera()
                    if model.state == .ready {
                        appModel.playHaptic(.selection)
                    }
                }
            } label: {
                Image(systemName: "arrow.triangle.2.circlepath.camera")
                    .frame(width: 44, height: 44)
            }
            .buttonStyle(.glass)
            .buttonBorderShape(.circle)
            .disabled(model.state != .ready)
            .accessibilityLabel(
                L10n.string("camera.action.switch_camera")
            )
        }
    }

    private var captureControl: some View {
        Button {
            switch model.state {
            case .ready:
                Task {
                    await model.record()
                }
            case .recording:
                model.stopRecording()
            default:
                break
            }
        } label: {
            ZStack {
                Circle()
                    .stroke(.white, lineWidth: 5)
                    .frame(width: 78, height: 78)
                if isRecording {
                    RoundedRectangle(cornerRadius: 8)
                        .fill(.red)
                        .frame(width: 34, height: 34)
                } else {
                    Circle()
                        .fill(.red)
                        .frame(width: 64, height: 64)
                }
            }
            .contentShape(.circle)
        }
        .buttonStyle(.plain)
        .disabled(model.state != .ready && !isRecording)
        .accessibilityLabel(
            L10n.string(
                isRecording ? "camera.action.stop" : "camera.action.record"
            )
        )
        .accessibilityValue(
            L10n.string(accessibilityValueKey)
        )
    }

    private var isRecording: Bool {
        if case .recording = model.state {
            return true
        }
        return false
    }

    private var accessibilityValueKey: String {
        switch model.state {
        case .recording where model.showsNoAudioBadge:
            "camera.accessibility.state.recording_no_audio"
        case .recording:
            "camera.accessibility.state.recording"
        case .finalizing:
            "camera.accessibility.state.finalizing"
        default:
            model.showsNoAudioBadge
                ? "camera.accessibility.state.ready_no_audio"
                : "camera.accessibility.state.ready"
        }
    }
}
