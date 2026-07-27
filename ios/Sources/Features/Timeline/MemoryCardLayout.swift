import SwiftUI

struct MemoryCardLayout {
    let cardWidth: CGFloat
    let mediaHeight: CGFloat

    init(containerWidth: CGFloat) {
        cardWidth = min(420, max(280, containerWidth - 48))
        mediaHeight = cardWidth * 0.72
    }
}
