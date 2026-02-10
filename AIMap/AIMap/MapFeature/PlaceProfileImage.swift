import MapKit
import SwiftUI
import UIKit

struct PlaceProfileImage: View {
    let place: CandidatePlace
    let mapItem: MKMapItem?
    let category: POICategory

    private let targetSize = CGSize(width: 520, height: 300)
    private let accentColor: UIColor = LuxuryMapStyle.premium.accentColor

    @State private var image: UIImage?
    @State private var source: POIImageSourceType = .placeholder

    var body: some View {
        ZStack {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
                    .transition(.opacity)
            } else {
                placeholder
            }
        }
        .clipped()
        .task(id: taskKey) {
            await resolve()
        }
        .accessibilityLabel(accessibilityLabel)
    }

    private var taskKey: String {
        "\(place.placeLocalId)|\(Int(targetSize.width))x\(Int(targetSize.height))"
    }

    private func resolve() async {
        let result = await POIImageResolver.shared.resolve(
            placeLocalId: place.placeLocalId,
            mapItem: mapItem,
            coordinate: place.coordinate,
            category: category,
            targetSize: targetSize,
            accentColor: accentColor
        )

        await MainActor.run {
            source = result.source
            withAnimation(.easeInOut(duration: 0.18)) {
                image = result.image
            }
        }
    }

    private var placeholder: some View {
        ZStack {
            LinearGradient(
                colors: [
                    Color(.sRGB, red: 0.10, green: 0.12, blue: 0.18, opacity: 1),
                    Color(.sRGB, red: 0.04, green: 0.05, blue: 0.08, opacity: 1),
                ],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )

            Image(systemName: category.systemImage)
                .font(.system(size: 28, weight: .semibold))
                .foregroundStyle(.white.opacity(0.82))
        }
    }

    private var accessibilityLabel: String {
        switch source {
        case .mapKitPhoto: return "\(place.name) photo"
        case .lookAround: return "\(place.name) Look Around snapshot"
        case .placeholder: return "\(place.name) placeholder image"
        }
    }
}

