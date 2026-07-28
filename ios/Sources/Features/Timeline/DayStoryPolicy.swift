import Foundation

/// One day's story: the most narrative-rich memory leads, the rest follow.
struct DayStory: Equatable {
    let hero: Asset
    let strip: [Asset]
    let quote: String?
}

enum DayStoryPolicy {
    /// `assets` is one day's memories, newest first (timeline order).
    static func story(for assets: [Asset]) -> DayStory? {
        guard let newest = assets.first else { return nil }
        let hero = assets.first { $0.mediaType == .video && $0.transcriptionStatus == .completed }
            ?? assets.first { $0.mediaType == .video }
            ?? newest
        let quote = assets
            .compactMap { $0.transcriptPreview?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .first { !$0.isEmpty }
        return DayStory(hero: hero, strip: assets.filter { $0.id != hero.id }, quote: quote)
    }
}
