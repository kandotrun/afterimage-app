import Combine
import Foundation

/// Bridges notification taps (delivered to the nonisolated AppDelegate) into
/// SwiftUI navigation. The timeline consumes pending intents once it is on screen,
/// so a cold launch from a reminder still lands in the camera.
@MainActor
final class NotificationIntentRouter: ObservableObject {
    static let shared = NotificationIntentRouter()

    @Published var wantsCameraCapture = false

    func requestCameraCapture() {
        wantsCameraCapture = true
    }

    func consumeCameraCaptureRequest() -> Bool {
        defer { wantsCameraCapture = false }
        return wantsCameraCapture
    }
}
