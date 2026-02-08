import CoreLocation
import Foundation
import MapKit
import SwiftUI

private let defaultBackendBaseURL = "https://map.petetranfab.com"

@MainActor
final class MapViewModel: ObservableObject {
    @AppStorage("backend_base_url") var backendBaseURLString: String = defaultBackendBaseURL
    @AppStorage("search_radius_m") var radiusMeters: Double = 800

    init() {
        if backendBaseURLString.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            backendBaseURLString = defaultBackendBaseURL
        }
    }

    @Published var cameraPosition: MapCameraPosition = .region(
        MKCoordinateRegion(
            center: CLLocationCoordinate2D(latitude: 37.3349, longitude: -122.0090),
            span: MKCoordinateSpan(latitudeDelta: 0.08, longitudeDelta: 0.08)
        )
    )

    @Published private(set) var nearbyResponse: NearbyResponse?
    @Published private(set) var candidatesById: [String: CandidatePlace] = [:]
    @Published var selectedCategory: PlaceCategory = .restaurants
    @Published var lastTappedCoordinate: CLLocationCoordinate2D?

    @Published var isLoadingNearby: Bool = false
    @Published var nearbyErrorMessage: String?

    @Published var selectedPlace: CandidatePlace?
    @Published private(set) var placeDetail: PlaceDetailResponse?
    @Published var isLoadingPlaceDetail: Bool = false
    @Published var placeDetailErrorMessage: String?

    @Published var isShowingSettings: Bool = false

    private var nearbyTask: Task<Void, Never>?
    private var placeTask: Task<Void, Never>?

    private var lastNearbyRequest: NearbyRequest?
    private let mapKitService = MapKitNearbySearchService()

    func handleMapTap(_ coordinate: CLLocationCoordinate2D) {
        lastTappedCoordinate = coordinate
        nearbyErrorMessage = nil
        nearbyResponse = nil
        candidatesById = [:]
        placeDetail = nil
        placeDetailErrorMessage = nil
        selectedPlace = nil

        nearbyTask?.cancel()
        nearbyTask = Task {
            await loadNearby(coordinate: coordinate, bypassCache: false)
        }
    }

    func refreshNearby() {
        guard let request = lastNearbyRequest else { return }
        nearbyErrorMessage = nil

        nearbyTask?.cancel()
        nearbyTask = Task {
            await loadNearby(with: request, bypassCache: true)
        }
    }

    func selectCategory(_ category: PlaceCategory) {
        selectedCategory = category
    }

    func selectPlace(_ place: CandidatePlace) {
        selectedPlace = place
        placeDetail = nil
        placeDetailErrorMessage = nil

        placeTask?.cancel()
        placeTask = Task {
            await loadPlaceDetail(place: place, bypassCache: false)
        }
    }

    func refreshPlaceDetail() {
        guard let place = selectedPlace else { return }
        placeDetailErrorMessage = nil

        placeTask?.cancel()
        placeTask = Task {
            await loadPlaceDetail(place: place, bypassCache: true)
        }
    }

    var categoryCounts: [PlaceCategory: Int] {
        guard let categories = nearbyResponse?.categories else { return [:] }
        return [
            .restaurants: categories.restaurants.count,
            .bars: categories.bars.count,
            .attractions: categories.attractions.count,
            .shops: categories.shops.count,
        ]
    }

    var rankedItemsForSelectedCategory: [NearbyRankedItem] {
        guard let categories = nearbyResponse?.categories else { return [] }
        let items: [NearbyRankedItem]
        switch selectedCategory {
        case .restaurants: items = categories.restaurants
        case .bars: items = categories.bars
        case .attractions: items = categories.attractions
        case .shops: items = categories.shops
        }
        return items.sorted { $0.score > $1.score }
    }

    var visiblePlaces: [CandidatePlace] {
        rankedItemsForSelectedCategory.compactMap { candidatesById[$0.placeLocalId] }
    }

    private func loadNearby(coordinate: CLLocationCoordinate2D, bypassCache: Bool) async {
        isLoadingNearby = true
        defer { isLoadingNearby = false }

        do {
            var service = mapKitService
            service.configuration.radiusMeters = radiusMeters
            let candidates = try await service.fetchCandidates(near: coordinate)
            let request = NearbyRequest(
                lat: coordinate.latitude,
                lng: coordinate.longitude,
                radiusM: Int(radiusMeters),
                candidates: candidates,
                userContext: nil
            )
            lastNearbyRequest = request
            await loadNearby(with: request, bypassCache: bypassCache)
        } catch {
            nearbyErrorMessage = error.localizedDescription
        }
    }

    private func loadNearby(with request: NearbyRequest, bypassCache: Bool) async {
        isLoadingNearby = true
        defer { isLoadingNearby = false }

        do {
            let client = try makeBackendClient()
            let response = try await client.nearby(request: request, bypassCache: bypassCache)
            nearbyResponse = response
            candidatesById = Dictionary(uniqueKeysWithValues: request.candidates.map { ($0.placeLocalId, $0) })
            selectedCategory = defaultCategory(from: response.categories)
        } catch {
            nearbyErrorMessage = error.localizedDescription
        }
    }

    private func loadPlaceDetail(place: CandidatePlace, bypassCache: Bool) async {
        isLoadingPlaceDetail = true
        defer { isLoadingPlaceDetail = false }

        do {
            let client = try makeBackendClient()
            let request = PlaceDetailRequest(place: place, reviewSnippets: [], firstPartySignals: [:])
            let detail = try await client.placeDetail(request: request, bypassCache: bypassCache)
            placeDetail = detail
        } catch {
            placeDetailErrorMessage = error.localizedDescription
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

    private func defaultCategory(from categories: NearbyCategories) -> PlaceCategory {
        let counts: [(PlaceCategory, Int, Double)] = [
            (.restaurants, categories.restaurants.count, categories.restaurants.first?.score ?? 0),
            (.bars, categories.bars.count, categories.bars.first?.score ?? 0),
            (.attractions, categories.attractions.count, categories.attractions.first?.score ?? 0),
            (.shops, categories.shops.count, categories.shops.first?.score ?? 0),
        ]

        let sorted = counts.sorted { lhs, rhs in
            if lhs.1 != rhs.1 { return lhs.1 > rhs.1 }
            return lhs.2 > rhs.2
        }
        return sorted.first?.0 ?? .restaurants
    }
}
