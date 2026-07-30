import SwiftUI
import UIKit

struct CameraCaptureView: View {
    @EnvironmentObject private var appModel: AppModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var model = CameraCaptureModel(client: .live())
    @State private var isShowingDiscardConfirmation = false
    @State private var isShowingUploadBusyNotice = false
    @State private var dismissAfterFinalization = false

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            content
        }
        .preferredColorScheme(.dark)
        .interactiveDismissDisabled()
        .task {
            await model.start()
        }
        .onDisappear {
            model.discard()
        }
        .onChange(of: scenePhase) { _, phase in
            switch CameraCapturePolicy.sceneChangeAction(for: sceneChange(for: phase)) {
            case .resume:
                model.sceneBecameActive()
            case .ignore:
                break
            case .suspend:
                model.sceneBecameInactive()
            }
        }
        .onChange(of: model.state) { _, state in
            guard dismissAfterFinalization else { return }
            switch state {
            case .review, .failed:
                model.discard()
                dismiss()
            default:
                break
            }
        }
        .onChange(of: model.accessibilityAnnouncement) { _, announcement in
            guard let announcement else { return }
            UIAccessibility.post(
                notification: .announcement,
                argument: announcementText(for: announcement.kind)
            )
        }
        .alert(
            L10n.string("camera.microphone.title"),
            isPresented: silentRecordingConfirmation
        ) {
            Button(L10n.string("camera.action.record_without_audio")) {
                model.continueWithoutAudio()
            }
            Button(L10n.string("camera.action.cancel"), role: .cancel) {
                model.cancelSilentRecording()
            }
        } message: {
            Text(L10n.string("camera.microphone.message"))
        }
        .alert(
            L10n.string("camera.upload_busy.title"),
            isPresented: $isShowingUploadBusyNotice
        ) {
            Button(L10n.string("camera.action.close"), role: .cancel) {}
        } message: {
            Text(L10n.string("camera.upload_busy.message"))
        }
        .confirmationDialog(
            L10n.string("camera.discard.title"),
            isPresented: $isShowingDiscardConfirmation,
            titleVisibility: .visible
        ) {
            Button(L10n.string("camera.discard.confirm"), role: .destructive) {
                discardAndDismiss()
            }
            Button(L10n.string("camera.action.cancel"), role: .cancel) {}
        } message: {
            Text(L10n.string("camera.discard.message"))
        }
    }

    @ViewBuilder
    private var content: some View {
        switch model.state {
        case .authorizing, .configuring:
            ZStack(alignment: .topLeading) {
                ProgressView(L10n.string("camera.status.configuring"))
                    .tint(.white)
                    .foregroundStyle(.white)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                Button {
                    requestClose()
                } label: {
                    Image(systemName: "xmark")
                        .frame(width: 44, height: 44)
                }
                .buttonStyle(.glass)
                .buttonBorderShape(.circle)
                .accessibilityLabel(L10n.string("camera.action.close"))
                .padding(20)
            }
        case .ready, .recording:
            captureSurface
        case .confirmingSilentRecording:
            captureSurface
        case .finalizing:
            captureSurface
                .overlay {
                    VStack(spacing: 14) {
                        ProgressView()
                            .controlSize(.large)
                        Text(L10n.string("camera.status.finalizing"))
                            .font(.callout.weight(.semibold))
                    }
                    .padding(24)
                    .glassEffect(.regular, in: .rect(cornerRadius: 24))
                }
        case .review(let video):
            review(video)
        case .interrupted:
            status(
                systemImage: "video.slash.fill",
                title: L10n.string("camera.status.interrupted"),
                message: nil,
                opensSettings: false,
                canRetry: true
            )
        case .failed(let failure):
            status(
                systemImage: "exclamationmark.triangle.fill",
                title: errorTitle(for: failure),
                message: errorMessage(for: failure),
                opensSettings: failure == .cameraPermissionDenied,
                canRetry: failure != .cameraPermissionDenied
            )
        case .transferred:
            ProgressView()
                .tint(.white)
        }
    }

    private var captureSurface: some View {
        CameraLiveCaptureView(
            model: model,
            onClose: requestClose
        )
    }

    private func review(_ video: CameraCapturedVideo) -> some View {
        CameraCaptureReviewView(
            video: video,
            onClose: {
                isShowingDiscardConfirmation = true
            },
            onRetake: {
                Task {
                    await model.retake()
                }
            },
            onUseVideo: {
                if model.transfer({ appModel.importCapturedMedia($0) }) {
                    dismiss()
                } else {
                    isShowingUploadBusyNotice = true
                }
            }
        )
    }

    private func status(
        systemImage: String,
        title: String,
        message: String?,
        opensSettings: Bool,
        canRetry: Bool
    ) -> some View {
        CameraCaptureStatusView(
            systemImage: systemImage,
            title: title,
            message: message,
            opensSettings: opensSettings,
            canRetry: canRetry,
            onRetry: {
                Task {
                    await model.retry()
                }
            },
            onClose: {
                model.discard()
                dismiss()
            }
        )
    }

    private var silentRecordingConfirmation: Binding<Bool> {
        Binding(
            get: { model.state == .confirmingSilentRecording },
            set: { presented in
                if !presented {
                    model.cancelSilentRecording()
                }
            }
        )
    }

    private func sceneChange(for phase: ScenePhase) -> CameraScenePhaseChange {
        switch phase {
        case .active: .active
        case .background: .background
        default: .inactive
        }
    }

    private func requestClose() {
        switch model.state {
        case .recording, .finalizing, .review:
            isShowingDiscardConfirmation = true
        default:
            model.discard()
            dismiss()
        }
    }

    private func discardAndDismiss() {
        switch model.state {
        case .recording:
            dismissAfterFinalization = true
            model.stopRecording()
        case .finalizing:
            dismissAfterFinalization = true
        default:
            model.discard()
            dismiss()
        }
    }

    private func errorTitle(for failure: CameraCaptureFailure) -> String {
        switch failure {
        case .cameraPermissionDenied:
            L10n.string("camera.permission.title")
        case .cameraUnavailable:
            L10n.string("camera.error.unavailable")
        case .configurationFailed:
            L10n.string("camera.error.configuration")
        case .recordingFailed:
            L10n.string("camera.error.recording")
        case .insufficientStorage:
            L10n.string("camera.error.insufficient_storage")
        }
    }

    private func errorMessage(
        for failure: CameraCaptureFailure
    ) -> String? {
        switch failure {
        case .cameraPermissionDenied:
            L10n.string("camera.permission.message")
        case .insufficientStorage:
            L10n.string("camera.error.insufficient_storage_message")
        default:
            L10n.string("camera.error.retry_message")
        }
    }

    private func announcementText(
        for kind: CameraAccessibilityAnnouncementKind
    ) -> String {
        switch kind {
        case .recordingStarted:
            L10n.string("camera.accessibility.announcement.recording_started")
        case .silentRecordingStarted:
            L10n.string(
                "camera.accessibility.announcement.silent_recording_started"
            )
        case .recordingStopped:
            L10n.string("camera.accessibility.announcement.recording_stopped")
        case .captureFailed:
            L10n.string("camera.accessibility.announcement.capture_failed")
        case .reviewReady:
            L10n.string("camera.accessibility.announcement.review_ready")
        }
    }
}
