import Foundation

/// Pure paging decisions for the memory detail pager.
enum MemoryPagerPolicy {
    /// Selection after deleting the item at `index` from a list that had
    /// `count` items. Returns the index into the remaining list, or nil when
    /// nothing remains and the pager should dismiss.
    static func selectionAfterDeletion(of index: Int, count: Int) -> Int? {
        let remaining = count - 1
        guard remaining > 0 else { return nil }
        return min(max(0, index), remaining - 1)
    }
}
