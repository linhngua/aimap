import CoreLocation
import Foundation
import SQLite3

private let SQLITE_TRANSIENT = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

actor NearbyCache {
    struct CachedResult: Hashable {
        let spatialKey: NearbySpatialKey
        let etag: String?
        let payload: NearbyPayload
        let accuracy: NearbyAccuracy
        let sourceCellId: String?
        let sourceDistanceM: Double?
        let producedAt: Date
    }

    private let maxEntries: Int
    private let db: OpaquePointer?

    init(maxEntries: Int = 200) {
        self.maxEntries = maxEntries
        db = NearbyCache.openDatabase()
        NearbyCache.createSchema(db: db)
    }

    deinit {
        if let db {
            sqlite3_close(db)
        }
    }

    func loadNearest(for key: NearbySpatialKey, coordinate: CLLocationCoordinate2D) -> CachedResult? {
        guard let db else { return nil }
        let nowSeconds = Int64(Date().timeIntervalSince1970)

        if let exact = fetchEntry(cellId: key.cellId, key: key, db: db) {
            touch(cellId: key.cellId, key: key, nowSeconds: nowSeconds, db: db)
            return exact
        }

        let neighborIds = key.neighborCellIds()
        let neighborEntries = neighborIds.compactMap { fetchEntry(cellId: $0, key: key, db: db) }
        if let best = bestByDistance(entries: neighborEntries, to: coordinate) {
            touch(cellId: best.spatialKey.cellId, key: best.spatialKey, nowSeconds: nowSeconds, db: db)
            return best
        }

        if let lowerPrefix = key.lowerPrecisionCellId() {
            let prefixMatches = fetchByPrefix(prefix: lowerPrefix, key: key, limit: 50, db: db)
            if let best = bestByDistance(entries: prefixMatches, to: coordinate) {
                touch(cellId: best.spatialKey.cellId, key: best.spatialKey, nowSeconds: nowSeconds, db: db)
                return best
            }
        }

        return nil
    }

    func recentCellIds(prefix: String, since: Date, limit: Int = 300) -> [String] {
        guard let db else { return [] }
        let trimmedPrefix = prefix.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedPrefix.isEmpty else { return [] }

        let sinceSeconds = Int64(since.timeIntervalSince1970)
        let safeLimit = max(1, min(800, limit))

        let sql = """
        SELECT cell_id, MAX(produced_at) AS max_produced
        FROM nearby_cache
        WHERE cell_id LIKE ? AND produced_at >= ?
        GROUP BY cell_id
        ORDER BY max_produced DESC
        LIMIT ?;
        """

        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK else {
            sqlite3_finalize(statement)
            return []
        }
        defer { sqlite3_finalize(statement) }

        sqlite3_bind_text(statement, 1, ("\(trimmedPrefix)%" as NSString).utf8String, -1, SQLITE_TRANSIENT)
        sqlite3_bind_int64(statement, 2, sinceSeconds)
        sqlite3_bind_int(statement, 3, Int32(safeLimit))

        var results: [String] = []
        results.reserveCapacity(safeLimit)

        while sqlite3_step(statement) == SQLITE_ROW {
            let cellId = sqlite3_column_text(statement, 0).flatMap { String(cString: $0) } ?? ""
            if !cellId.isEmpty {
                results.append(cellId)
            }
        }
        return results
    }

    func upsert(
        payload: NearbyPayload,
        spatialKey: NearbySpatialKey,
        etag: String?,
        accuracy: NearbyAccuracy,
        sourceCellId: String?,
        sourceDistanceM: Double?,
        producedAt: Date = Date()
    ) {
        guard let db else { return }

        let encoder = JSONEncoder()
        encoder.outputFormatting = []
        let payloadData = (try? encoder.encode(payload)) ?? Data()
        let payloadJson = String(data: payloadData, encoding: .utf8) ?? "{}"

        let producedSeconds = Int64(producedAt.timeIntervalSince1970)
        let nowSeconds = Int64(Date().timeIntervalSince1970)

        let sql = """
        INSERT INTO nearby_cache (
          cell_id, radius_bucket, time_bucket, etag, payload_json,
          produced_at, last_shown_at, accuracy, source_cell_id, source_distance_m,
          query_lat, query_lng
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(cell_id, radius_bucket, time_bucket) DO UPDATE SET
          etag=excluded.etag,
          payload_json=excluded.payload_json,
          produced_at=excluded.produced_at,
          last_shown_at=excluded.last_shown_at,
          accuracy=excluded.accuracy,
          source_cell_id=excluded.source_cell_id,
          source_distance_m=excluded.source_distance_m,
          query_lat=excluded.query_lat,
          query_lng=excluded.query_lng;
        """

        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK else {
            sqlite3_finalize(statement)
            return
        }
        defer { sqlite3_finalize(statement) }

        sqlite3_bind_text(statement, 1, (spatialKey.cellId as NSString).utf8String, -1, SQLITE_TRANSIENT)
        sqlite3_bind_int(statement, 2, Int32(spatialKey.radiusBucketM))
        sqlite3_bind_text(statement, 3, (spatialKey.timeBucket as NSString).utf8String, -1, SQLITE_TRANSIENT)
        if let etag {
            sqlite3_bind_text(statement, 4, (etag as NSString).utf8String, -1, SQLITE_TRANSIENT)
        } else {
            sqlite3_bind_null(statement, 4)
        }
        sqlite3_bind_text(statement, 5, (payloadJson as NSString).utf8String, -1, SQLITE_TRANSIENT)
        sqlite3_bind_int64(statement, 6, producedSeconds)
        sqlite3_bind_int64(statement, 7, nowSeconds)
        sqlite3_bind_text(statement, 8, (accuracy.rawValue as NSString).utf8String, -1, SQLITE_TRANSIENT)
        if let sourceCellId {
            sqlite3_bind_text(statement, 9, (sourceCellId as NSString).utf8String, -1, SQLITE_TRANSIENT)
        } else {
            sqlite3_bind_null(statement, 9)
        }
        if let sourceDistanceM {
            sqlite3_bind_double(statement, 10, sourceDistanceM)
        } else {
            sqlite3_bind_null(statement, 10)
        }
        sqlite3_bind_double(statement, 11, payload.query.lat)
        sqlite3_bind_double(statement, 12, payload.query.lng)

        sqlite3_step(statement)
        trimIfNeeded(db: db)
    }

    // MARK: - Internals

    private static func openDatabase() -> OpaquePointer? {
        let fm = FileManager.default
        let support = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
        let dir = (support ?? fm.temporaryDirectory).appendingPathComponent("AIMap", isDirectory: true)
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent("nearby_cache.sqlite3")

        var db: OpaquePointer?
        if sqlite3_open(url.path, &db) != SQLITE_OK {
            sqlite3_close(db)
            return nil
        }
        sqlite3_exec(db, "PRAGMA journal_mode=WAL;", nil, nil, nil)
        sqlite3_exec(db, "PRAGMA synchronous=NORMAL;", nil, nil, nil)
        return db
    }

    private static func createSchema(db: OpaquePointer?) {
        guard let db else { return }
        let sql = """
        CREATE TABLE IF NOT EXISTS nearby_cache (
          cell_id TEXT NOT NULL,
          radius_bucket INTEGER NOT NULL,
          time_bucket TEXT NOT NULL,
          etag TEXT,
          payload_json TEXT NOT NULL,
          produced_at INTEGER NOT NULL,
          last_shown_at INTEGER NOT NULL,
          accuracy TEXT NOT NULL,
          source_cell_id TEXT,
          source_distance_m REAL,
          query_lat REAL NOT NULL,
          query_lng REAL NOT NULL,
          PRIMARY KEY (cell_id, radius_bucket, time_bucket)
        );
        CREATE INDEX IF NOT EXISTS idx_nearby_cache_last_shown ON nearby_cache(last_shown_at);
        CREATE INDEX IF NOT EXISTS idx_nearby_cache_radius_time ON nearby_cache(radius_bucket, time_bucket);
        CREATE INDEX IF NOT EXISTS idx_nearby_cache_cell ON nearby_cache(cell_id);
        """
        sqlite3_exec(db, sql, nil, nil, nil)
    }

    private func fetchEntry(cellId: String, key: NearbySpatialKey, db: OpaquePointer) -> CachedResult? {
        let sql = """
        SELECT etag, payload_json, produced_at
        FROM nearby_cache
        WHERE cell_id = ? AND radius_bucket = ? AND time_bucket = ?
        LIMIT 1;
        """
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK else {
            sqlite3_finalize(statement)
            return nil
        }
        defer { sqlite3_finalize(statement) }

        sqlite3_bind_text(statement, 1, (cellId as NSString).utf8String, -1, SQLITE_TRANSIENT)
        sqlite3_bind_int(statement, 2, Int32(key.radiusBucketM))
        sqlite3_bind_text(statement, 3, (key.timeBucket as NSString).utf8String, -1, SQLITE_TRANSIENT)

        guard sqlite3_step(statement) == SQLITE_ROW else { return nil }

        let etag = sqlite3_column_text(statement, 0).flatMap { String(cString: $0) }
        let payloadJson = sqlite3_column_text(statement, 1).flatMap { String(cString: $0) } ?? "{}"
        let producedSeconds = sqlite3_column_int64(statement, 2)

        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let payloadData = payloadJson.data(using: .utf8) ?? Data()
        guard let payload = try? decoder.decode(NearbyPayload.self, from: payloadData) else { return nil }

        let producedAt = Date(timeIntervalSince1970: TimeInterval(producedSeconds))

        let foundKey = NearbySpatialKey(cellId: cellId, radiusBucketM: key.radiusBucketM, timeBucket: key.timeBucket, categories: key.categories)
        let accuracy: NearbyAccuracy = cellId == key.cellId ? .exact : .approx
        return CachedResult(
            spatialKey: foundKey,
            etag: etag,
            payload: payload,
            accuracy: accuracy,
            sourceCellId: accuracy == .approx ? cellId : nil,
            sourceDistanceM: nil,
            producedAt: producedAt
        )
    }

    private func fetchByPrefix(prefix: String, key: NearbySpatialKey, limit: Int, db: OpaquePointer) -> [CachedResult] {
        let sql = """
        SELECT cell_id, etag, payload_json, produced_at
        FROM nearby_cache
        WHERE cell_id LIKE ? AND radius_bucket = ? AND time_bucket = ?
        ORDER BY last_shown_at DESC
        LIMIT ?;
        """

        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK else {
            sqlite3_finalize(statement)
            return []
        }
        defer { sqlite3_finalize(statement) }

        sqlite3_bind_text(statement, 1, ("\(prefix)%" as NSString).utf8String, -1, SQLITE_TRANSIENT)
        sqlite3_bind_int(statement, 2, Int32(key.radiusBucketM))
        sqlite3_bind_text(statement, 3, (key.timeBucket as NSString).utf8String, -1, SQLITE_TRANSIENT)
        sqlite3_bind_int(statement, 4, Int32(limit))

        var results: [CachedResult] = []
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase

        while sqlite3_step(statement) == SQLITE_ROW {
            let cellId = sqlite3_column_text(statement, 0).flatMap { String(cString: $0) } ?? ""
            let etag = sqlite3_column_text(statement, 1).flatMap { String(cString: $0) }
            let payloadJson = sqlite3_column_text(statement, 2).flatMap { String(cString: $0) } ?? "{}"
            let producedSeconds = sqlite3_column_int64(statement, 3)

            let payloadData = payloadJson.data(using: .utf8) ?? Data()
            guard let payload = try? decoder.decode(NearbyPayload.self, from: payloadData) else { continue }

            let producedAt = Date(timeIntervalSince1970: TimeInterval(producedSeconds))
            let foundKey = NearbySpatialKey(cellId: cellId, radiusBucketM: key.radiusBucketM, timeBucket: key.timeBucket, categories: key.categories)
            results.append(
                CachedResult(
                    spatialKey: foundKey,
                    etag: etag,
                    payload: payload,
                    accuracy: .approx,
                    sourceCellId: cellId,
                    sourceDistanceM: nil,
                    producedAt: producedAt
                )
            )
        }

        return results
    }

    private func bestByDistance(entries: [CachedResult], to coordinate: CLLocationCoordinate2D) -> CachedResult? {
        guard !entries.isEmpty else { return nil }
        let query = CLLocation(latitude: coordinate.latitude, longitude: coordinate.longitude)

        var best: CachedResult?
        var bestDistance = CLLocationDistance.greatestFiniteMagnitude

        for entry in entries {
            let target = CLLocation(latitude: entry.payload.query.lat, longitude: entry.payload.query.lng)
            let distance = query.distance(from: target)
            if distance < bestDistance {
                bestDistance = distance
                best = CachedResult(
                    spatialKey: entry.spatialKey,
                    etag: entry.etag,
                    payload: entry.payload,
                    accuracy: .approx,
                    sourceCellId: entry.spatialKey.cellId,
                    sourceDistanceM: distance,
                    producedAt: entry.producedAt
                )
            }
        }
        return best
    }

    private func touch(cellId: String, key: NearbySpatialKey, nowSeconds: Int64, db: OpaquePointer) {
        let sql = """
        UPDATE nearby_cache
        SET last_shown_at = ?
        WHERE cell_id = ? AND radius_bucket = ? AND time_bucket = ?;
        """
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK else {
            sqlite3_finalize(statement)
            return
        }
        defer { sqlite3_finalize(statement) }

        sqlite3_bind_int64(statement, 1, nowSeconds)
        sqlite3_bind_text(statement, 2, (cellId as NSString).utf8String, -1, SQLITE_TRANSIENT)
        sqlite3_bind_int(statement, 3, Int32(key.radiusBucketM))
        sqlite3_bind_text(statement, 4, (key.timeBucket as NSString).utf8String, -1, SQLITE_TRANSIENT)
        sqlite3_step(statement)
    }

    private func trimIfNeeded(db: OpaquePointer) {
        let countSql = "SELECT COUNT(*) FROM nearby_cache;"
        var countStatement: OpaquePointer?
        guard sqlite3_prepare_v2(db, countSql, -1, &countStatement, nil) == SQLITE_OK else {
            sqlite3_finalize(countStatement)
            return
        }
        defer { sqlite3_finalize(countStatement) }
        guard sqlite3_step(countStatement) == SQLITE_ROW else { return }
        let count = Int(sqlite3_column_int(countStatement, 0))
        guard count > maxEntries else { return }

        let toDelete = count - maxEntries
        let deleteSql = """
        DELETE FROM nearby_cache
        WHERE rowid IN (
          SELECT rowid FROM nearby_cache
          ORDER BY last_shown_at ASC
          LIMIT \(toDelete)
        );
        """
        sqlite3_exec(db, deleteSql, nil, nil, nil)
    }
}
