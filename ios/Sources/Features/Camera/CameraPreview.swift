@preconcurrency import AVFoundation
import SwiftUI
import UIKit

struct CameraPreview: UIViewRepresentable {
    let model: CameraCaptureModel
    let onFocus: (CGPoint) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(model: model, onFocus: onFocus)
    }

    func makeUIView(context: Context) -> PreviewView {
        let view = PreviewView()
        let tap = UITapGestureRecognizer(
            target: context.coordinator,
            action: #selector(Coordinator.focus)
        )
        let pinch = UIPinchGestureRecognizer(
            target: context.coordinator,
            action: #selector(Coordinator.zoom)
        )
        view.addGestureRecognizer(tap)
        view.addGestureRecognizer(pinch)
        context.coordinator.previewView = view
        model.attachPreviewLayer(view.previewLayer)
        return view
    }

    func updateUIView(_ uiView: PreviewView, context: Context) {
        context.coordinator.model = model
        context.coordinator.onFocus = onFocus
    }

    @MainActor
    final class Coordinator: NSObject {
        var model: CameraCaptureModel
        var onFocus: (CGPoint) -> Void
        weak var previewView: PreviewView?
        private var zoomStart: CGFloat = 1

        init(model: CameraCaptureModel, onFocus: @escaping (CGPoint) -> Void) {
            self.model = model
            self.onFocus = onFocus
        }

        @objc func focus(_ recognizer: UITapGestureRecognizer) {
            guard let previewView else { return }
            let layerPoint = recognizer.location(in: previewView)
            let devicePoint = previewView.previewLayer
                .captureDevicePointConverted(fromLayerPoint: layerPoint)
            model.focus(at: devicePoint)
            onFocus(layerPoint)
        }

        @objc func zoom(_ recognizer: UIPinchGestureRecognizer) {
            if recognizer.state == .began {
                zoomStart = model.zoomFactor
            }
            model.zoom(to: zoomStart * recognizer.scale)
        }
    }
}

final class PreviewView: UIView {
    override class var layerClass: AnyClass {
        AVCaptureVideoPreviewLayer.self
    }

    var previewLayer: AVCaptureVideoPreviewLayer {
        guard let layer = layer as? AVCaptureVideoPreviewLayer else {
            preconditionFailure()
        }
        return layer
    }
}
