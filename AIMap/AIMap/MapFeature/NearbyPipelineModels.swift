import Foundation

enum NearbyAccuracy: String, Codable, Hashable {
    case exact
    case approx
    case miss
}

enum NearbyTier: String, Codable, Hashable {
    case localCached = "tier0_local_cached"
    case mapKitRaw = "tier1_mapkit_raw"
    case serverCached = "tier2_server_cached_grouped"
    case fresh = "tier3_fresh_grouped"
}

struct NearbyPayload: Codable, Hashable {
    let query: NearbyQuery
    let candidates: [CandidatePlace]
    let categories: NearbyCategories
}

struct NearbyCachedRequest: Codable {
    let lat: Double
    let lng: Double
    let radiusM: Int
    let categories: [String]
    let cellId: String
    let timeBucket: String
    let clientEtag: String?
}

struct NearbyCachedEnvelope: Codable, Hashable {
    let hit: Bool
    let stale: Bool
    let accuracy: NearbyAccuracy
    let sourceCellId: String?
    let sourceDistanceM: Double?
    let etag: String?
    let payload: NearbyPayload?
}

struct NearbyRefreshRequest: Codable {
    let lat: Double
    let lng: Double
    let radiusM: Int
    let categories: [String]
    let cellId: String
    let timeBucket: String
    let candidates: [CandidatePlace]
    let clientEtag: String?
}

enum NearbyRefreshStatus: String, Codable, Hashable {
    case ok
    case unchanged
}

struct NearbyRefreshEnvelope: Codable, Hashable {
    let status: NearbyRefreshStatus
    let etag: String
    let payload: NearbyPayload?
}

struct CandidatesIngestRequest: Codable {
    let lat: Double
    let lng: Double
    let radiusM: Int
    let cellId: String
    let candidates: [CandidatePlace]
}

struct CandidatesIngestResponse: Codable, Hashable {
    let status: String
    let cellId: String
    let radiusBucket: Int
    let etag: String?
    let storedCandidates: Int?
}
