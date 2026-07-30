import UIKit
import UserNotifications

final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func application(
        _ application: UIApplication,
        handleEventsForBackgroundURLSession identifier: String,
        completionHandler: @escaping () -> Void
    ) {
        BackgroundUploadManager.shared.handleBackgroundSessionEvents(
            completionHandler: completionHandler
        )
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        if DailyPostReminderPolicy.isReminder(identifier: notification.request.identifier) {
            return []
        }
        return [.banner, .sound]
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        let isReminderTap = response.actionIdentifier == UNNotificationDefaultActionIdentifier
            && DailyPostReminderPolicy.isReminder(identifier: response.notification.request.identifier)
        guard isReminderTap else { return }
        await MainActor.run {
            NotificationIntentRouter.shared.requestCameraCapture()
        }
    }
}
