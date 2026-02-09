import Foundation

enum CategoryPreferences {
    static let storageKey = "visible_place_categories"
    static let maxAvailableCategories = 20
    static let displayedChipCount = 3

    static var availableCategories: [POICategory] {
        Array(POICategory.allCases.prefix(maxAvailableCategories))
    }

    static var defaultSelection: [POICategory] {
        normalize(Array(availableCategories.prefix(displayedChipCount)))
    }

    static func decode(_ raw: String) -> [POICategory] {
        let parts = raw
            .split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }

        var out: [POICategory] = []
        for part in parts {
            guard let category = POICategory(rawValue: part) else { continue }
            if out.contains(category) { continue }
            out.append(category)
        }
        return out
    }

    static func encode(_ categories: [POICategory]) -> String {
        normalize(categories).map(\.rawValue).joined(separator: ",")
    }

    static func normalize(_ categories: [POICategory]) -> [POICategory] {
        let available = availableCategories
        var unique: [POICategory] = []
        for category in categories {
            guard available.contains(category) else { continue }
            if unique.contains(category) { continue }
            unique.append(category)
            if unique.count >= displayedChipCount { break }
        }
        for category in available {
            if unique.count >= displayedChipCount { break }
            if unique.contains(category) { continue }
            unique.append(category)
        }
        return unique
    }
}
