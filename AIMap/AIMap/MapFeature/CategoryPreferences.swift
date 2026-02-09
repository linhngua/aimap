import Foundation

enum CategoryPreferences {
    static let storageKey = "visible_place_categories"
    static let maxAvailableCategories = 20
    static let displayedChipCount = 3

    static var availableCategories: [PlaceCategory] {
        Array(PlaceCategory.allCases.prefix(maxAvailableCategories))
    }

    static var defaultSelection: [PlaceCategory] {
        normalize(Array(availableCategories.prefix(displayedChipCount)))
    }

    static func decode(_ raw: String) -> [PlaceCategory] {
        let parts = raw
            .split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }

        var out: [PlaceCategory] = []
        for part in parts {
            guard let category = PlaceCategory(rawValue: part) else { continue }
            if out.contains(category) { continue }
            out.append(category)
        }
        return out
    }

    static func encode(_ categories: [PlaceCategory]) -> String {
        normalize(categories).map(\.rawValue).joined(separator: ",")
    }

    static func normalize(_ categories: [PlaceCategory]) -> [PlaceCategory] {
        let available = availableCategories
        var unique: [PlaceCategory] = []
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

