import SwiftUI
import UIKit

/// UIScrollView-backed pinch-zoomable image with double-tap zoom and a single
/// tap callback (used to toggle the chrome). At minimum zoom, pans fall
/// through to the surrounding pager.
struct ZoomableImageView: UIViewRepresentable {
    let image: UIImage
    let onSingleTap: () -> Void
    let onDoubleTap: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onSingleTap: onSingleTap, onDoubleTap: onDoubleTap)
    }

    func makeUIView(context: Context) -> ZoomScrollView {
        let scrollView = ZoomScrollView()
        scrollView.delegate = context.coordinator
        scrollView.minimumZoomScale = 1
        scrollView.maximumZoomScale = 4
        scrollView.showsVerticalScrollIndicator = false
        scrollView.showsHorizontalScrollIndicator = false
        scrollView.contentInsetAdjustmentBehavior = .never
        scrollView.backgroundColor = .clear

        let imageView = UIImageView(image: image)
        imageView.contentMode = .scaleAspectFit
        scrollView.addSubview(imageView)
        context.coordinator.imageView = imageView

        let doubleTap = UITapGestureRecognizer(
            target: context.coordinator,
            action: #selector(Coordinator.handleDoubleTap(_:))
        )
        doubleTap.numberOfTapsRequired = 2
        scrollView.addGestureRecognizer(doubleTap)

        let singleTap = UITapGestureRecognizer(
            target: context.coordinator,
            action: #selector(Coordinator.handleSingleTap)
        )
        singleTap.require(toFail: doubleTap)
        scrollView.addGestureRecognizer(singleTap)

        scrollView.onLayout = { [weak scrollView, coordinator = context.coordinator] in
            guard let scrollView else { return }
            coordinator.relayout(scrollView)
        }
        return scrollView
    }

    func updateUIView(_ scrollView: ZoomScrollView, context: Context) {
        context.coordinator.onSingleTap = onSingleTap
        context.coordinator.onDoubleTap = onDoubleTap
        if context.coordinator.imageView?.image !== image {
            context.coordinator.imageView?.image = image
            scrollView.setZoomScale(1, animated: false)
            context.coordinator.relayout(scrollView)
        }
    }

    final class ZoomScrollView: UIScrollView {
        var onLayout: (() -> Void)?

        override func layoutSubviews() {
            super.layoutSubviews()
            onLayout?()
        }
    }

    @MainActor
    final class Coordinator: NSObject, UIScrollViewDelegate {
        var onSingleTap: () -> Void
        var onDoubleTap: () -> Void
        weak var imageView: UIImageView?

        init(onSingleTap: @escaping () -> Void, onDoubleTap: @escaping () -> Void) {
            self.onSingleTap = onSingleTap
            self.onDoubleTap = onDoubleTap
        }

        func relayout(_ scrollView: UIScrollView) {
            guard let imageView, let image = imageView.image,
                  scrollView.bounds.width > 0, scrollView.bounds.height > 0 else { return }
            if scrollView.zoomScale == scrollView.minimumZoomScale {
                let bounds = scrollView.bounds.size
                let scale = min(bounds.width / image.size.width, bounds.height / image.size.height)
                let fitted = CGSize(width: image.size.width * scale, height: image.size.height * scale)
                imageView.frame = CGRect(origin: .zero, size: fitted)
                scrollView.contentSize = fitted
            }
            center(scrollView)
        }

        func viewForZooming(in scrollView: UIScrollView) -> UIView? {
            imageView
        }

        func scrollViewDidZoom(_ scrollView: UIScrollView) {
            center(scrollView)
        }

        private func center(_ scrollView: UIScrollView) {
            let insetX = max((scrollView.bounds.width - scrollView.contentSize.width) / 2, 0)
            let insetY = max((scrollView.bounds.height - scrollView.contentSize.height) / 2, 0)
            scrollView.contentInset = UIEdgeInsets(top: insetY, left: insetX, bottom: insetY, right: insetX)
        }

        @objc func handleDoubleTap(_ gesture: UITapGestureRecognizer) {
            guard let scrollView = gesture.view as? UIScrollView else { return }
            onDoubleTap()
            if scrollView.zoomScale > scrollView.minimumZoomScale {
                scrollView.setZoomScale(scrollView.minimumZoomScale, animated: true)
            } else {
                let point = gesture.location(in: imageView)
                let width = scrollView.bounds.width / 2.5
                let height = scrollView.bounds.height / 2.5
                let target = CGRect(x: point.x - width / 2, y: point.y - height / 2, width: width, height: height)
                scrollView.zoom(to: target, animated: true)
            }
        }

        @objc func handleSingleTap() {
            onSingleTap()
        }
    }
}
