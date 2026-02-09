import CoreLocation
import SwiftUI

struct PlaceDetailSheet: View {
    let place: CandidatePlace
    let detail: PlaceDetailResponse?
    let isLoading: Bool
    let isLoadingAreaFacts: Bool
    let errorMessage: String?
    let userLocation: CLLocationCoordinate2D?
    let onRefresh: () -> Void
    let onSelectNearby: (String) -> Void

    private struct Chip: Identifiable, Hashable {
        let text: String
        let systemImage: String?

        var id: String { (systemImage ?? "") + "|" + text }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                header
                whyWorthItSection
                quickTakeSection
                nearbyMovesSection
                practicalSection
                areaFunFactSection
                disclosureFooter
            }
            .padding()
        }
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
                        HStack(spacing: 6) {
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
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(detail.nearbyMoves.prefix(3)) { move in
                        Button {
                            onSelectNearby(move.placeLocalId)
                        } label: {
                            VStack(alignment: .leading, spacing: 2) {
                                HStack(alignment: .firstTextBaseline, spacing: 8) {
                                    Text("•")
                                        .foregroundStyle(.secondary)
                                    Text(move.label)
                                        .font(.subheadline)
                                        .foregroundStyle(.primary)
                                        .lineLimit(1)
                                    Spacer(minLength: 0)
                                    Image(systemName: "chevron.right")
                                        .font(.caption2)
                                        .foregroundStyle(.tertiary)
                                }
                                if !move.reason.isEmpty {
                                    Text(move.reason)
                                        .font(.footnote)
                                        .foregroundStyle(.secondary)
                                        .lineLimit(2)
                                        .padding(.leading, 16)
                                }
                            }
                        }
                        .buttonStyle(.plain)
                        .contentShape(Rectangle())
                    }
                }
            } else {
                Text("No nearby context available.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var practicalSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Practical")
                .font(.headline)

            if let detail, !detail.practical.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(detail.practical, id: \.self) { line in
                        Text("• \(line)")
                            .font(.subheadline)
                            .foregroundStyle(.primary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            } else {
                Text("Check the listing for up-to-date details.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
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
                        ForEach(facts.prefix(2)) { fact in
                            VStack(alignment: .leading, spacing: 3) {
                                Text("• \(fact.fact)")
                                    .font(.subheadline)
                                    .foregroundStyle(.primary)
                                    .fixedSize(horizontal: false, vertical: true)
                                Text(fact.source)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                                    .padding(.leading, 14)
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

    private var disclosureFooter: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let detail {
                HStack(spacing: 10) {
                    Text(detail.disclosure)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)

                    Spacer(minLength: 0)

                    confidencePill(detail.confidence)
                }
            } else {
                Text("AI inference based only on place metadata and nearby context.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.top, 4)
    }

    private var quickChips: [Chip] {
        var chips: [Chip] = []

        chips.append(.init(text: typeLabel, systemImage: "tag"))

        if let distanceChip {
            chips.append(distanceChip)
        }

        if let openNow = place.openNow {
            chips.append(.init(text: openNow ? "Open now" : "Closed", systemImage: "clock"))
        }

        if let priceLevel = place.priceLevel, (1...4).contains(priceLevel) {
            chips.append(.init(text: String(repeating: "$", count: priceLevel), systemImage: "dollarsign"))
        }

        if let url = place.url, !url.isEmpty {
            chips.append(.init(text: "Website", systemImage: "safari"))
        }
        if let phone = place.phone, !phone.isEmpty {
            chips.append(.init(text: "Phone", systemImage: "phone"))
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
        return .init(text: formatDistance(meters), systemImage: "location")
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
