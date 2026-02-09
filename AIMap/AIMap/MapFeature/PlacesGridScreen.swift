import CoreLocation
import MapKit
import SwiftUI

struct PlacesGridScreen: View {
    @ObservedObject var viewModel: MapViewModel
    let category: PlaceCategory
    let accentColor: Color

    private let columns: [GridItem] = [
        GridItem(.adaptive(minimum: 170), spacing: 12, alignment: .top)
    ]

    var body: some View {
        ScrollView {
            LazyVGrid(columns: columns, spacing: 12) {
                ForEach(places) { place in
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
    }

    private var places: [CandidatePlace] {
        viewModel.places(for: category)
    }

    private var origin: CLLocationCoordinate2D? {
        viewModel.userLocation ?? viewModel.lastTappedCoordinate
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

