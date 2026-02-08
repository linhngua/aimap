import CoreLocation
import Foundation

struct NearbySpatialKey: Hashable {
    let cellId: String
    let radiusBucketM: Int
    let timeBucket: String
    let categories: [String]

    static let fixedCategories: [String] = ["restaurants", "bars", "attractions", "shops"]

    static func radiusBucket(for radiusMeters: Double) -> Int {
        if radiusMeters <= 400 { return 300 }
        if radiusMeters <= 1100 { return 800 }
        return 1500
    }

    static func geohashPrecision(for radiusBucketM: Int) -> Int {
        switch radiusBucketM {
        case 300: return 7
        case 800: return 6
        default: return 5
        }
    }

    static func timeBucket(now: Date = Date(), bucketSeconds: Int = 30 * 60) -> String {
        let seconds = Int(now.timeIntervalSince1970)
        let bucketStart = (seconds / bucketSeconds) * bucketSeconds
        return String(bucketStart)
    }

    static func make(
        coordinate: CLLocationCoordinate2D,
        radiusMeters: Double,
        now: Date = Date(),
        categories: [String] = fixedCategories
    ) -> NearbySpatialKey {
        let bucket = radiusBucket(for: radiusMeters)
        let precision = geohashPrecision(for: bucket)
        let cellId = Geohash.encode(latitude: coordinate.latitude, longitude: coordinate.longitude, precision: precision)
        let timeBucket = timeBucket(now: now)
        return NearbySpatialKey(cellId: cellId, radiusBucketM: bucket, timeBucket: timeBucket, categories: categories)
    }

    func neighborCellIds() -> [String] {
        Geohash.neighbors(of: cellId)
    }

    func lowerPrecisionCellId() -> String? {
        guard cellId.count > 1 else { return nil }
        return String(cellId.dropLast())
    }
}

