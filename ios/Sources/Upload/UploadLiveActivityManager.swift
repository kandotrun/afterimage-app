import ActivityKit
import Foundation

/// Manages the upload Live Activity lifecycle.
/// All calls are safe to make even when activities are unsupported.
@MainActor
final class UploadLiveActivityManager {
    static let shared = UploadLiveActivityManager()

    private var currentActivity: Activity<UploadActivityAttributes>?

    private init() {}

    var isSupported: Bool {
        ActivityAuthorizationInfo().areActivitiesEnabled
    }

    func start(filename: String, stage: String, current: Int, total: Int) {
        guard isSupported else { return }
        end() // ensure only one activity at a time

        let attributes = UploadActivityAttributes(filename: filename)
        let state = UploadActivityAttributes.ContentState(
            stage: stage,
            progress: 0,
            current: current,
            total: total
        )
        let content = ActivityContent(state: state, staleDate: nil)

        do {
            currentActivity = try Activity.request(
                attributes: attributes,
                content: content,
                pushType: nil
            )
        } catch {
            // Non-fatal — upload continues without the activity.
        }
    }

    func update(stage: String, progress: Double, current: Int, total: Int) {
        guard let activity = currentActivity else { return }
        let state = UploadActivityAttributes.ContentState(
            stage: stage,
            progress: progress,
            current: current,
            total: total
        )
        let content = ActivityContent(state: state, staleDate: nil)
        Task {
            await activity.update(content)
        }
    }

    func end(finalStage: String = "完了しました") {
        guard let activity = currentActivity else { return }
        let state = UploadActivityAttributes.ContentState(
            stage: finalStage,
            progress: 1.0,
            current: 1,
            total: 1
        )
        let content = ActivityContent(state: state, staleDate: nil)
        Task {
            await activity.end(content, dismissalPolicy: .after(.now + 5))
        }
        currentActivity = nil
    }

    func cancel() {
        guard let activity = currentActivity else { return }
        Task {
            await activity.end(nil, dismissalPolicy: .immediate)
        }
        currentActivity = nil
    }
}
