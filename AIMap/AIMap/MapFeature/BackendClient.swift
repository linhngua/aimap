import Foundation

enum BackendClientError: Error {
    case invalidURL
    case invalidResponse
    case httpError(statusCode: Int, body: String)
}

extension BackendClientError: LocalizedError {
    var errorDescription: String? {
        switch self {
        case .invalidURL:
            return "Backend URL is missing or invalid."
        case .invalidResponse:
            return "Unexpected response from backend."
        case .httpError(let statusCode, let body):
            let trimmed = body.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty {
                return "Backend returned HTTP \(statusCode)."
            }
            let snippet = String(trimmed.prefix(400))
            return "Backend returned HTTP \(statusCode): \(snippet)"
        }
    }
}

actor BackendClient {
    struct Configuration {
        let baseURL: URL
        var timeoutSeconds: TimeInterval = 20
        var retries: Int = 1
    }

    let configuration: Configuration
    private let session: URLSession
    private let shouldLog: Bool

    init(configuration: Configuration, session: URLSession = .shared) {
        self.configuration = configuration
        self.session = session
        shouldLog = ProcessInfo.processInfo.environment["MODE"]?.lowercased() == "test"
    }

    func nearby(request: NearbyRequest, bypassCache: Bool) async throws -> NearbyResponse {
        try await post(
            path: "/v1/map/nearby",
            body: request,
            responseType: NearbyResponse.self,
            bypassCache: bypassCache
        )
    }

    func nearbyCached(request: NearbyCachedRequest, bypassCache: Bool) async throws -> NearbyCachedEnvelope {
        try await post(
            path: "/v1/map/nearby_cached",
            body: request,
            responseType: NearbyCachedEnvelope.self,
            bypassCache: bypassCache
        )
    }

    func nearbyRefresh(request: NearbyRefreshRequest, bypassCache: Bool) async throws -> NearbyRefreshEnvelope {
        try await post(
            path: "/v1/map/nearby_refresh",
            body: request,
            responseType: NearbyRefreshEnvelope.self,
            bypassCache: bypassCache
        )
    }

    func candidatesIngest(request: CandidatesIngestRequest) async throws -> CandidatesIngestResponse {
        try await post(
            path: "/v1/map/candidates_ingest",
            body: request,
            responseType: CandidatesIngestResponse.self,
            bypassCache: false
        )
    }

    func placeDetail(request: PlaceDetailRequest, bypassCache: Bool) async throws -> PlaceDetailResponse {
        try await post(
            path: "/v1/map/place_detail",
            body: request,
            responseType: PlaceDetailResponse.self,
            bypassCache: bypassCache
        )
    }

    func areaFacts(request: AreaFactsRequest, bypassCache: Bool) async throws -> AreaFactsResponse {
        try await post(
            path: "/v1/map/area_facts",
            body: request,
            responseType: AreaFactsResponse.self,
            bypassCache: bypassCache
        )
    }

    func overlay(request: MapOverlayRequest) async throws -> MapOverlayResponse {
        try await post(
            path: "/v1/map/overlay",
            body: request,
            responseType: MapOverlayResponse.self,
            bypassCache: false
        )
    }

    func coverageReport(request: CoverageReportRequest) async throws -> CoverageReportResponse {
        try await post(
            path: "/v1/map/coverage/report",
            body: request,
            responseType: CoverageReportResponse.self,
            bypassCache: true
        )
    }

    private func post<Request: Encodable, Response: Decodable>(
        path: String,
        body: Request,
        responseType: Response.Type,
        bypassCache: Bool
    ) async throws -> Response {
        guard let url = URL(string: path, relativeTo: configuration.baseURL)?.absoluteURL else {
            throw BackendClientError.invalidURL
        }
        var urlRequest = URLRequest(url: url)
        urlRequest.httpMethod = "POST"
        urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        urlRequest.setValue("application/json", forHTTPHeaderField: "Accept")
        if bypassCache {
            urlRequest.setValue("1", forHTTPHeaderField: "x-bypass-cache")
        }
        urlRequest.timeoutInterval = configuration.timeoutSeconds
        let encoder = JSONEncoder()
        encoder.keyEncodingStrategy = .convertToSnakeCase
        let requestBody = try encoder.encode(body)
        urlRequest.httpBody = requestBody

        var lastError: Error?
        for attempt in 0...configuration.retries {
            do {
                if shouldLog {
                    let attemptLabel = "\(attempt + 1)/\(configuration.retries + 1)"
                    log("→ \(url.absoluteString) [attempt \(attemptLabel)] bypassCache=\(bypassCache) bytes=\(requestBody.count)")
                    if let bodyString = String(data: requestBody, encoding: .utf8) {
                        log("request: \(truncate(bodyString))")
                    }
                }

                let start = Date()
                let (data, response) = try await session.data(for: urlRequest)
                let elapsedMs = Int(Date().timeIntervalSince(start) * 1000)
                guard let http = response as? HTTPURLResponse else {
                    throw BackendClientError.invalidResponse
                }
                guard (200..<300).contains(http.statusCode) else {
                    let bodyString = String(data: data, encoding: .utf8) ?? ""
                    if shouldLog {
                        log("← status=\(http.statusCode) in \(elapsedMs)ms body=\(truncate(bodyString))")
                    }
                    throw BackendClientError.httpError(statusCode: http.statusCode, body: bodyString)
                }

                if shouldLog {
                    if let bodyString = String(data: data, encoding: .utf8) {
                        log("← status=\(http.statusCode) in \(elapsedMs)ms response=\(truncate(bodyString))")
                    } else {
                        log("← status=\(http.statusCode) in \(elapsedMs)ms response=<\(data.count) bytes>")
                    }
                }

                let decoder = JSONDecoder()
                decoder.keyDecodingStrategy = .convertFromSnakeCase
                return try decoder.decode(Response.self, from: data)
            } catch {
                lastError = error
                if shouldLog {
                    let attemptLabel = "\(attempt + 1)/\(configuration.retries + 1)"
                    log("✕ attempt \(attemptLabel) error: \(String(describing: error))")
                }
                if attempt >= configuration.retries { break }
            }
        }
        throw lastError ?? BackendClientError.invalidResponse
    }

    private func log(_ message: String) {
        print("[BackendClient] \(message)")
    }

    private func truncate(_ string: String, maxCharacters: Int = 4000) -> String {
        guard string.count > maxCharacters else { return string }
        return String(string.prefix(maxCharacters)) + "…"
    }
}
