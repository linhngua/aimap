import CoreLocation
import Foundation
import MapKit
import SwiftUI

private let defaultBackendBaseURL = "https://map.petetranfab.com"

@MainActor
final class MapViewModel: ObservableObject {
    private static let initialCenter = CoverageRegion.singapore.center
    private static let defaultSpan = MKCoordinateSpan(latitudeDelta: 0.08 / 3.0, longitudeDelta: 0.08 / 3.0)
    private static let tapDebounceNanoseconds: UInt64 = 220_000_000

    @AppStorage("backend_base_url") var backendBaseURLString: String = defaultBackendBaseURL
    @AppStorage("search_radius_m") var radiusMeters: Double = 800
    @AppStorage("cache_primer_enabled") var isCachePrimerEnabled: Bool = true {
        didSet {
            if !isCachePrimerEnabled {
                cachePrimerTask?.cancel()
                return
            }
            if let userLocation, !hasRunCachePrimer {
                startCachePrimerIfNeeded(center: userLocation)
            }
        }
    }

    private final class LocationDelegate: NSObject, CLLocationManagerDelegate {
        let onAuthorizationChanged: (CLAuthorizationStatus) -> Void
        let onLocation: (CLLocation) -> Void
        let onError: (Error) -> Void

        init(
            onAuthorizationChanged: @escaping (CLAuthorizationStatus) -> Void,
            onLocation: @escaping (CLLocation) -> Void,
            onError: @escaping (Error) -> Void
        ) {
            self.onAuthorizationChanged = onAuthorizationChanged
            self.onLocation = onLocation
            self.onError = onError
        }

        func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
            onAuthorizationChanged(manager.authorizationStatus)
        }

        func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
            guard let location = locations.last else { return }
            onLocation(location)
        }

        func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
            onError(error)
        }
    }

    private let locationManager = CLLocationManager()
    private lazy var locationDelegate = LocationDelegate(
        onAuthorizationChanged: { [weak self] status in
            Task { @MainActor in
                self?.handleAuthorizationChanged(status)
            }
        },
        onLocation: { [weak self] location in
            Task { @MainActor in
                self?.handleLocationUpdate(location)
            }
        },
        onError: { [weak self] error in
            Task { @MainActor in
                self?.handleLocationError(error)
            }
        }
    )
    private var hasCenteredOnUserLocation = false
    private var lastCameraCenter: CLLocationCoordinate2D = initialCenter

    init() {
        if backendBaseURLString.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            backendBaseURLString = defaultBackendBaseURL
        }

        locationManager.desiredAccuracy = kCLLocationAccuracyHundredMeters
    }

    @Published var region: MKCoordinateRegion = MKCoordinateRegion(
        center: initialCenter,
        span: defaultSpan
    ) {
        didSet {
            lastCameraCenter = region.center
        }
    }

    @Published private(set) var userLocation: CLLocationCoordinate2D?

    @Published var isSearchingLocation: Bool = false
    @Published var locationSearchErrorMessage: String?

    @Published private(set) var nearbyPayload: NearbyPayload?
    @Published private(set) var nearbyTier: NearbyTier?
    @Published private(set) var nearbyAccuracy: NearbyAccuracy = .miss
    @Published private(set) var nearbyEtag: String?
    @Published private(set) var nearbyIsStale: Bool = false

    @Published private(set) var candidatesById: [String: CandidatePlace] = [:]
    @Published var selectedCategory: POICategory = .restaurants
    @Published var lastTappedCoordinate: CLLocationCoordinate2D?

    private var mapItemsById: [String: MKMapItem] = [:]

    @Published var isLoadingNearby: Bool = false
    @Published var nearbyErrorMessage: String?

    @Published var selectedPlace: CandidatePlace?
    @Published private(set) var placeDetail: PlaceDetailResponse?
    @Published var isLoadingPlaceDetail: Bool = false
    @Published var placeDetailErrorMessage: String?

    @Published private(set) var areaFacts: [AreaFact] = []
    @Published var isLoadingAreaFacts: Bool = false

    @Published var isShowingSettings: Bool = false

    @Published private(set) var cachedAreaCellIds: [String] = []

    private var placeTask: Task<Void, Never>?
    private var areaFactsTask: Task<Void, Never>?
    private var locationSearchTask: Task<Void, Never>?
    private var overlayTask: Task<Void, Never>?

    private let mapKitService = MapKitNearbySearchService()
    private let nearbyCache = NearbyCache()
    private let placeDetailCache = PlaceDetailCache()
    private let areaFactsCache = AreaFactsCache()

    private var tapDebounceTask: Task<Void, Never>?
    private var pipelineTask: Task<Void, Never>?
    private var latestTapRequestId: Int = 0

    private var lastSpatialKey: NearbySpatialKey?
    private var lastCandidates: [CandidatePlace] = []

    private var cachePrimerTask: Task<Void, Never>?
    private var hasRunCachePrimer: Bool = false

    func centerOnUserLocationIfNeeded() {
        guard !hasCenteredOnUserLocation else { return }
        requestUserLocation()
    }

    func searchForLocation(_ query: String) {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        locationSearchErrorMessage = nil
        isSearchingLocation = true

        locationSearchTask?.cancel()
        locationSearchTask = Task { [trimmed] in
            await performLocationSearch(query: trimmed)
        }
    }

    func searchForCompletion(_ completion: MKLocalSearchCompletion) {
        locationSearchErrorMessage = nil
        isSearchingLocation = true

        locationSearchTask?.cancel()
        locationSearchTask = Task {
            await performLocationSearch(completion: completion)
        }
    }

    func handleMapTap(_ coordinate: CLLocationCoordinate2D) {
        lastTappedCoordinate = coordinate
        nearbyErrorMessage = nil

        tapDebounceTask?.cancel()
        tapDebounceTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: Self.tapDebounceNanoseconds)
            beginTapPipeline(coordinate: coordinate, bypassCache: false)
        }
    }

    func refreshNearby() {
        guard let coordinate = lastTappedCoordinate else { return }
        nearbyErrorMessage = nil

        beginTapPipeline(coordinate: coordinate, bypassCache: true)
    }

    func selectCategory(_ category: POICategory) {
        selectedCategory = category
    }

    func ensureSelectedCategory(in visibleCategories: [POICategory]) {
        let allowed = visibleCategories.isEmpty ? Array(POICategory.allCases) : visibleCategories
        guard !allowed.isEmpty else { return }

        if allowed.contains(selectedCategory), (categoryCounts[selectedCategory] ?? 0) > 0 {
            return
        }

        if nearbyPayload != nil {
            let candidates: [(POICategory, Int, Double)] = allowed.map { category in
                let count = categoryCounts[category] ?? 0
                let score = listItems(for: category).first?.score ?? 0
                return (category, count, score)
            }
            let sorted = candidates.sorted { lhs, rhs in
                if lhs.1 != rhs.1 { return lhs.1 > rhs.1 }
                return lhs.2 > rhs.2
            }
            if let best = sorted.first, best.1 > 0 {
                selectedCategory = best.0
                return
            }

            // If we have results, but none in visible buckets, fall back to any with items.
            let allCounts: [(POICategory, Int, Double)] = POICategory.allCases.map { category in
                let count = categoryCounts[category] ?? 0
                let score = listItems(for: category).first?.score ?? 0
                return (category, count, score)
            }
            let bestAny = allCounts.sorted { lhs, rhs in
                if lhs.1 != rhs.1 { return lhs.1 > rhs.1 }
                return lhs.2 > rhs.2
            }.first
            if let bestAny, bestAny.1 > 0 {
                selectedCategory = bestAny.0
                return
            }
        }

        selectedCategory = allowed.first ?? .restaurants
    }

    func selectPlace(_ place: CandidatePlace) {
        selectedPlace = place
        placeDetail = nil
        areaFacts = []
        placeDetailErrorMessage = nil

        placeTask?.cancel()
        placeTask = Task {
            await loadPlaceDetail(place: place, bypassCache: false)
        }

        areaFactsTask?.cancel()
        areaFactsTask = Task {
            await loadAreaFacts(for: place, bypassCache: false)
        }
    }

    func refreshPlaceDetail() {
        guard let place = selectedPlace else { return }
        placeDetailErrorMessage = nil

        placeTask?.cancel()
        placeTask = Task {
            await loadPlaceDetail(place: place, bypassCache: true)
        }

        areaFactsTask?.cancel()
        areaFactsTask = Task {
            await loadAreaFacts(for: place, bypassCache: true)
        }
    }

    var categoryCounts: [POICategory: Int] {
        guard let candidates = nearbyPayload?.candidates else { return [:] }
        var counts: [POICategory: Int] = [:]
        for place in candidates {
            let category = POICategory.classify(place)
            counts[category, default: 0] += 1
        }
        return counts
    }

    var listItemsForSelectedCategory: [POIListItem] {
        listItems(for: selectedCategory)
    }

    var visiblePlaces: [CandidatePlace] {
        listItemsForSelectedCategory.map(\.place)
    }

    func listItems(for category: POICategory) -> [POIListItem] {
        guard let payload = nearbyPayload else { return [] }

        var rankedById: [String: NearbyRankedItem] = [:]
        for item in payload.categories.restaurants + payload.categories.bars + payload.categories.attractions + payload.categories.shops {
            rankedById[item.placeLocalId] = item
        }

        let filtered = payload.candidates.filter { POICategory.classify($0) == category }
        let items: [POIListItem] = filtered.map { place in
            if let ranked = rankedById[place.placeLocalId] {
                return POIListItem(place: place, score: ranked.score, why: ranked.why, tags: ranked.tags)
            }
            return POIListItem(place: place, score: fallbackScore(for: place), why: "From MapKit.", tags: fallbackTags(for: place))
        }
        return items.sorted { lhs, rhs in
            if lhs.score != rhs.score { return lhs.score > rhs.score }
            return lhs.place.name < rhs.place.name
        }
    }

    private func loadPlaceDetail(place: CandidatePlace, bypassCache: Bool) async {
        isLoadingPlaceDetail = true
        defer { isLoadingPlaceDetail = false }

        let placeLocalId = place.placeLocalId
        let cellId = areaFactsCellId(for: place.coordinate)

        if !bypassCache, let cached = await placeDetailCache.load(placeLocalId: placeLocalId) {
            var copy = cached
            if !areaFacts.isEmpty {
                copy.areaFunFact = areaFacts
            }
            placeDetail = copy
        }

        // Best-effort neighborhood/city/country. Don’t block too long.
        let names = await withTimeout(seconds: 0.6) {
            await self.reverseGeocodeContext(for: place.coordinate)
        } ?? .init(neighborhoodName: nil, city: nil, country: nil)

        // Use cached area facts if we have them; otherwise try cache quickly.
        let factsForRequest: [AreaFact]
        if !areaFacts.isEmpty {
            factsForRequest = areaFacts
        } else if !bypassCache, let cachedFacts = await areaFactsCache.load(cellId: cellId) {
            factsForRequest = cachedFacts
        } else {
            factsForRequest = []
        }

        let request = PlaceDetailRequest(
            place: makePlaceBrief(from: place),
            reviewSnippets: [],
            nearbyContextCandidates: makeNearbyContextCandidates(for: place),
            areaContext: AreaContext(
                neighborhoodName: names.neighborhoodName,
                city: names.city,
                country: names.country,
                areaFacts: factsForRequest
            )
        )

        do {
            let client = try makeBackendClient()
            var detail = try await client.placeDetail(request: request, bypassCache: bypassCache)
            if !areaFacts.isEmpty {
                detail.areaFunFact = areaFacts
            }
            placeDetail = detail
            await placeDetailCache.save(placeLocalId: placeLocalId, response: detail)
        } catch {
            placeDetailErrorMessage = error.localizedDescription
        }
    }

    private func loadAreaFacts(for place: CandidatePlace, bypassCache: Bool) async {
        isLoadingAreaFacts = true
        defer { isLoadingAreaFacts = false }

        let cellId = areaFactsCellId(for: place.coordinate)

        if !bypassCache, let cached = await areaFactsCache.load(cellId: cellId) {
            areaFacts = cached
            if var detail = placeDetail, detail.placeLocalId == place.placeLocalId, !cached.isEmpty {
                withAnimation(.easeInOut(duration: 0.18)) {
                    detail.areaFunFact = cached
                    placeDetail = detail
                }
            }
        }

        do {
            let client = try makeBackendClient()
            let request = AreaFactsRequest(
                lat: place.lat,
                lng: place.lng,
                radiusM: Int(radiusMeters),
                cellId: cellId
            )
            let response = try await client.areaFacts(request: request, bypassCache: bypassCache)
            areaFacts = response.facts
            await areaFactsCache.save(cellId: cellId, facts: response.facts)

            if var detail = placeDetail, detail.placeLocalId == place.placeLocalId, !response.facts.isEmpty {
                withAnimation(.easeInOut(duration: 0.18)) {
                    detail.areaFunFact = response.facts
                    placeDetail = detail
                }
                await placeDetailCache.save(placeLocalId: place.placeLocalId, response: detail)
            }
        } catch {
            // Keep any cached area facts; do not surface hard errors in the sheet.
        }
    }

    // MARK: - Place detail payload helpers

    private struct AreaContextNames {
        let neighborhoodName: String?
        let city: String?
        let country: String?
    }

    private func areaFactsCellId(for coordinate: CLLocationCoordinate2D) -> String {
        let bucket = NearbySpatialKey.radiusBucket(for: radiusMeters)
        let precision = NearbySpatialKey.geohashPrecision(for: bucket)
        return Geohash.encode(latitude: coordinate.latitude, longitude: coordinate.longitude, precision: precision)
    }

    private func makePlaceBrief(from place: CandidatePlace) -> PlaceBrief {
        PlaceBrief(
            placeLocalId: place.placeLocalId,
            name: place.name,
            lat: place.lat,
            lng: place.lng,
            addressShort: place.addressShort,
            primaryCategory: place.normalizedPrimaryCategory,
            rawCategories: place.rawCategories,
            urlExists: place.url?.isEmpty == false,
            phoneExists: place.phone?.isEmpty == false,
            openNow: place.openNow,
            hoursSummary: nil,
            rating: place.rating,
            ratingCount: place.ratingCount,
            priceLevel: place.priceLevel
        )
    }

    private func makeNearbyContextCandidates(for place: CandidatePlace) -> [NearbyContextCandidate] {
        let origin = CLLocation(latitude: place.lat, longitude: place.lng)
        let candidates = lastCandidates
            .filter { $0.placeLocalId != place.placeLocalId }
            .map { candidate -> NearbyContextCandidate in
                let distance = Int(round(origin.distance(from: CLLocation(latitude: candidate.lat, longitude: candidate.lng))))
                return NearbyContextCandidate(
                    placeLocalId: candidate.placeLocalId,
                    name: candidate.name,
                    primaryCategory: candidate.normalizedPrimaryCategory,
                    lat: candidate.lat,
                    lng: candidate.lng,
                    distanceM: max(0, distance)
                )
            }
            .sorted { $0.distanceM < $1.distanceM }
        return Array(candidates.prefix(25))
    }

    private func reverseGeocodeContext(for coordinate: CLLocationCoordinate2D) async -> AreaContextNames {
        let location = CLLocation(latitude: coordinate.latitude, longitude: coordinate.longitude)
        let geocoder = CLGeocoder()
        return await withCheckedContinuation { continuation in
            geocoder.reverseGeocodeLocation(location) { placemarks, _ in
                let placemark = placemarks?.first
                continuation.resume(
                    returning: AreaContextNames(
                        neighborhoodName: placemark?.subLocality,
                        city: placemark?.locality,
                        country: placemark?.country
                    )
                )
            }
        }
    }

    private func withTimeout<T>(seconds: Double, operation: @escaping () async -> T) async -> T? {
        await withTaskGroup(of: T?.self) { group in
            group.addTask {
                await operation()
            }
            group.addTask {
                try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
                return nil
            }
            let result = await group.next() ?? nil
            group.cancelAll()
            return result
        }
    }

    private func makeBackendClient() throws -> BackendClient {
        let raw = backendBaseURLString.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalized: String
        let input = raw.isEmpty ? defaultBackendBaseURL : raw
        if input.lowercased().hasPrefix("http://") || input.lowercased().hasPrefix("https://") {
            normalized = input
        } else {
            normalized = "https://\(input)"
        }
        guard let url = URL(string: normalized) else {
            backendBaseURLString = defaultBackendBaseURL
            guard let fallbackURL = URL(string: defaultBackendBaseURL) else {
                throw BackendClientError.invalidURL
            }
            return BackendClient(configuration: .init(baseURL: fallbackURL))
        }
        return BackendClient(configuration: .init(baseURL: url))
    }

    private func requestUserLocation() {
        guard CLLocationManager.locationServicesEnabled() else { return }
        locationManager.delegate = locationDelegate

        switch locationManager.authorizationStatus {
        case .notDetermined:
            locationManager.requestWhenInUseAuthorization()
        case .authorizedAlways, .authorizedWhenInUse:
            locationManager.requestLocation()
        case .restricted, .denied:
            break
        @unknown default:
            break
        }
    }

    private func handleAuthorizationChanged(_ status: CLAuthorizationStatus) {
        switch status {
        case .authorizedAlways, .authorizedWhenInUse:
            locationManager.requestLocation()
        case .restricted, .denied:
            break
        case .notDetermined:
            break
        @unknown default:
            break
        }
    }

    private func handleLocationUpdate(_ location: CLLocation) {
        let coordinate = location.coordinate
        userLocation = coordinate
        guard !hasCenteredOnUserLocation else { return }
        hasCenteredOnUserLocation = true
        let targetCenter: CLLocationCoordinate2D
        if Coverage.isSupported(coordinate) {
            targetCenter = coordinate
        } else {
            targetCenter = Coverage.nearestSupportedRegion(to: coordinate).center
        }
        lastCameraCenter = targetCenter
        region = MKCoordinateRegion(
            center: targetCenter,
            span: Self.defaultSpan
        )

        startCachePrimerIfNeeded(center: targetCenter)
    }

    private func handleLocationError(_ error: Error) {
        // keep silent; the map still works without location permission
        _ = error
    }

    private func performLocationSearch(query: String) async {
        defer { isSearchingLocation = false }

        do {
            let request = MKLocalSearch.Request()
            request.naturalLanguageQuery = query
            request.region = MKCoordinateRegion(
                center: lastCameraCenter,
                span: MKCoordinateSpan(latitudeDelta: 0.6, longitudeDelta: 0.6)
            )
            let search = MKLocalSearch(request: request)
            let response = try await search.start()
            guard let first = response.mapItems.first else {
                locationSearchErrorMessage = "No results for \"\(query)\"."
                return
            }

            hasCenteredOnUserLocation = true
            let coordinate = first.placemark.coordinate
            lastCameraCenter = coordinate
            region = MKCoordinateRegion(
                center: coordinate,
                span: Self.defaultSpan
            )

            if !Coverage.isSupported(coordinate) {
                locationSearchErrorMessage = Coverage.outOfCoverageMessage()
                await reportOutOfCoverage(coordinate, source: "search_query")
            }
        } catch is CancellationError {
            // ignore
        } catch {
            locationSearchErrorMessage = "Search failed: \(error.localizedDescription)"
        }
    }

    private func performLocationSearch(completion: MKLocalSearchCompletion) async {
        defer { isSearchingLocation = false }

        do {
            let request = MKLocalSearch.Request(completion: completion)
            request.region = MKCoordinateRegion(
                center: lastCameraCenter,
                span: MKCoordinateSpan(latitudeDelta: 0.6, longitudeDelta: 0.6)
            )
            let search = MKLocalSearch(request: request)
            let response = try await search.start()
            guard let first = response.mapItems.first else {
                locationSearchErrorMessage = "No results."
                return
            }

            hasCenteredOnUserLocation = true
            let coordinate = first.placemark.coordinate
            lastCameraCenter = coordinate
            region = MKCoordinateRegion(
                center: coordinate,
                span: Self.defaultSpan
            )

            if !Coverage.isSupported(coordinate) {
                locationSearchErrorMessage = Coverage.outOfCoverageMessage()
                await reportOutOfCoverage(coordinate, source: "search_suggestion")
            }
        } catch is CancellationError {
            // ignore
        } catch {
            locationSearchErrorMessage = "Search failed: \(error.localizedDescription)"
        }
    }

    private func startCachePrimerIfNeeded(center: CLLocationCoordinate2D) {
        guard isCachePrimerEnabled else { return }
        guard !hasRunCachePrimer else { return }
        hasRunCachePrimer = true

        cachePrimerTask?.cancel()

        let resolvedCenter = Coverage.isSupported(center) ? center : Coverage.nearestSupportedRegion(to: center).center
        let radiusSnapshot = radiusMeters
        let cache = nearbyCache
        let mapKit = mapKitService
        let client = try? makeBackendClient()
        let primer = NearbyCachePrimer(nearbyCache: cache, mapKitService: mapKit, backendClient: client)

        cachePrimerTask = Task.detached(priority: .background) {
            await primer.primeAround(center: resolvedCenter, radiusMeters: radiusSnapshot)
        }
    }

    // MARK: - Progressive nearby pipeline

    private func beginTapPipeline(coordinate: CLLocationCoordinate2D, bypassCache: Bool) {
        latestTapRequestId += 1
        let requestId = latestTapRequestId
        lastCameraCenter = coordinate
        nearbyIsStale = false

        pipelineTask?.cancel()
        overlayTask?.cancel()
        overlayTask = Task { [weak self] in
            guard let self else { return }
            await self.refreshCachedAreaOverlay(requestId: requestId, coordinate: coordinate)
        }
        guard Coverage.isSupported(coordinate) else {
            nearbyPayload = nil
            nearbyTier = nil
            nearbyAccuracy = .miss
            nearbyEtag = nil
            nearbyIsStale = false
            candidatesById = [:]
            nearbyErrorMessage = Coverage.outOfCoverageMessage()
            Task {
                await reportOutOfCoverage(coordinate, source: bypassCache ? "tap_refresh" : "tap")
            }
            return
        }
        pipelineTask = Task { @MainActor in
            await runNearbyPipeline(requestId: requestId, coordinate: coordinate, bypassCache: bypassCache)
        }
    }

    private func refreshCachedAreaOverlay(requestId: Int, coordinate: CLLocationCoordinate2D) async {
        let prefix = Geohash.encode(latitude: coordinate.latitude, longitude: coordinate.longitude, precision: 4)
        let since = Date().addingTimeInterval(-7 * 24 * 60 * 60)

        let local = await nearbyCache.recentCellIds(prefix: prefix, since: since, limit: 250)
        guard requestId == latestTapRequestId else { return }

        var merged = Set(local.filter { $0.count >= 5 })
        cachedAreaCellIds = Array(merged).sorted()

        guard let client = try? makeBackendClient() else { return }
        do {
            let response = try await client.overlay(
                request: MapOverlayRequest(
                    lat: coordinate.latitude,
                    lng: coordinate.longitude,
                    radiusM: Int(radiusMeters)
                )
            )
            guard requestId == latestTapRequestId else { return }
            merged.formUnion(response.cachedCells.filter { $0.count >= 5 })
            merged.formUnion(response.imageCells.filter { $0.count >= 5 })
            let sorted = Array(merged).sorted()
            cachedAreaCellIds = Array(sorted.prefix(250))
        } catch {
            // ignore overlay errors
        }
    }

    private func reportOutOfCoverage(_ coordinate: CLLocationCoordinate2D, source: String) async {
        guard let client = try? makeBackendClient() else { return }
        let request = CoverageReportRequest(lat: coordinate.latitude, lng: coordinate.longitude, source: source)
        _ = try? await client.coverageReport(request: request)
    }

    func recordOutOfCoverageRequest(_ coordinate: CLLocationCoordinate2D, source: String) {
        Task {
            await reportOutOfCoverage(coordinate, source: source)
        }
    }

    private func applyNearby(payload: NearbyPayload, tier: NearbyTier, accuracy: NearbyAccuracy, etag: String?, stale: Bool) {
        nearbyPayload = payload
        nearbyTier = tier
        nearbyAccuracy = accuracy
        nearbyEtag = etag
        nearbyIsStale = stale
        candidatesById = Dictionary(uniqueKeysWithValues: payload.candidates.map { ($0.placeLocalId, $0) })
        if candidatesById[selectedPlace?.placeLocalId ?? ""] == nil {
            selectedPlace = nil
            placeDetail = nil
            placeDetailErrorMessage = nil
        }
    }

    func mapItem(for placeLocalId: String) -> MKMapItem? {
        mapItemsById[placeLocalId]
    }

    func upsertMapItems(_ items: [String: MKMapItem]) {
        guard !items.isEmpty else { return }
        mapItemsById.merge(items) { _, new in new }
    }

    private func fallbackScore(for place: CandidatePlace) -> Double {
        var score = 0.0
        if place.openNow == true { score += 0.12 }
        if place.url != nil { score += 0.06 }
        if place.phone != nil { score += 0.04 }
        if let rating = place.rating { score += min(1, rating / 5.0) * 0.6 }
        if let count = place.ratingCount { score += min(1, log10(Double(count) + 1) / 3.0) * 0.18 }
        return min(1, score)
    }

    private func fallbackTags(for place: CandidatePlace) -> [String] {
        Array(
            place.rawCategories
                .map { $0.replacingOccurrences(of: "MKPOICategory", with: "") }
                .map { $0.replacingOccurrences(of: "([a-z])([A-Z])", with: "$1 $2", options: .regularExpression) }
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty }
                .prefix(3)
        )
    }

    private func runNearbyPipeline(requestId: Int, coordinate: CLLocationCoordinate2D, bypassCache: Bool) async {
        isLoadingNearby = true
        defer { isLoadingNearby = false }

        let spatialKey = NearbySpatialKey.make(coordinate: coordinate, radiusMeters: radiusMeters)
        lastSpatialKey = spatialKey

        let cache = nearbyCache
        let radiusMeters = radiusMeters
        let mapKitService = mapKitService
        let clientEtagSnapshot = nearbyEtag

        let client = try? makeBackendClient()

        if let cached = await nearbyCache.loadNearest(for: spatialKey, coordinate: coordinate),
           requestId == latestTapRequestId {
            applyNearby(
                payload: cached.payload,
                tier: .localCached,
                accuracy: cached.accuracy,
                etag: cached.etag,
                stale: false
            )
            await cache.upsert(
                payload: cached.payload,
                spatialKey: cached.spatialKey,
                etag: cached.etag,
                accuracy: cached.accuracy,
                sourceCellId: cached.sourceCellId,
                sourceDistanceM: cached.sourceDistanceM,
                producedAt: cached.producedAt
            )
        }

        var mapKitCandidates: [CandidatePlace]?
        var refreshNeeded: Bool = false
        var cachedEnvelope: NearbyCachedEnvelope?

        await withTaskGroup(of: Void.self) { group in
            group.addTask { [weak self] in
                guard let self else { return }
                do {
                    var service = mapKitService
                    service.configuration.radiusMeters = radiusMeters
                    let pairs = try await service.fetchCandidatesAndMapItems(near: coordinate)
                    let trimmedPairs = Array(pairs.prefix(40))
                    let trimmed = trimmedPairs.map(\.0)
                    let mapItems = Dictionary(uniqueKeysWithValues: trimmedPairs.map { ($0.0.placeLocalId, $0.1) })

                    if let client {
                        let ingest = CandidatesIngestRequest(
                            lat: coordinate.latitude,
                            lng: coordinate.longitude,
                            radiusM: Int(radiusMeters),
                            cellId: spatialKey.cellId,
                            candidates: trimmed
                        )
                        Task.detached(priority: .utility) {
                            _ = try? await client.candidatesIngest(request: ingest)
                        }
                    }

                    await MainActor.run {
                        guard requestId == self.latestTapRequestId else { return }
                        self.lastCandidates = trimmed
                        mapKitCandidates = trimmed
                        self.upsertMapItems(mapItems)

                        let payload = self.makeMapKitTierPayload(coordinate: coordinate, candidates: trimmed)
                        self.applyNearby(payload: payload, tier: .mapKitRaw, accuracy: .exact, etag: nil, stale: false)
                    }
                } catch {
                    await MainActor.run {
                        guard requestId == self.latestTapRequestId else { return }
                        self.nearbyErrorMessage = error.localizedDescription
                    }
                }
            }

            group.addTask { [weak self] in
                guard let self else { return }
                do {
                    guard let client else { return }
                    let request = NearbyCachedRequest(
                        lat: coordinate.latitude,
                        lng: coordinate.longitude,
                        radiusM: Int(radiusMeters),
                        categories: spatialKey.categories,
                        cellId: spatialKey.cellId,
                        timeBucket: spatialKey.timeBucket,
                        clientEtag: clientEtagSnapshot
                    )
                    let envelope = try await client.nearbyCached(request: request, bypassCache: bypassCache)
                    await MainActor.run {
                        guard requestId == self.latestTapRequestId else { return }
                        cachedEnvelope = envelope
                        refreshNeeded = envelope.payload == nil || envelope.stale || envelope.accuracy != .exact
                        if let payload = envelope.payload {
                            self.applyNearby(
                                payload: payload,
                                tier: .serverCached,
                                accuracy: envelope.accuracy,
                                etag: envelope.etag,
                                stale: envelope.stale
                            )
                        }
                    }
                    let shouldPersist = await MainActor.run { requestId == self.latestTapRequestId }
                    if let payload = envelope.payload, shouldPersist {
                        await cache.upsert(
                            payload: payload,
                            spatialKey: spatialKey,
                            etag: envelope.etag,
                            accuracy: envelope.accuracy,
                            sourceCellId: envelope.sourceCellId,
                            sourceDistanceM: envelope.sourceDistanceM,
                            producedAt: Date()
                        )
                    }
                } catch {
                    await MainActor.run {
                        guard requestId == self.latestTapRequestId else { return }
                        self.nearbyErrorMessage = error.localizedDescription
                        refreshNeeded = true
                    }
                }
            }

            await group.waitForAll()
        }

        guard requestId == latestTapRequestId else { return }

        if let envelope = cachedEnvelope, envelope.payload != nil, !refreshNeeded {
            return
        }

        guard refreshNeeded else { return }
        guard let candidates = mapKitCandidates else { return }
        guard let client else { return }

        do {
            let refreshRequest = NearbyRefreshRequest(
                lat: coordinate.latitude,
                lng: coordinate.longitude,
                radiusM: Int(radiusMeters),
                categories: spatialKey.categories,
                cellId: spatialKey.cellId,
                timeBucket: spatialKey.timeBucket,
                candidates: candidates,
                clientEtag: nearbyEtag
            )
            let refreshEnvelope = try await client.nearbyRefresh(request: refreshRequest, bypassCache: bypassCache)
            guard requestId == latestTapRequestId else { return }

            switch refreshEnvelope.status {
            case .unchanged:
                nearbyEtag = refreshEnvelope.etag
            case .ok:
                if let payload = refreshEnvelope.payload {
                    applyNearby(payload: payload, tier: .fresh, accuracy: .exact, etag: refreshEnvelope.etag, stale: false)
                    await cache.upsert(
                        payload: payload,
                        spatialKey: spatialKey,
                        etag: refreshEnvelope.etag,
                        accuracy: .exact,
                        sourceCellId: nil,
                        sourceDistanceM: nil,
                        producedAt: Date()
                    )
                }
            }
        } catch {
            guard requestId == latestTapRequestId else { return }
            nearbyErrorMessage = error.localizedDescription
        }
    }

    private func makeMapKitTierPayload(coordinate: CLLocationCoordinate2D, candidates: [CandidatePlace]) -> NearbyPayload {
        let query = NearbyQuery(lat: coordinate.latitude, lng: coordinate.longitude, radiusM: Int(radiusMeters))
        let categories = cheapGroupCandidates(candidates)
        return NearbyPayload(query: query, candidates: candidates, categories: categories)
    }

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
            if let rating = place.rating {
                value += min(1, rating / 5.0) * 0.6
            }
            if let count = place.ratingCount {
                value += min(1, log10(Double(count) + 1) / 3.0) * 0.18
            }
            return min(1, value)
        }

        func classify(_ place: CandidatePlace) -> PlaceCategory {
            let haystack = place.rawCategories.joined(separator: " ").lowercased()
            if haystack.contains("bar") || haystack.contains("brewery") || haystack.contains("pub") {
                return .bars
            }
            if haystack.contains("restaurant") || haystack.contains("cafe") || haystack.contains("bakery") || haystack.contains("food") {
                return .restaurants
            }
            if haystack.contains("store") || haystack.contains("shop") || haystack.contains("market") || haystack.contains("mall") {
                return .shops
            }
            return .attractions
        }

        func tags(_ place: CandidatePlace) -> [String] {
            Array(place.rawCategories.map { $0.replacingOccurrences(of: "MKPOICategory", with: "") }
                .map { $0.replacingOccurrences(of: "([a-z])([A-Z])", with: "$1 $2", options: .regularExpression) }
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty }
                .prefix(3))
        }

        for place in candidates {
            let item = NearbyRankedItem(
                placeLocalId: place.placeLocalId,
                score: score(for: place),
                why: "From MapKit (unranked).",
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
}
