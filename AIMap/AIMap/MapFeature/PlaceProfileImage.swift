import MapKit
import SwiftUI
import UIKit

private actor PlaceProfileImageService {
    static let shared = PlaceProfileImageService()

    private let cache = NSCache<NSString, UIImage>()
    private var inFlight: [String: Task<UIImage?, Never>] = [:]

    func image(for place: CandidatePlace, size: CGSize) async -> UIImage? {
        let key = "\(place.placeLocalId)|\(Int(size.width))x\(Int(size.height))"
        if let cached = cache.object(forKey: key as NSString) { return cached }
        if let existing = inFlight[key] { return await existing.value }

        let task = Task<UIImage?, Never> {
            let scene = await fetchLookAroundScene(coordinate: place.coordinate)
            guard let scene else { return nil }
            let image = await fetchLookAroundSnapshot(scene: scene, size: size)
            return image
        }
        inFlight[key] = task
        let image = await task.value
        inFlight[key] = nil
        if let image {
            cache.setObject(image, forKey: key as NSString)
        }
        return image
    }

    private func fetchLookAroundScene(coordinate: CLLocationCoordinate2D) async -> MKLookAroundScene? {
        await withCheckedContinuation { continuation in
            let request = MKLookAroundSceneRequest(coordinate: coordinate)
            request.getSceneWithCompletionHandler { scene, _ in
                continuation.resume(returning: scene)
            }
        }
    }

    private func fetchLookAroundSnapshot(scene: MKLookAroundScene, size: CGSize) async -> UIImage? {
        await withCheckedContinuation { continuation in
            let options = MKLookAroundSnapshotter.Options()
            options.size = size
            let snapshotter = MKLookAroundSnapshotter(scene: scene, options: options)
            snapshotter.getSnapshotWithCompletionHandler { snapshot, _ in
                continuation.resume(returning: snapshot?.image)
            }
        }
    }
}

struct PlaceProfileImage: View {
    let place: CandidatePlace

    @State private var image: UIImage?

    var body: some View {
        ZStack {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
            } else {
                placeholder
            }
        }
        .clipped()
        .task(id: place.placeLocalId) {
            image = await PlaceProfileImageService.shared.image(for: place, size: CGSize(width: 520, height: 300))
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

            Image(systemName: iconName)
                .font(.system(size: 28, weight: .semibold))
                .foregroundStyle(.white.opacity(0.82))
        }
    }

    private var iconName: String {
        switch place.normalizedPrimaryCategory {
        case "bar": return "wineglass"
        case "restaurant": return "fork.knife"
        case "shop": return "bag"
        default: return "sparkles"
        }
    }
}
