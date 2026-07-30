import Combine
import Foundation

@MainActor
final class NotificationIntentRouter: ObservableObject {
    static let shared = NotificationIntentRouter()

    @Published private(set) var wantsCameraCapture = false

    func requestCameraCapture() {
        wantsCameraCapture = true
    }

    func consumeCameraCaptureRequest() -> Bool {
        defer { wantsCameraCapture = false }
        return wantsCameraCapture
    }
}
