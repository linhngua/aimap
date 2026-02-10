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

extension PlaceCategory: Identifiable {
    var id: String { rawValue }
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

enum PlaceDetailMode: String, Codable, Hashable {
    case signals
    case inference
}

enum PlaceDetailConfidence: String, Codable, Hashable {
    case low
    case medium
    case high
}

struct AreaFact: Codable, Hashable, Identifiable {
    let fact: String
    let source: String

    var id: String { "\(fact)|\(source)" }
}

struct AreaContext: Codable, Hashable {
    let neighborhoodName: String?
    let city: String?
    let country: String?
    let areaFacts: [AreaFact]
}

struct PlaceBrief: Codable, Hashable {
    let placeLocalId: String
    let name: String
    let lat: Double
    let lng: Double
    let addressShort: String
    let primaryCategory: String
    let rawCategories: [String]
    let urlExists: Bool
    let phoneExists: Bool
    let openNow: Bool?
    let hoursSummary: String?
    let rating: Double?
    let ratingCount: Int?
    let priceLevel: Int?
}

struct NearbyContextCandidate: Codable, Identifiable, Hashable {
    let placeLocalId: String
    let name: String
    let primaryCategory: String
    let lat: Double
    let lng: Double
    let distanceM: Int

    var id: String { placeLocalId }
}

struct PlaceDetailRequest: Codable {
    let place: PlaceBrief
    let reviewSnippets: [ReviewSnippet]
    let nearbyContextCandidates: [NearbyContextCandidate]
    let areaContext: AreaContext
}

struct NearbyMove: Codable, Identifiable, Hashable {
    let placeLocalId: String
    let label: String
    let reason: String

    var id: String { placeLocalId }
}

struct PlaceDetailResponse: Codable, Hashable {
    let placeLocalId: String
    let mode: PlaceDetailMode
    let headline: String
    let whyWorthIt: String
    let nearbyMoves: [NearbyMove]
    let cuisine: String?
    let bestDishes: [String]?
    var areaFunFact: [AreaFact]
    let confidence: PlaceDetailConfidence
    let disclosure: String
}

struct AreaFactsRequest: Codable, Hashable {
    let lat: Double
    let lng: Double
    let radiusM: Int
    let cellId: String
}

struct AreaFactsResponse: Codable, Hashable {
    let facts: [AreaFact]
}

extension CandidatePlace {
    var normalizedPrimaryCategory: String {
        let categories = rawCategories.joined(separator: " ").lowercased()
        let nameLowercased = name.lowercased()
        let haystack = "\(categories) \(nameLowercased)"

        if haystack.contains("bar") || haystack.contains("pub") || haystack.contains("brewery") || haystack.contains("nightlife") {
            return "bar"
        }
        if haystack.contains("restaurant") || haystack.contains("cafe") || haystack.contains("bakery") || haystack.contains("food") || haystack.contains("coffee") {
            return "restaurant"
        }
        if haystack.contains("store") || haystack.contains("shop") || haystack.contains("market") || haystack.contains("mall") || haystack.contains("boutique") {
            return "shop"
        }
        return "attraction"
    }
}

struct CoverageBounds: Hashable {
    let minLat: Double
    let maxLat: Double
    let minLng: Double
    let maxLng: Double

    func contains(_ coordinate: CLLocationCoordinate2D) -> Bool {
        guard coordinate.latitude.isFinite, coordinate.longitude.isFinite else { return false }
        return coordinate.latitude >= minLat
            && coordinate.latitude <= maxLat
            && coordinate.longitude >= minLng
            && coordinate.longitude <= maxLng
    }
}

enum CoverageRegion: String, CaseIterable, Hashable {
    case singapore
    case hoChiMinhCity

    var title: String {
        switch self {
        case .singapore: return "Singapore"
        case .hoChiMinhCity: return "Ho Chi Minh City"
        }
    }

    var center: CLLocationCoordinate2D {
        switch self {
        case .singapore:
            return CLLocationCoordinate2D(latitude: 1.3521, longitude: 103.8198)
        case .hoChiMinhCity:
            return CLLocationCoordinate2D(latitude: 10.8231, longitude: 106.6297)
        }
    }

    var bounds: CoverageBounds {
        switch self {
        case .singapore:
            return CoverageBounds(minLat: 1.130, maxLat: 1.480, minLng: 103.600, maxLng: 104.110)
        case .hoChiMinhCity:
            return CoverageBounds(minLat: 10.350, maxLat: 11.200, minLng: 106.300, maxLng: 107.150)
        }
    }
}

enum Coverage {
    static let supportedRegions: [CoverageRegion] = CoverageRegion.allCases

    static func supportedRegion(for coordinate: CLLocationCoordinate2D) -> CoverageRegion? {
        supportedRegions.first { $0.bounds.contains(coordinate) }
    }

    static func isSupported(_ coordinate: CLLocationCoordinate2D) -> Bool {
        // Coverage is worldwide.
        _ = coordinate
        return true
    }

    static func nearestSupportedRegion(to coordinate: CLLocationCoordinate2D) -> CoverageRegion {
        let origin = CLLocation(latitude: coordinate.latitude, longitude: coordinate.longitude)
        return supportedRegions
            .map { region in
                (region, origin.distance(from: CLLocation(latitude: region.center.latitude, longitude: region.center.longitude)))
            }
            .min(by: { $0.1 < $1.1 })?
            .0 ?? .singapore
    }

    static func outOfCoverageMessage() -> String {
        "AIMap is available worldwide."
    }
}

struct CoverageReportRequest: Codable, Hashable {
    let lat: Double
    let lng: Double
    let source: String
}

struct CoverageReportResponse: Codable, Hashable {
    let status: String
    let recorded: Bool?
}
