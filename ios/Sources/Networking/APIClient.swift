import Foundation

struct APIPathResolver: Sendable {
    let baseURL: URL

    static func resolve(_ path: String, against baseURL: URL) throws -> URL {
        try APIPathResolver(baseURL: baseURL).resolve(path)
    }

    func resolve(_ path: String) throws -> URL {
        if let absolute = URL(string: path), absolute.scheme != nil {
            let scheme = absolute.scheme?.lowercased()
            let permitsHTTP = baseURL.scheme?.lowercased() == "http" && scheme == "http"
            guard scheme == "https" || permitsHTTP,
                  absolute.user == nil,
                  absolute.password == nil else {
                throw AfterimageError.invalidConfiguration
            }
            return absolute
        }
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            throw AfterimageError.invalidConfiguration
        }
        let raw = path.hasPrefix("/") ? path : "/\(path)"
        guard let relative = URLComponents(string: raw) else {
            throw AfterimageError.invalidConfiguration
        }
        components.path = relative.path
        components.queryItems = relative.queryItems
        guard let url = components.url else { throw AfterimageError.invalidConfiguration }
        return url
    }

    func isAPIOrigin(_ url: URL) -> Bool {
        url.scheme?.lowercased() == baseURL.scheme?.lowercased()
            && url.host?.lowercased() == baseURL.host?.lowercased()
            && effectivePort(of: url) == effectivePort(of: baseURL)
    }

    private func effectivePort(of url: URL) -> Int? {
        if let port = url.port { return port }
        return switch url.scheme?.lowercased() {
        case "https": 443
        case "http": 80
        default: nil
        }
    }
}

actor APIClient {
    private let resolver: APIPathResolver
    private let session: URLSession
    private var bearerToken: String?
    private let decoder = JSONDecoder.afterimage
    private let encoder = JSONEncoder.afterimage

    init(baseURL: URL, session: URLSession = .shared) {
        resolver = APIPathResolver(baseURL: baseURL)
        self.session = session
    }

    func setBearerToken(_ token: String?) {
        bearerToken = token
    }

    func revokeSession() async throws {
        let request: URLRequest
        do {
            request = try makeRequest(path: "/v1/auth/session", method: "DELETE")
        } catch {
            bearerToken = nil
            throw error
        }
        bearerToken = nil
        let (data, response) = try await session.data(for: request)
        try validate(response: response, data: data)
    }

    func signIn(identityToken: String, displayName: String?) async throws -> AuthResponse {
        struct Body: Encodable { let identityToken: String; let displayName: String? }
        let body = try encoder.encode(Body(identityToken: identityToken, displayName: displayName))
        let request = try makeRequest(path: "/v1/auth/apple", method: "POST", body: body, contentType: "application/json", authenticated: false)
        return try await decode(request)
    }

    func timeline(cursor: String? = nil, limit: Int = 40) async throws -> TimelinePage {
        var components = URLComponents()
        components.path = "/v1/assets"
        var items = [URLQueryItem(name: "limit", value: String(limit))]
        if let cursor { items.append(URLQueryItem(name: "cursor", value: cursor)) }
        components.queryItems = items
        let request = try makeRequest(path: components.string ?? "/v1/assets", method: "GET")
        return try await decode(request)
    }

    func createAsset(_ payload: CreateAssetRequest) async throws -> CreateAssetResponse {
        let request = try makeRequest(
            path: "/v1/assets",
            method: "POST",
            body: try encoder.encode(payload),
            contentType: "application/json"
        )
        return try await decode(request)
    }

    func uploadFile(_ fileURL: URL, to path: String, contentType: String) async throws {
        let request = try makeRequest(path: path, method: "PUT", contentType: contentType)
        let (_, response) = try await session.upload(for: request, fromFile: fileURL)
        try validate(response: response, data: nil)
    }

    func uploadPart(_ data: Data, to path: String) async throws -> UploadPart {
        struct PartResponse: Decodable { let part: UploadPart }
        let request = try makeRequest(path: path, method: "PUT", body: data, contentType: "application/octet-stream")
        let response: PartResponse = try await decode(request)
        return response.part
    }

    func completeUpload(assetID: String) async throws -> Asset {
        struct Response: Decodable { let asset: Asset }
        let request = try makeRequest(
            path: "/v1/assets/\(assetID)/upload/complete",
            method: "POST",
            body: try encoder.encode(CompleteUploadRequest(parts: nil)),
            contentType: "application/json"
        )
        let response: Response = try await decode(request)
        return response.asset
    }

    func uploadThumbnail(_ fileURL: URL, assetID: String) async throws {
        let request = try makeRequest(path: "/v1/assets/\(assetID)/thumbnail", method: "PUT", contentType: "image/jpeg")
        let (_, response) = try await session.upload(for: request, fromFile: fileURL)
        try validate(response: response, data: nil)
    }

    func thumbnailData(assetID: String) async throws -> Data {
        let request = try makeRequest(path: "/v1/assets/\(assetID)/thumbnail", method: "GET")
        return try await rawData(request)
    }

    func contentData(assetID: String) async throws -> Data {
        let request = try makeRequest(path: "/v1/assets/\(assetID)/content", method: "GET")
        return try await rawData(request)
    }

    func playbackURL(assetID: String) async throws -> URL {
        let request = try makeRequest(path: "/v1/assets/\(assetID)/playback", method: "POST")
        let grant: PlaybackGrant = try await decode(request)
        return try resolver.resolve(grant.url)
    }

    func deleteAsset(assetID: String) async throws {
        let request = try makeRequest(path: "/v1/assets/\(assetID)", method: "DELETE")
        let (data, response) = try await session.data(for: request)
        try validate(response: response, data: data)
    }

    private func rawData(_ request: URLRequest) async throws -> Data {
        let (data, response) = try await session.data(for: request)
        try validate(response: response, data: data)
        return data
    }

    private func decode<T: Decodable>(_ request: URLRequest) async throws -> T {
        let (data, response) = try await session.data(for: request)
        try validate(response: response, data: data)
        do { return try decoder.decode(T.self, from: data) }
        catch { throw AfterimageError.invalidResponse }
    }

    private func makeRequest(
        path: String,
        method: String,
        body: Data? = nil,
        contentType: String? = nil,
        authenticated: Bool = true
    ) throws -> URLRequest {
        let url = try resolver.resolve(path)
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.httpBody = body
        request.timeoutInterval = 120
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let contentType { request.setValue(contentType, forHTTPHeaderField: "Content-Type") }
        if authenticated, resolver.isAPIOrigin(url), let bearerToken {
            request.setValue("Bearer \(bearerToken)", forHTTPHeaderField: "Authorization")
        }
        return request
    }

    private func validate(response: URLResponse, data: Data?) throws {
        guard let http = response as? HTTPURLResponse else { throw AfterimageError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            if let data, let envelope = try? decoder.decode(APIErrorEnvelope.self, from: data) {
                throw AfterimageError.api(status: http.statusCode, code: envelope.error.code, message: envelope.error.message)
            }
            throw AfterimageError.api(status: http.statusCode, code: "http_error", message: "通信に失敗しました（\(http.statusCode)）。")
        }
    }
}
