import CryptoKit
import Foundation

actor PlaceDetailCache {
    private struct Envelope: Codable {
        let savedAt: Date
        let response: PlaceDetailResponse
    }

    private let maxAgeSeconds: TimeInterval
    private let directoryURL: URL

    init(maxAgeSeconds: TimeInterval = 7 * 24 * 60 * 60) {
        self.maxAgeSeconds = maxAgeSeconds
        directoryURL = PlaceDetailCache.makeDirectoryURL()
        try? FileManager.default.createDirectory(at: directoryURL, withIntermediateDirectories: true)
    }

    func load(placeLocalId: String) -> PlaceDetailResponse? {
        let url = fileURL(for: placeLocalId)
        guard let data = try? Data(contentsOf: url) else { return nil }

        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        guard let envelope = try? decoder.decode(Envelope.self, from: data) else {
            return nil
        }

        let age = Date().timeIntervalSince(envelope.savedAt)
        guard age >= 0, age <= maxAgeSeconds else {
            try? FileManager.default.removeItem(at: url)
            return nil
        }

        return envelope.response
    }

    func save(placeLocalId: String, response: PlaceDetailResponse) {
        let url = fileURL(for: placeLocalId)
        let envelope = Envelope(savedAt: Date(), response: response)

        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.keyEncodingStrategy = .convertToSnakeCase
        guard let data = try? encoder.encode(envelope) else { return }

        try? data.write(to: url, options: [.atomic])
    }

    private func fileURL(for placeLocalId: String) -> URL {
        let digest = SHA256.hash(data: Data(placeLocalId.utf8))
        let hex = digest.map { String(format: "%02x", $0) }.joined()
        return directoryURL.appendingPathComponent("place_detail_\(hex.prefix(32)).json")
    }

    private static func makeDirectoryURL() -> URL {
        let fm = FileManager.default
        let support = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
        let dir = (support ?? fm.temporaryDirectory)
            .appendingPathComponent("AIMap", isDirectory: true)
            .appendingPathComponent("place_detail_cache", isDirectory: true)
        return dir
    }
}

