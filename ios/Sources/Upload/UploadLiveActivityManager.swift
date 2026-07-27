@preconcurrency import ActivityKit
import Foundation

/// Manages the upload Live Activity lifecycle. Activity IDs are persisted by
/// the background upload coordinator so a relaunched process can reconnect.
@MainActor
final class UploadLiveActivityManager {
    static let shared = UploadLiveActivityManager()

    private var currentActivity: Activity<UploadActivityAttributes>?

    private init() {}

    var isSupported: Bool {
        ActivityAuthorizationInfo().areActivitiesEnabled
    }

    @discardableResult
    func start(filename: String, stage: String, current: Int, total: Int) -> String? {
        guard isSupported else { return nil }
        if let existing = currentActivity {
            Task { await existing.end(nil, dismissalPolicy: .immediate) }
            currentActivity = nil
        }

        let attributes = UploadActivityAttributes(filename: filename)
        let state = UploadActivityAttributes.ContentState(
            stage: stage,
            progress: 0,
            current: current,
            total: total
        )
        do {
            let activity = try Activity.request(
                attributes: attributes,
                content: ActivityContent(state: state, staleDate: nil),
                pushType: nil
            )
            currentActivity = activity
            return activity.id
        } catch {
            return nil // Upload remains fully functional without Live Activities.
        }
    }

    func update(
        activityID: String? = nil,
        stage: String,
        progress: Double,
        current: Int,
        total: Int
    ) {
        guard let activity = resolve(activityID) else { return }
        let state = UploadActivityAttributes.ContentState(
            stage: stage,
            progress: min(max(progress, 0), 1),
            current: current,
            total: total
        )
        let content = ActivityContent(state: state, staleDate: nil)
        Task { await activity.update(content) }
    }

    func end(activityID: String? = nil, finalStage: String? = nil) {
        guard let activity = resolve(activityID) else { return }
        let finalStage = finalStage ?? L10n.string("upload.stage.completed")
        let state = UploadActivityAttributes.ContentState(
            stage: finalStage,
            progress: 1,
            current: 1,
            total: 1
        )
        let content = ActivityContent(state: state, staleDate: nil)
        Task { await activity.end(content, dismissalPolicy: .after(.now + 5)) }
        if currentActivity?.id == activity.id { currentActivity = nil }
    }

    func cancel(activityID: String? = nil) {
        guard let activity = resolve(activityID) else { return }
        Task { await activity.end(nil, dismissalPolicy: .immediate) }
        if currentActivity?.id == activity.id { currentActivity = nil }
    }

    private func resolve(_ activityID: String?) -> Activity<UploadActivityAttributes>? {
        if let activityID {
            if currentActivity?.id == activityID { return currentActivity }
            return Activity<UploadActivityAttributes>.activities.first { $0.id == activityID }
        }
        return currentActivity
    }
}
