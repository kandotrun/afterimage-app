import Foundation

struct DayStory: Equatable {
    let hero: Asset
    let strip: [Asset]
}

enum DayStoryPolicy {
    static func story(for assets: [Asset]) -> DayStory? {
        guard let newest = assets.first else { return nil }
        let hero = assets.first { $0.mediaType == .video && $0.transcriptionStatus == .completed }
            ?? assets.first { $0.mediaType == .video }
            ?? newest
        let strip = hero.mediaType == .video ? assets : assets.filter { $0.id != hero.id }
        return DayStory(hero: hero, strip: strip)
    }
}
