import ActivityKit
import Foundation

/// Shared between the app and the widget extension.
struct UploadActivityAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable {
        /// Localized stage description.
        var stage: String
        /// 0.0 ... 1.0
        var progress: Double
        /// Current item index (1-based).
        var current: Int
        /// Total items in the batch.
        var total: Int
    }

    /// Display name of the primary file being uploaded.
    var filename: String
}
