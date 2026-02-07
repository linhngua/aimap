import CoreLocation
import CryptoKit
import Foundation

enum PlaceCategory: String, CaseIterable, Codable, Hashable {
    case restaurants
    case bars
    case attractions
    case shops

    var title: String {
        switch self {
        case .restaurants: return "Restaurants"
        case .bars: return "Bars"
        case .attractions: return "Attractions"
        case .shops: return "Shops"
        }
    }

    var systemImage: String {
        switch self {
        case .restaurants: return "fork.knife"
        case .bars: return "wineglass"
        case .attractions: return "sparkles"
        case .shops: return "bag"
        }
    }
}

struct CandidatePlace: Codable, Identifiable, Hashable {
    let placeLocalId: String
    let name: String
    let lat: Double
    let lng: Double
    let addressShort: String
    let rawCategories: [String]
    let url: String?
    let phone: String?
    let rating: Double?
    let ratingCount: Int?
    let priceLevel: Int?
    let openNow: Bool?

    var id: String { placeLocalId }

    var coordinate: CLLocationCoordinate2D {
        CLLocationCoordinate2D(latitude: lat, longitude: lng)
    }

    static func fallbackLocalId(name: String, lat: Double, lng: Double) -> String {
        let normalized = "\(name.lowercased())|\(String(format: "%.6f", lat))|\(String(format: "%.6f", lng))"
        let digest = SHA256.hash(data: Data(normalized.utf8))
        let hex = digest.map { String(format: "%02x", $0) }.joined()
        return "hash_\(hex.prefix(16))"
    }
}

struct UserContext: Codable, Hashable {
    let timeOfDay: String?
    let vibe: String?
    let budget: String?
}

struct NearbyRequest: Codable {
    let lat: Double
    let lng: Double
    let radiusM: Int
    let candidates: [CandidatePlace]
    let userContext: UserContext?
}

struct NearbyQuery: Codable, Hashable {
    let lat: Double
    let lng: Double
    let radiusM: Int
}

struct NearbyRankedItem: Codable, Identifiable, Hashable {
    let placeLocalId: String
    let score: Double
    let why: String
    let tags: [String]
    let bestFor: String
    let cautions: [String]

    var id: String { placeLocalId }
}

struct NearbyCategories: Codable, Hashable {
    let restaurants: [NearbyRankedItem]
    let bars: [NearbyRankedItem]
    let attractions: [NearbyRankedItem]
    let shops: [NearbyRankedItem]
}

struct NearbyResponse: Codable, Hashable {
    let query: NearbyQuery
    let categories: NearbyCategories
}

struct ReviewSnippet: Codable, Hashable {
    let text: String
}

struct PlaceDetailRequest: Codable {
    let place: CandidatePlace
    let reviewSnippets: [ReviewSnippet]
    let firstPartySignals: [String: String]
}

enum PlaceDetailMode: String, Codable, Hashable {
    case signals
    case inference
    case firstParty = "first_party"
}

struct PlaceDetailResponse: Codable, Hashable {
    let placeLocalId: String
    let mode: PlaceDetailMode
    let summary: String
    let highlights: [String]
    let cautions: [String]
    let tips: [String]
    let disclosure: String
}

