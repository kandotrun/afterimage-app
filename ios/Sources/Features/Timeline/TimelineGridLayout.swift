import SwiftUI

struct TimelineGridLayout {
    static let columnCount = 3
    static let defaultSpacing: CGFloat = 2

    let spacing: CGFloat
    let cellLength: CGFloat

    init(containerWidth: CGFloat, spacing: CGFloat = Self.defaultSpacing) {
        self.spacing = spacing
        let totalSpacing = spacing * CGFloat(Self.columnCount - 1)
        cellLength = max(0, (containerWidth - totalSpacing) / CGFloat(Self.columnCount))
    }

    var columns: [GridItem] {
        Array(
            repeating: GridItem(.fixed(cellLength), spacing: spacing),
            count: Self.columnCount
        )
    }

    var cellSize: CGSize {
        CGSize(width: cellLength, height: cellLength)
    }
}
