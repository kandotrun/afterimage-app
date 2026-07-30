import Foundation
import UserNotifications

enum DailyPostReminderPolicy {
    static let defaultHorizon = 60

    static func reminderDates(
        now: Date,
        lastPostedAt: Date?,
        calendar: Calendar,
        horizon: Int = defaultHorizon
    ) -> [Date] {
        let startOfToday = calendar.startOfDay(for: now)

        return (0..<max(0, horizon)).compactMap { offset in
            guard let day = calendar.date(byAdding: .day, value: offset, to: startOfToday),
                  let reminder = calendar.date(
                    bySettingHour: 22,
                    minute: 0,
                    second: 0,
                    of: day
                  ),
                  reminder > now else {
                return nil
            }
            if let lastPostedAt, calendar.isDate(lastPostedAt, inSameDayAs: day) {
                return nil
            }
            return reminder
        }
    }

    static func triggerDateComponents(for date: Date, calendar: Calendar) -> DateComponents {
        calendar.dateComponents([.calendar, .year, .month, .day, .hour, .minute], from: date)
    }
}

@MainActor
final class DailyPostReminderScheduler {
    private static let identifierPrefix = "daily-post-reminder."
    private static let lastPostedAtKey = "daily-post-reminder.last-posted-at"

    private let center: UNUserNotificationCenter
    private let defaults: UserDefaults
    private let calendar: Calendar
    private var scheduledOnDay: Date?
    private var scheduledLastPostedAt: Date?

    init(
        center: UNUserNotificationCenter = .current(),
        defaults: UserDefaults = .standard,
        calendar: Calendar = .autoupdatingCurrent
    ) {
        self.center = center
        self.defaults = defaults
        self.calendar = calendar
    }

    func refresh(observedLastPostedAt: Date?) async {
        let storedLastPostedAt = defaults.object(forKey: Self.lastPostedAtKey) as? Date
        let lastPostedAt = [storedLastPostedAt, observedLastPostedAt]
            .compactMap { $0 }
            .max()
        if let lastPostedAt {
            defaults.set(lastPostedAt, forKey: Self.lastPostedAtKey)
        }
        let today = calendar.startOfDay(for: Date())
        guard scheduledOnDay != today || lastPostedAt != scheduledLastPostedAt else { return }
        scheduledOnDay = today
        scheduledLastPostedAt = lastPostedAt
        await reschedule(lastPostedAt: lastPostedAt)
    }

    func recordPost(at date: Date = Date()) async {
        defaults.set(date, forKey: Self.lastPostedAtKey)
        scheduledOnDay = calendar.startOfDay(for: date)
        scheduledLastPostedAt = date
        await reschedule(lastPostedAt: date)
    }

    func clear() async {
        defaults.removeObject(forKey: Self.lastPostedAtKey)
        scheduledOnDay = nil
        scheduledLastPostedAt = nil
        await removePendingReminders()
    }

    private func reschedule(lastPostedAt: Date?) async {
        await removePendingReminders()
        guard await isAuthorized() else { return }

        let dates = DailyPostReminderPolicy.reminderDates(
            now: Date(),
            lastPostedAt: lastPostedAt,
            calendar: calendar
        )
        for date in dates {
            let content = UNMutableNotificationContent()
            content.title = L10n.string("notification.daily_post.title")
            content.body = L10n.string("notification.daily_post.body")
            content.sound = .default

            let components = DailyPostReminderPolicy.triggerDateComponents(
                for: date,
                calendar: calendar
            )
            let identifier = Self.identifierPrefix + String(Int(date.timeIntervalSince1970))
            let request = UNNotificationRequest(
                identifier: identifier,
                content: content,
                trigger: UNCalendarNotificationTrigger(dateMatching: components, repeats: false)
            )
            try? await center.add(request)
        }
    }

    private func isAuthorized() async -> Bool {
        let settings = await center.notificationSettings()
        switch settings.authorizationStatus {
        case .authorized, .provisional, .ephemeral:
            return true
        case .notDetermined:
            return (try? await center.requestAuthorization(options: [.alert, .sound])) == true
        case .denied:
            return false
        @unknown default:
            return false
        }
    }

    private func removePendingReminders() async {
        let pendingIdentifiers = await center.pendingNotificationRequests()
            .map(\.identifier)
            .filter { $0.hasPrefix(Self.identifierPrefix) }
        center.removePendingNotificationRequests(
            withIdentifiers: pendingIdentifiers
        )
        let deliveredIdentifiers = await center.deliveredNotifications()
            .map(\.request.identifier)
            .filter { $0.hasPrefix(Self.identifierPrefix) }
        center.removeDeliveredNotifications(
            withIdentifiers: deliveredIdentifiers
        )
    }
}
