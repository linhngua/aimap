import CryptoKit
import Foundation

actor AreaFactsCache {
    private struct Envelope: Codable {
        let savedAt: Date
        let facts: [AreaFact]
    }

    private let maxAgeSeconds: TimeInterval
    private let directoryURL: URL

    init(maxAgeSeconds: TimeInterval = 30 * 24 * 60 * 60) {
        self.maxAgeSeconds = maxAgeSeconds
        directoryURL = AreaFactsCache.makeDirectoryURL()
        try? FileManager.default.createDirectory(at: directoryURL, withIntermediateDirectories: true)
    }

    func load(cellId: String) -> [AreaFact]? {
        let url = fileURL(for: cellId)
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

        return envelope.facts
    }

    func save(cellId: String, facts: [AreaFact]) {
        let url = fileURL(for: cellId)
        let envelope = Envelope(savedAt: Date(), facts: facts)

        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.keyEncodingStrategy = .convertToSnakeCase
        guard let data = try? encoder.encode(envelope) else { return }

        try? data.write(to: url, options: [.atomic])
    }

    private func fileURL(for cellId: String) -> URL {
        let digest = SHA256.hash(data: Data(cellId.utf8))
        let hex = digest.map { String(format: "%02x", $0) }.joined()
        return directoryURL.appendingPathComponent("area_facts_\(hex.prefix(32)).json")
    }

    private static func makeDirectoryURL() -> URL {
        let fm = FileManager.default
        let support = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
        let dir = (support ?? fm.temporaryDirectory)
            .appendingPathComponent("AIMap", isDirectory: true)
            .appendingPathComponent("area_facts_cache", isDirectory: true)
        return dir
    }
}

