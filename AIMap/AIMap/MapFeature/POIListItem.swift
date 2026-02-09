import Foundation

struct POIListItem: Identifiable, Hashable {
    let place: CandidatePlace
    let score: Double
    let why: String
    let tags: [String]

    var id: String { place.placeLocalId }
}

