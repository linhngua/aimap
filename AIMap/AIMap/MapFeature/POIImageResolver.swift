import CryptoKit
import Foundation
import MapKit
import UIKit

enum POIImageSourceType: String, Hashable {
    case mapKitPhoto = "mapkit_photo"
    case lookAround = "lookaround"
    case placeholder = "placeholder"
}

struct POIImageResult: Hashable {
    let image: UIImage
    let source: POIImageSourceType
}

actor POIImageCache {
    private let memory = NSCache<NSString, UIImage>()
    private let directoryURL: URL
    private let maxItems: Int
    private let maxBytes: Int64
    private var lastEvictionAt: Date = .distantPast

    init(maxItems: Int = 600, maxBytes: Int64 = 180 * 1024 * 1024) {
        self.maxItems = maxItems
        self.maxBytes = maxBytes

        let fm = FileManager.default
        let base = fm.urls(for: .cachesDirectory, in: .userDomainMask).first ?? fm.temporaryDirectory
        directoryURL = base
            .appendingPathComponent("AIMap", isDirectory: true)
            .appendingPathComponent("poi_image_cache", isDirectory: true)

        try? fm.createDirectory(at: directoryURL, withIntermediateDirectories: true)

        memory.countLimit = 220
    }

    func load(_ cacheKey: String) -> UIImage? {
        if let cached = memory.object(forKey: cacheKey as NSString) {
            return cached
        }

        let url = fileURL(for: cacheKey)
        guard let data = try? Data(contentsOf: url), let image = UIImage(data: data) else { return nil }
        memory.setObject(image, forKey: cacheKey as NSString)
        touch(url)
        return image
    }

    func store(_ image: UIImage, for cacheKey: String, persistToDisk: Bool = true) {
        memory.setObject(image, forKey: cacheKey as NSString)
        guard persistToDisk else { return }

        let url = fileURL(for: cacheKey)
        guard let data = image.jpegData(compressionQuality: 0.82) ?? image.pngData() else { return }
        try? data.write(to: url, options: [.atomic])
        touch(url)
        maybeEvict()
    }

    private func fileURL(for cacheKey: String) -> URL {
        let digest = SHA256.hash(data: Data(cacheKey.utf8))
        let hex = digest.map { String(format: "%02x", $0) }.joined()
        return directoryURL.appendingPathComponent("img_\(hex.prefix(40)).jpg")
    }

    private func touch(_ url: URL) {
        try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: url.path)
    }

    private func maybeEvict() {
        let now = Date()
        if now.timeIntervalSince(lastEvictionAt) < 20 {
            return
        }
        lastEvictionAt = now

        let fm = FileManager.default
        let keys: [URLResourceKey] = [.contentModificationDateKey, .totalFileAllocatedSizeKey, .fileAllocatedSizeKey]
        guard let urls = try? fm.contentsOfDirectory(at: directoryURL, includingPropertiesForKeys: keys, options: [.skipsHiddenFiles]) else {
            return
        }

        var entries: [(url: URL, modified: Date, bytes: Int64)] = []
        entries.reserveCapacity(urls.count)

        var totalBytes: Int64 = 0
        for url in urls {
            let values = try? url.resourceValues(forKeys: Set(keys))
            let modified = values?.contentModificationDate ?? .distantPast
            let bytesInt = values?.totalFileAllocatedSize ?? values?.fileAllocatedSize ?? 0
            let bytes = Int64(bytesInt)
            totalBytes += bytes
            entries.append((url, modified, bytes))
        }

        guard entries.count > maxItems || totalBytes > maxBytes else { return }

        entries.sort { $0.modified < $1.modified }

        var count = entries.count
        var idx = 0
        while idx < entries.count && (count > maxItems || totalBytes > maxBytes) {
            let entry = entries[idx]
            try? fm.removeItem(at: entry.url)
            totalBytes = max(0, totalBytes - entry.bytes)
            count -= 1
            idx += 1
        }
    }
}

struct ApplePlacePhotoProvider {
    func bestPhoto(mapItem: MKMapItem?, targetSize: CGSize) async -> UIImage? {
        // As of iOS 18, MapKit does not expose Apple Maps place photos via public API.
        // This provider is kept for forward-compatibility and will return nil for now.
        _ = mapItem
        _ = targetSize
        return nil
    }
}

struct LookAroundSnapshotProvider {
    func snapshot(mapItem: MKMapItem?, coordinate: CLLocationCoordinate2D, targetSize: CGSize) async -> UIImage? {
        let request: MKLookAroundSceneRequest
        if let mapItem {
            request = MKLookAroundSceneRequest(mapItem: mapItem)
        } else {
            request = MKLookAroundSceneRequest(coordinate: coordinate)
        }

        do {
            let scene = try await request.scene
            guard let scene else { return nil }
            let options = MKLookAroundSnapshotter.Options()
            options.size = targetSize
            options.traitCollection = UITraitCollection(displayScale: UIScreen.main.scale)
            let snapshotter = MKLookAroundSnapshotter(scene: scene, options: options)
            let snapshot = try await snapshotter.snapshot
            return snapshot.image
        } catch {
            return nil
        }
    }
}

final class CategoryPlaceholderProvider {
    private var cached: [String: UIImage] = [:]

    func placeholder(for category: POICategory, size: CGSize, accentColor: UIColor) -> UIImage {
        let key = "\(category.rawValue)|\(Int(size.width))x\(Int(size.height))"
        if let image = cached[key] { return image }

        let renderer = UIGraphicsImageRenderer(size: size)
        let image = renderer.image { context in
            let rect = CGRect(origin: .zero, size: size)

            let start = UIColor(red: 0.10, green: 0.12, blue: 0.18, alpha: 1).cgColor
            let end = UIColor(red: 0.04, green: 0.05, blue: 0.08, alpha: 1).cgColor
            let colors = [start, end] as CFArray
            let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors, locations: [0, 1])!
            context.cgContext.drawLinearGradient(
                gradient,
                start: CGPoint(x: 0, y: 0),
                end: CGPoint(x: rect.maxX, y: rect.maxY),
                options: []
            )

            let overlayColor = accentColor.withAlphaComponent(0.18).cgColor
            context.cgContext.setFillColor(overlayColor)
            context.cgContext.fillEllipse(in: rect.insetBy(dx: rect.width * 0.55, dy: rect.height * 0.55))

            let pointSize = min(size.width, size.height) * 0.24
            let config = UIImage.SymbolConfiguration(pointSize: pointSize, weight: .semibold)
            let base = UIImage(systemName: category.systemImage, withConfiguration: config)
            let icon = base?.withTintColor(UIColor.white.withAlphaComponent(0.84), renderingMode: .alwaysOriginal)
            if let icon {
                let iconRect = CGRect(
                    x: (rect.width - icon.size.width) / 2,
                    y: (rect.height - icon.size.height) / 2,
                    width: icon.size.width,
                    height: icon.size.height
                )
                icon.draw(in: iconRect)
            }
        }

        cached[key] = image
        return image
    }
}

actor POIImageResolver {
    static let shared = POIImageResolver()

    private let cache = POIImageCache()
    private let photoProvider = ApplePlacePhotoProvider()
    private let lookAroundProvider = LookAroundSnapshotProvider()
    private let placeholderProvider = CategoryPlaceholderProvider()

    private var inFlight: [String: Task<POIImageResult, Never>] = [:]

    func resolve(placeLocalId: String, mapItem: MKMapItem?, coordinate: CLLocationCoordinate2D, category: POICategory, targetSize: CGSize, accentColor: UIColor) async -> POIImageResult {
        let requestKey = "\(placeLocalId)|\(Int(targetSize.width))x\(Int(targetSize.height))"
        if let existing = inFlight[requestKey] {
            return await existing.value
        }

        let task = Task<POIImageResult, Never> {
            let photoKey = self.cacheKey(provider: .mapKitPhoto, placeLocalId: placeLocalId, targetSize: targetSize)
            if let image = await self.cache.load(photoKey) {
                return POIImageResult(image: image, source: .mapKitPhoto)
            }

            if let image = await self.photoProvider.bestPhoto(mapItem: mapItem, targetSize: targetSize) {
                await self.cache.store(image, for: photoKey)
                return POIImageResult(image: image, source: .mapKitPhoto)
            }

            let lookKey = self.cacheKey(provider: .lookAround, placeLocalId: placeLocalId, targetSize: targetSize)
            if let image = await self.cache.load(lookKey) {
                return POIImageResult(image: image, source: .lookAround)
            }

            if let image = await self.lookAroundProvider.snapshot(mapItem: mapItem, coordinate: coordinate, targetSize: targetSize) {
                await self.cache.store(image, for: lookKey)
                return POIImageResult(image: image, source: .lookAround)
            }

            let placeholder = self.placeholderProvider.placeholder(for: category, size: targetSize, accentColor: accentColor)
            let placeholderKey = self.cacheKey(provider: .placeholder, placeLocalId: placeLocalId, targetSize: targetSize)
            await self.cache.store(placeholder, for: placeholderKey, persistToDisk: false)
            return POIImageResult(image: placeholder, source: .placeholder)
        }

        inFlight[requestKey] = task
        let result = await task.value
        inFlight[requestKey] = nil
        return result
    }

    func prefetch(places: [CandidatePlace], mapItemLookup: (String) -> MKMapItem?, accentColor: UIColor, maxCount: Int = 12) async {
        let size = CGSize(width: 520, height: 300)
        for place in places.prefix(maxCount) {
            if Task.isCancelled { return }
            _ = await resolve(
                placeLocalId: place.placeLocalId,
                mapItem: mapItemLookup(place.placeLocalId),
                coordinate: place.coordinate,
                category: POICategory.classify(place),
                targetSize: size,
                accentColor: accentColor
            )
        }
    }

    private func cacheKey(provider: POIImageSourceType, placeLocalId: String, targetSize: CGSize) -> String {
        "\(provider.rawValue)|\(placeLocalId)|\(Int(targetSize.width))x\(Int(targetSize.height))"
    }
}
