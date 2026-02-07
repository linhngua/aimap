import Foundation

enum BackendClientError: Error {
    case invalidURL
    case invalidResponse
    case httpError(statusCode: Int, body: String)
}

actor BackendClient {
    struct Configuration {
        let baseURL: URL
        var timeoutSeconds: TimeInterval = 12
        var retries: Int = 1
    }

    let configuration: Configuration
    private let session: URLSession

    init(configuration: Configuration, session: URLSession = .shared) {
        self.configuration = configuration
        self.session = session
    }

    func nearby(request: NearbyRequest, bypassCache: Bool) async throws -> NearbyResponse {
        try await post(
            path: "/v1/map/nearby",
            body: request,
            responseType: NearbyResponse.self,
            bypassCache: bypassCache
        )
    }

    func placeDetail(request: PlaceDetailRequest, bypassCache: Bool) async throws -> PlaceDetailResponse {
        try await post(
            path: "/v1/map/place",
            body: request,
            responseType: PlaceDetailResponse.self,
            bypassCache: bypassCache
        )
    }

    private func post<Request: Encodable, Response: Decodable>(
        path: String,
        body: Request,
        responseType: Response.Type,
        bypassCache: Bool
    ) async throws -> Response {
        let url = configuration.baseURL.appendingPathComponent(path)
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
        urlRequest.httpBody = try encoder.encode(body)

        var lastError: Error?
        for attempt in 0...configuration.retries {
            do {
                let (data, response) = try await session.data(for: urlRequest)
                guard let http = response as? HTTPURLResponse else {
                    throw BackendClientError.invalidResponse
                }
                guard (200..<300).contains(http.statusCode) else {
                    let bodyString = String(data: data, encoding: .utf8) ?? ""
                    throw BackendClientError.httpError(statusCode: http.statusCode, body: bodyString)
                }
                let decoder = JSONDecoder()
                decoder.keyDecodingStrategy = .convertFromSnakeCase
                return try decoder.decode(Response.self, from: data)
            } catch {
                lastError = error
                if attempt >= configuration.retries { break }
            }
        }
        throw lastError ?? BackendClientError.invalidResponse
    }
}
