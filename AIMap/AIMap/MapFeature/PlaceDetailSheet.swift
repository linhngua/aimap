import CoreLocation
import MapKit
import SwiftUI

struct PlaceDetailSheet: View {
    let place: CandidatePlace
    let mapItem: MKMapItem?
    let detail: PlaceDetailResponse?
    let isLoading: Bool
    let isLoadingAreaFacts: Bool
    let errorMessage: String?
    let userLocation: CLLocationCoordinate2D?
    let onRefresh: () -> Void
    let onSelectNearby: (String) -> Void

    @Environment(\.openURL) private var openURL

    private enum ChipAction: Hashable {
        case none
        case openURL(URL)
        case call(String)
        case openInAppleMaps
        case navigate
    }

    private struct Chip: Identifiable, Hashable {
        let text: String
        let systemImage: String?
        let action: ChipAction

        var id: String {
            switch action {
            case .none:
                return (systemImage ?? "") + "|" + text
            case .openURL(let url):
                return (systemImage ?? "") + "|" + text + "|" + url.absoluteString
            case .call(let number):
                return (systemImage ?? "") + "|" + text + "|" + number
            case .openInAppleMaps:
                return (systemImage ?? "") + "|" + text + "|maps"
            case .navigate:
                return (systemImage ?? "") + "|" + text + "|navigate"
            }
        }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                heroImage
                header
                foodSection
                whyWorthItSection
                quickTakeSection
                nearbyMovesSection
                areaFunFactSection
            }
            .padding()
        }
    }

    private var heroImage: some View {
        PlaceProfileImage(
            place: place,
            mapItem: mapItem,
            category: POICategory.classify(place)
        )
        .frame(height: 180)
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(Color.white.opacity(0.10), lineWidth: 1)
        )
        .accessibilityHidden(true)
    }

    private var header: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text(detail?.headline ?? place.name)
                    .font(.title3)
                    .fontWeight(.semibold)
                    .lineLimit(2)

                if !place.addressShort.isEmpty {
                    Text(place.addressShort)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
            }

            Spacer(minLength: 0)

            Button(action: onRefresh) {
                Image(systemName: "arrow.clockwise")
            }
            .accessibilityLabel("Refresh place")
        }
    }

    private var whyWorthItSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Why this might be worth it")
                .font(.headline)

            if isLoading, detail == nil {
                HStack(spacing: 10) {
                    ProgressView()
                    Text("Generating a brief…")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                .padding(.vertical, 4)
            } else if let errorMessage, detail == nil {
                Text(errorMessage)
                    .font(.footnote)
                    .foregroundStyle(.red)
            } else if let detail {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(whyLines(from: detail.whyWorthIt), id: \.self) { line in
                        Text(line)
                            .font(.subheadline)
                            .foregroundStyle(.primary)
                            .lineLimit(2)
                    }
                }
            } else {
                Text("No brief yet.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var quickTakeSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Quick take")
                .font(.headline)

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(quickChips) { chip in
                        quickChipView(chip)
                    }
                }
            }
        }
    }

    private var nearbyMovesSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("What to do nearby")
                .font(.headline)

            if let detail, !detail.nearbyMoves.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(detail.nearbyMoves.prefix(2)) { move in
                        Button {
                            onSelectNearby(move.placeLocalId)
                        } label: {
                            HStack(spacing: 10) {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(move.label)
                                        .font(.subheadline)
                                        .foregroundStyle(.primary)
                                        .lineLimit(1)
                                    if !move.reason.isEmpty {
                                        Text(move.reason)
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                            .lineLimit(1)
                                    }
                                }

                                Spacer(minLength: 0)

                                Image(systemName: "chevron.right")
                                    .font(.caption2)
                                    .foregroundStyle(.tertiary)
                            }
                            .padding(.vertical, 8)
                            .padding(.horizontal, 10)
                            .background(.thinMaterial)
                            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                        }
                        .buttonStyle(.plain)
                    }
                }
            } else {
                Text("No nearby context available.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder
    private var foodSection: some View {
        if place.normalizedPrimaryCategory == "restaurant" {
            VStack(alignment: .leading, spacing: 8) {
                Text("Food")
                    .font(.headline)

                if let cuisine = detail?.cuisine, !cuisine.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    Text("Cuisine: \(cuisine)")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                } else {
                    Text("Cuisine: —")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }

                if let dishes = detail?.bestDishes, !dishes.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(dishes.prefix(5), id: \.self) { dish in
                            Text("• \(dish)")
                                .font(.subheadline)
                                .foregroundStyle(.primary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                } else {
                    Text("Dish ideas will appear here.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private var areaFunFactSection: some View {
        let facts = detail?.areaFunFact ?? []

        return VStack(alignment: .leading, spacing: 8) {
            Text("Area fun fact")
                .font(.headline)

            ZStack(alignment: .leading) {
                if facts.isEmpty {
                    HStack(spacing: 10) {
                        if isLoadingAreaFacts {
                            ProgressView()
                        }
                        Text(isLoadingAreaFacts ? "Loading verified area facts…" : "No verified area facts available offline.")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    .transition(.opacity)
                } else {
                    VStack(alignment: .leading, spacing: 10) {
                        ForEach(facts.prefix(1)) { fact in
                            VStack(alignment: .leading, spacing: 3) {
                                Text("• \(fact.fact)")
                                    .font(.subheadline)
                                    .foregroundStyle(.primary)
                                    .fixedSize(horizontal: false, vertical: true)
                                // Source intentionally hidden in UI (keep verified fact text only).
                            }
                        }
                    }
                    .transition(.opacity)
                }
            }
            .animation(.easeInOut(duration: 0.18), value: facts)
        }
        .padding(.top, 2)
    }

    private var quickChips: [Chip] {
        var chips: [Chip] = []

        chips.append(.init(text: typeLabel, systemImage: "tag", action: .none))

        if let distanceChip {
            chips.append(distanceChip)
        }

        chips.append(.init(text: "Navigate", systemImage: "arrow.triangle.turn.up.right.diamond.fill", action: .navigate))

        if let rating = place.rating {
            chips.append(.init(text: String(format: "%.1f", rating), systemImage: "star.fill", action: .none))
        }

        if let openNow = place.openNow {
            chips.append(.init(text: openNow ? "Open now" : "Closed", systemImage: "clock", action: .none))
        }

        if let priceLevel = place.priceLevel, (1...4).contains(priceLevel) {
            chips.append(.init(text: String(repeating: "$", count: priceLevel), systemImage: "dollarsign", action: .none))
        }

        if let url = place.url, let websiteURL = URL(string: url) {
            chips.append(.init(text: "Website", systemImage: "safari", action: .openURL(websiteURL)))
        }

        chips.append(.init(text: "Hours", systemImage: "clock.badge.questionmark", action: .openInAppleMaps))

        if place.normalizedPrimaryCategory == "restaurant" || place.normalizedPrimaryCategory == "bar" {
            chips.append(.init(text: "Menu", systemImage: "menucard", action: .openInAppleMaps))
        }

        if let phone = place.phone, !phone.isEmpty {
            chips.append(.init(text: "Call", systemImage: "phone", action: .call(phone)))
        }

        return chips
    }

    private var typeLabel: String {
        switch place.normalizedPrimaryCategory {
        case "restaurant": return "Restaurant"
        case "bar": return "Bar"
        case "shop": return "Shop"
        default: return "Attraction"
        }
    }

    private var distanceChip: Chip? {
        guard let userLocation else { return nil }
        let origin = CLLocation(latitude: userLocation.latitude, longitude: userLocation.longitude)
        let dest = CLLocation(latitude: place.lat, longitude: place.lng)
        let meters = origin.distance(from: dest)
        guard meters.isFinite, meters >= 0 else { return nil }
        return .init(text: formatDistance(meters), systemImage: "location", action: .none)
    }

    private func formatDistance(_ meters: CLLocationDistance) -> String {
        let formatter = MeasurementFormatter()
        formatter.unitOptions = .naturalScale
        formatter.unitStyle = .short
        return formatter.string(from: Measurement(value: meters, unit: UnitLength.meters))
    }

    private func whyLines(from text: String) -> [String] {
        let lines = text
            .split(separator: "\n")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        return Array(lines.prefix(3))
    }

    @ViewBuilder
    private func quickChipView(_ chip: Chip) -> some View {
        let content = HStack(spacing: 6) {
            if let systemImage = chip.systemImage {
                Image(systemName: systemImage)
                    .font(.caption)
            }
            Text(chip.text)
                .font(.caption)
                .lineLimit(1)
        }
        .padding(.vertical, 7)
        .padding(.horizontal, 10)
        .background(.thinMaterial)
        .clipShape(Capsule())

        switch chip.action {
        case .none:
            content
        case .openURL(let url):
            Link(destination: url) { content }
        case .call(let number):
            Button {
                if let url = makePhoneURL(number) {
                    openURL(url)
                }
            } label: {
                content
            }
        case .openInAppleMaps:
            Button {
                openInAppleMaps()
            } label: {
                content
            }
        case .navigate:
            Button {
                openDirectionsInAppleMaps()
            } label: {
                content
            }
        }
    }

    private func openInAppleMaps() {
        if let mapItem {
            mapItem.openInMaps(launchOptions: nil)
            return
        }

        let placemark = MKPlacemark(coordinate: place.coordinate)
        let item = MKMapItem(placemark: placemark)
        item.name = place.name
        item.openInMaps(launchOptions: nil)
    }

    private func openDirectionsInAppleMaps() {
        let destination: MKMapItem = {
            if let mapItem { return mapItem }
            let placemark = MKPlacemark(coordinate: place.coordinate)
            let item = MKMapItem(placemark: placemark)
            item.name = place.name
            return item
        }()

        let launchOptions: [String: Any] = [
            MKLaunchOptionsDirectionsModeKey: MKLaunchOptionsDirectionsModeDriving,
        ]

        MKMapItem.openMaps(with: [.forCurrentLocation(), destination], launchOptions: launchOptions)
    }

    private func makePhoneURL(_ raw: String) -> URL? {
        let digits = raw.filter { $0.isNumber || $0 == "+" }
        guard !digits.isEmpty else { return nil }
        return URL(string: "tel://\(digits)")
    }

    @ViewBuilder
    private func confidencePill(_ confidence: PlaceDetailConfidence) -> some View {
        let (label, color): (String, Color) = {
            switch confidence {
            case .high: return ("High", .green)
            case .medium: return ("Medium", .blue)
            case .low: return ("Low", .gray)
            }
        }()

        Text(label)
            .font(.caption2)
            .fontWeight(.semibold)
            .padding(.vertical, 5)
            .padding(.horizontal, 10)
            .background(color.opacity(0.16))
            .foregroundStyle(color)
            .clipShape(Capsule())
            .accessibilityLabel("Confidence \(label)")
    }
}
