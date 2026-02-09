import CoreLocation
import Foundation

actor NearbyCachePrimer {
    struct Configuration: Hashable {
        var maxCells: Int = 9
        var stepMeters: CLLocationDistance = 550
        var sleepBetweenCellsSeconds: TimeInterval = 0.6
        var maxRefreshCalls: Int = 3
        var minRefreshIntervalSeconds: TimeInterval = 10
    }

    private let configuration: Configuration
    private let nearbyCache: NearbyCache
    private let mapKitService: MapKitNearbySearchService
    private let backendClient: BackendClient?
    private let shouldLog: Bool

    init(
        configuration: Configuration = .init(),
        nearbyCache: NearbyCache,
        mapKitService: MapKitNearbySearchService,
        backendClient: BackendClient?
    ) {
        self.configuration = configuration
        self.nearbyCache = nearbyCache
        self.mapKitService = mapKitService
        self.backendClient = backendClient
        shouldLog = ProcessInfo.processInfo.environment["MODE"]?.lowercased() == "test"
    }

    func primeAround(center: CLLocationCoordinate2D, radiusMeters: Double) async {
        let sampleCoordinates = Self.sampleCoordinates(around: center, stepMeters: configuration.stepMeters)
        var refreshCalls = 0
        var lastRefreshAt = Date.distantPast

        for (index, coordinate) in sampleCoordinates.prefix(configuration.maxCells).enumerated() {
            if Task.isCancelled { return }

            let key = NearbySpatialKey.make(coordinate: coordinate, radiusMeters: radiusMeters)
            if let existing = await nearbyCache.loadNearest(for: key, coordinate: coordinate),
               existing.spatialKey.cellId == key.cellId,
               existing.accuracy == .exact {
                log("skip \(index + 1)/\(sampleCoordinates.count) cell=\(key.cellId) (already cached)")
                continue
            }

            do {
                var service = mapKitService
                service.configuration.radiusMeters = radiusMeters
                let candidates = try await service.fetchCandidates(near: coordinate)
                let trimmed = Array(candidates.prefix(40))
                guard !trimmed.isEmpty else {
                    log("empty candidates cell=\(key.cellId)")
                    continue
                }

                if let backendClient {
                    let ingest = CandidatesIngestRequest(
                        lat: coordinate.latitude,
                        lng: coordinate.longitude,
                        radiusM: Int(radiusMeters),
                        cellId: key.cellId,
                        candidates: trimmed
                    )
                    _ = try? await backendClient.candidatesIngest(request: ingest)
                }

                // Store a cheap local grouping immediately so tier0 has something even if backend is unavailable.
                let mapKitPayload = NearbyPayload(
                    query: NearbyQuery(lat: coordinate.latitude, lng: coordinate.longitude, radiusM: Int(radiusMeters)),
                    candidates: trimmed,
                    categories: cheapGroupCandidates(trimmed)
                )
                await nearbyCache.upsert(
                    payload: mapKitPayload,
                    spatialKey: key,
                    etag: nil,
                    accuracy: .exact,
                    sourceCellId: nil,
                    sourceDistanceM: nil,
                    producedAt: Date()
                )

                guard let backendClient else { continue }

                let cachedEnvelope = try? await backendClient.nearbyCached(
                    request: NearbyCachedRequest(
                        lat: coordinate.latitude,
                        lng: coordinate.longitude,
                        radiusM: Int(radiusMeters),
                        categories: key.categories,
                        cellId: key.cellId,
                        timeBucket: key.timeBucket,
                        clientEtag: nil
                    ),
                    bypassCache: false
                )

                if let cached = cachedEnvelope, let payload = cached.payload, cached.accuracy == .exact, cached.stale == false {
                    await nearbyCache.upsert(
                        payload: payload,
                        spatialKey: key,
                        etag: cached.etag,
                        accuracy: cached.accuracy,
                        sourceCellId: cached.sourceCellId,
                        sourceDistanceM: cached.sourceDistanceM,
                        producedAt: Date()
                    )
                    log("cached ok cell=\(key.cellId) items=\(payload.candidates.count)")
                    continue
                }

                // Rate-limit LLM refresh calls.
                if refreshCalls >= configuration.maxRefreshCalls { continue }
                let sinceLast = Date().timeIntervalSince(lastRefreshAt)
                if sinceLast < configuration.minRefreshIntervalSeconds {
                    let remaining = configuration.minRefreshIntervalSeconds - sinceLast
                    try? await Task.sleep(nanoseconds: UInt64(max(0, remaining) * 1_000_000_000))
                }

                let refreshEnvelope = try await backendClient.nearbyRefresh(
                    request: NearbyRefreshRequest(
                        lat: coordinate.latitude,
                        lng: coordinate.longitude,
                        radiusM: Int(radiusMeters),
                        categories: key.categories,
                        cellId: key.cellId,
                        timeBucket: key.timeBucket,
                        candidates: trimmed,
                        clientEtag: nil
                    ),
                    bypassCache: false
                )

                lastRefreshAt = Date()
                refreshCalls += 1

                if refreshEnvelope.status == .ok, let payload = refreshEnvelope.payload {
                    await nearbyCache.upsert(
                        payload: payload,
                        spatialKey: key,
                        etag: refreshEnvelope.etag,
                        accuracy: .exact,
                        sourceCellId: nil,
                        sourceDistanceM: nil,
                        producedAt: Date()
                    )
                    log("refresh ok cell=\(key.cellId) etag=\(refreshEnvelope.etag.prefix(10))…")
                }
            } catch is CancellationError {
                return
            } catch {
                log("prime error cell=\(key.cellId) err=\(error.localizedDescription)")
            }

            if configuration.sleepBetweenCellsSeconds > 0 {
                try? await Task.sleep(nanoseconds: UInt64(configuration.sleepBetweenCellsSeconds * 1_000_000_000))
            }
        }
    }

    // MARK: - Heuristic grouping (same intent as MapViewModel tier1)

    private func cheapGroupCandidates(_ candidates: [CandidatePlace]) -> NearbyCategories {
        var restaurants: [NearbyRankedItem] = []
        var bars: [NearbyRankedItem] = []
        var attractions: [NearbyRankedItem] = []
        var shops: [NearbyRankedItem] = []

        func score(for place: CandidatePlace) -> Double {
            var value = 0.0
            if place.openNow == true { value += 0.12 }
            if place.url != nil { value += 0.06 }
            if place.phone != nil { value += 0.04 }
            if let rating = place.rating { value += min(1, rating / 5.0) * 0.6 }
            if let count = place.ratingCount { value += min(1, log10(Double(count) + 1) / 3.0) * 0.18 }
            return min(1, value)
        }

        func classify(_ place: CandidatePlace) -> PlaceCategory {
            let haystack = place.rawCategories.joined(separator: " ").lowercased()
            if haystack.contains("bar") || haystack.contains("brewery") || haystack.contains("pub") { return .bars }
            if haystack.contains("restaurant") || haystack.contains("cafe") || haystack.contains("bakery") || haystack.contains("food") { return .restaurants }
            if haystack.contains("store") || haystack.contains("shop") || haystack.contains("market") || haystack.contains("mall") { return .shops }
            return .attractions
        }

        func tags(_ place: CandidatePlace) -> [String] {
            Array(
                place.rawCategories
                    .map { $0.replacingOccurrences(of: "MKPOICategory", with: "") }
                    .map { $0.replacingOccurrences(of: "([a-z])([A-Z])", with: "$1 $2", options: .regularExpression) }
                    .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                    .filter { !$0.isEmpty }
                    .prefix(3)
            )
        }

        for place in candidates {
            let item = NearbyRankedItem(
                placeLocalId: place.placeLocalId,
                score: score(for: place),
                why: "Primed from MapKit categories.",
                tags: tags(place),
                bestFor: "a quick stop",
                cautions: []
            )
            switch classify(place) {
            case .restaurants: restaurants.append(item)
            case .bars: bars.append(item)
            case .attractions: attractions.append(item)
            case .shops: shops.append(item)
            }
        }

        restaurants.sort { $0.score > $1.score }
        bars.sort { $0.score > $1.score }
        attractions.sort { $0.score > $1.score }
        shops.sort { $0.score > $1.score }

        return NearbyCategories(restaurants: restaurants, bars: bars, attractions: attractions, shops: shops)
    }

    // MARK: - Sampling helpers

    private static func sampleCoordinates(around center: CLLocationCoordinate2D, stepMeters: CLLocationDistance) -> [CLLocationCoordinate2D] {
        let bearings: [Double] = [0, 45, 90, 135, 180, 225, 270, 315]
        var points = [center]
        points.reserveCapacity(1 + bearings.count)
        for bearing in bearings {
            points.append(offset(center, meters: stepMeters, bearingDegrees: bearing))
        }
        return points
    }

    private static func offset(_ coordinate: CLLocationCoordinate2D, meters: CLLocationDistance, bearingDegrees: Double) -> CLLocationCoordinate2D {
        let radius = 6_371_000.0
        let bearing = bearingDegrees * Double.pi / 180
        let lat1 = coordinate.latitude * Double.pi / 180
        let lon1 = coordinate.longitude * Double.pi / 180
        let distance = meters / radius

        let lat2 = asin(sin(lat1) * cos(distance) + cos(lat1) * sin(distance) * cos(bearing))
        let lon2 = lon1 + atan2(
            sin(bearing) * sin(distance) * cos(lat1),
            cos(distance) - sin(lat1) * sin(lat2)
        )

        return CLLocationCoordinate2D(latitude: lat2 * 180 / Double.pi, longitude: lon2 * 180 / Double.pi)
    }

    private func log(_ message: String) {
        guard shouldLog else { return }
        print("[CachePrimer] \(message)")
    }
}
