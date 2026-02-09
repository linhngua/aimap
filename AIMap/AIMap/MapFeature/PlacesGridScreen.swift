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
    @State private var isLoadingMore: Bool = false

    var body: some View {
        ScrollView {
            LazyVGrid(columns: columns, spacing: 12) {
                ForEach(gridPlaces) { place in
                    Button {
                        viewModel.selectPlace(place)
                    } label: {
                        PlaceGridCard(place: place, origin: origin, accentColor: accentColor)
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
                .padding(.top, 8)
            }
        }
        .task(id: category) {
            await loadPlaces()
        }
    }

    private var origin: CLLocationCoordinate2D? {
        viewModel.userLocation ?? viewModel.lastTappedCoordinate
    }

    private func loadPlaces() async {
        let initial = viewModel.listItems(for: category).map(\.place)
        await MainActor.run {
            gridPlaces = sortByDistance(initial, origin: origin)
        }

        guard gridPlaces.count < 8, let origin else { return }

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
                let candidates = try await service.fetchCandidates(near: origin)
                for place in candidates {
                    guard POICategory.classify(place) == category else { continue }
                    merged[place.placeLocalId] = place
                }
                let all = Array(merged.values)
                if all.count >= 8 {
                    await MainActor.run {
                        gridPlaces = sortByDistance(all, origin: origin)
                    }
                    return
                }
            } catch {
                // ignore; keep best available results
            }
        }

        await MainActor.run {
            gridPlaces = sortByDistance(Array(merged.values), origin: origin)
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
}

private struct PlaceGridCard: View {
    let place: CandidatePlace
    let origin: CLLocationCoordinate2D?
    let accentColor: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            PlaceProfileImage(place: place)
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

                    if let rating = place.rating {
                        HStack(spacing: 4) {
                            Image(systemName: "star.fill")
                                .font(.caption2)
                                .foregroundStyle(accentColor)
                            Text(String(format: "%.1f", rating))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            if let count = place.ratingCount, count > 0 {
                                Text("(\(count))")
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
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
                .fill(Color(.secondarySystemBackground))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 16)
                .stroke(accentColor.opacity(0.18), lineWidth: 1)
        )
    }

    private var distanceText: String? {
        guard let origin else { return nil }
        let a = CLLocation(latitude: origin.latitude, longitude: origin.longitude)
        let b = CLLocation(latitude: place.lat, longitude: place.lng)
        let meters = a.distance(from: b)
        let formatter = MeasurementFormatter()
        formatter.unitStyle = .short
        formatter.numberFormatter.maximumFractionDigits = meters < 1000 ? 0 : 1
        return formatter.string(from: Measurement(value: meters, unit: UnitLength.meters))
    }
}
