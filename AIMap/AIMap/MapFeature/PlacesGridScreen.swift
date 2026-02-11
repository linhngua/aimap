import CoreLocation
import MapKit
import SwiftUI

struct PlacesGridScreen: View {
    @ObservedObject var viewModel: MapViewModel
    let category: POICategory
    let accentColor: Color

    private let columns: [GridItem] = [
        GridItem(.adaptive(minimum: 170), spacing: 12, alignment: .top)
    ]

    @State private var gridPlaces: [CandidatePlace] = []
    @State private var scoresById: [String: Double] = [:]
    @State private var allowScoreStarsById: Set<String> = []
    @State private var isLoadingMore: Bool = false
    @State private var outOfCoverageMessage: String?

    var body: some View {
        ScrollView {
            LazyVGrid(columns: columns, spacing: 12) {
                ForEach(gridPlaces) { place in
                    let mapItem = viewModel.mapItem(for: place.placeLocalId)
                    let score = scoresById[place.placeLocalId]
                    let allowScoreAsRating = allowScoreStarsById.contains(place.placeLocalId)
                    Button {
                        viewModel.selectPlace(place)
                    } label: {
                        PlaceGridCard(
                            place: place,
                            mapItem: mapItem,
                            origin: origin,
                            score: score,
                            allowScoreAsRating: allowScoreAsRating,
                            accentColor: accentColor
                        )
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal)
            .padding(.bottom, 20)
        }
        .background(Color(.systemBackground))
        .navigationTitle(category.title)
        .navigationBarTitleDisplayMode(.inline)
        .overlay(alignment: .top) {
            VStack(spacing: 8) {
                if let message = outOfCoverageMessage {
                    Text(message)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .padding(10)
                        .background(.thinMaterial)
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                }

                if isLoadingMore {
                    HStack(spacing: 8) {
                        ProgressView()
                        Text("Loading more…")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    .padding(10)
                    .background(.thinMaterial)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                }
            }
            .padding(.top, 8)
        }
        .task(id: refreshKey) {
            await loadPlaces()
        }
    }

    private var origin: CLLocationCoordinate2D? {
        viewModel.userLocation ?? viewModel.lastTappedCoordinate
    }

    private var refreshKey: String {
        let tierKey = viewModel.nearbyTier?.rawValue ?? "none"
        let queryKey: String = {
            guard let query = viewModel.nearbyPayload?.query else { return "none" }
            let lat = String(format: "%.4f", query.lat)
            let lng = String(format: "%.4f", query.lng)
            return "\(lat),\(lng),\(query.radiusM)"
        }()
        return "\(category.rawValue)|\(tierKey)|\(queryKey)"
    }

    private func loadPlaces() async {
        let initialItems = viewModel.listItems(for: category)
        let initial = initialItems.map(\.place)
        let filteredInitial = filterToPlausibleNearby(initial, origin: origin)
        await MainActor.run {
            scoresById = Dictionary(uniqueKeysWithValues: initialItems.map { ($0.place.placeLocalId, $0.score) })
            allowScoreStarsById = Set(
                initialItems
                    .filter { !$0.why.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
                    .map { $0.place.placeLocalId }
            )
            gridPlaces = sortByDistance(filteredInitial, origin: origin)
            prefetchImages(for: gridPlaces)
        }

        guard gridPlaces.count < 8, let origin else { return }
        guard Coverage.isSupported(origin) else {
            await MainActor.run {
                outOfCoverageMessage = Coverage.outOfCoverageMessage()
            }
            viewModel.recordOutOfCoverageRequest(origin, source: "grid")
            return
        }
        await MainActor.run { outOfCoverageMessage = nil }

        await MainActor.run { isLoadingMore = true }
        defer { Task { @MainActor in isLoadingMore = false } }

        let radii: [Double] = [
            max(600, viewModel.radiusMeters),
            max(1800, viewModel.radiusMeters * 3),
            max(5000, viewModel.radiusMeters * 6),
        ]

        var merged = Dictionary(uniqueKeysWithValues: gridPlaces.map { ($0.placeLocalId, $0) })
        var service = MapKitNearbySearchService()
        service.configuration.maxCandidates = 120

        for radius in radii {
            if Task.isCancelled { return }
            service.configuration.radiusMeters = radius
            do {
                let pairs = try await service.fetchCandidatesAndMapItems(near: origin)
                let candidates = pairs.map(\.0)
                let mapItems = Dictionary(uniqueKeysWithValues: pairs.map { ($0.0.placeLocalId, $0.1) })
                await MainActor.run {
                    viewModel.upsertMapItems(mapItems)
                }
                for place in candidates {
                    guard POICategory.classify(place) == category else { continue }
                    merged[place.placeLocalId] = place
                }
                let all = Array(merged.values)
                if all.count >= 8 {
                    await MainActor.run {
                        gridPlaces = sortByDistance(all, origin: origin)
                        prefetchImages(for: gridPlaces)
                    }
                    return
                }
            } catch {
                // ignore; keep best available results
            }
        }

        await MainActor.run {
            gridPlaces = sortByDistance(Array(merged.values), origin: origin)
            prefetchImages(for: gridPlaces)
        }
    }

    private func prefetchImages(for places: [CandidatePlace]) {
        let mapItemsSnapshot: [String: MKMapItem] = Dictionary(uniqueKeysWithValues: places.compactMap { place in
            guard let item = viewModel.mapItem(for: place.placeLocalId) else { return nil }
            return (place.placeLocalId, item)
        })
        let placesSnapshot = places
        let accent = UIColor(accentColor)
        Task.detached(priority: .utility) {
            await POIImageResolver.shared.prefetch(
                places: placesSnapshot,
                mapItemLookup: { mapItemsSnapshot[$0] },
                accentColor: accent,
                maxCount: 10
            )
        }
    }

    private func sortByDistance(_ places: [CandidatePlace], origin: CLLocationCoordinate2D?) -> [CandidatePlace] {
        guard let origin else { return places }
        let a = CLLocation(latitude: origin.latitude, longitude: origin.longitude)
        return places.sorted { lhs, rhs in
            let dl = a.distance(from: CLLocation(latitude: lhs.lat, longitude: lhs.lng))
            let dr = a.distance(from: CLLocation(latitude: rhs.lat, longitude: rhs.lng))
            return dl < dr
        }
    }

    private func filterToPlausibleNearby(_ places: [CandidatePlace], origin: CLLocationCoordinate2D?) -> [CandidatePlace] {
        guard let origin else { return places }
        let maxDistanceM = max(5_000, viewModel.radiusMeters * 8)
        let a = CLLocation(latitude: origin.latitude, longitude: origin.longitude)
        return places.filter { place in
            let meters = a.distance(from: CLLocation(latitude: place.lat, longitude: place.lng))
            return meters.isFinite && meters <= maxDistanceM
        }
    }
}

private struct PlaceGridCard: View {
    let place: CandidatePlace
    let mapItem: MKMapItem?
    let origin: CLLocationCoordinate2D?
    let score: Double?
    let allowScoreAsRating: Bool
    let accentColor: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            PlaceProfileImage(place: place, mapItem: mapItem, category: POICategory.classify(place))
                .frame(height: 120)
                .clipShape(RoundedRectangle(cornerRadius: 14))
                .overlay(
                    RoundedRectangle(cornerRadius: 14)
                        .stroke(accentColor.opacity(0.22), lineWidth: 1)
                )

            VStack(alignment: .leading, spacing: 6) {
                Text(place.name)
                    .font(.headline)
                    .lineLimit(2)

                HStack(spacing: 8) {
                    if let distanceText {
                        Label(distanceText, systemImage: "location.fill")
                            .labelStyle(.titleAndIcon)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }

                    if let ratingValue {
                        HStack(spacing: 6) {
                            RatingStarsView(rating: ratingValue, tint: accentColor, size: 11)
                            Text(String(format: "%.1f", ratingValue))
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                    }
                }

                Text(place.addressShort)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            .padding(.horizontal, 4)
            .padding(.bottom, 6)
        }
        .padding(12)
        .background(
            RoundedRectangle(cornerRadius: 16)
                .fill(.ultraThinMaterial)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 16)
                .stroke(
                    LinearGradient(
                        colors: [
                            accentColor.opacity(0.26),
                            Color.white.opacity(0.10),
                        ],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    ),
                    lineWidth: 1
                )
        )
        .shadow(color: Color.black.opacity(0.18), radius: 12, x: 0, y: 8)
    }

    private var ratingValue: Double? {
        if let rating = place.rating {
            return max(0, min(5, rating))
        }
        if allowScoreAsRating, let score, score > 0.01 {
            return max(0, min(5, score * 5))
        }
        return nil
    }

    private var distanceText: String? {
        guard let origin else { return nil }
        let a = CLLocation(latitude: origin.latitude, longitude: origin.longitude)
        let b = CLLocation(latitude: place.lat, longitude: place.lng)
        let meters = a.distance(from: b)
        let formatter = MeasurementFormatter()
        formatter.unitOptions = .naturalScale
        formatter.unitStyle = .short
        formatter.numberFormatter.maximumFractionDigits = 0
        formatter.numberFormatter.minimumFractionDigits = 0
        return formatter.string(from: Measurement(value: meters, unit: UnitLength.meters))
    }
}
