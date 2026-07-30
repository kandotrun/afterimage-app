import Foundation

enum LegalPage: Hashable, Sendable {
    case privacy
    case support
    case terms

    var path: String {
        switch self {
        case .privacy: "/privacy"
        case .support: "/support"
        case .terms: "/terms"
        }
    }
}

struct AccountDeletionReauthorization: Encodable, Equatable, Sendable {
    let authorizationCode: String
    let identityToken: String
    let challengeId: String
}

enum LegalURLPolicy {
    static func resolve(_ page: LegalPage, against baseURL: URL) throws -> URL {
        guard baseURL.scheme?.lowercased() == "https",
              baseURL.host != nil,
              baseURL.user == nil,
              baseURL.password == nil else {
            throw AfterimageError.invalidConfiguration
        }
        var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)
        components?.path = page.path
        components?.query = nil
        components?.fragment = nil
        guard let url = components?.url else {
            throw AfterimageError.invalidConfiguration
        }
        return url
    }
}

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

private struct BoundAPIRequest {
    var urlRequest: URLRequest
    let authContext: AuthSessionContext?
}

actor APIClient {
    private let resolver: APIPathResolver
    private let session: URLSession
    private let authGeneration: AuthGenerationGate
    private var storedSession: StoredSession?
    private let decoder = JSONDecoder.afterimage
    private let encoder = JSONEncoder.afterimage

    init(
        baseURL: URL,
        session: URLSession = .shared,
        authGeneration: AuthGenerationGate = .shared
    ) {
        resolver = APIPathResolver(baseURL: baseURL)
        self.session = session
        self.authGeneration = authGeneration
    }

    func setSession(_ session: StoredSession?) {
        storedSession = session
    }

    @discardableResult
    func clearSession(ifCurrent context: AuthSessionContext) -> Bool {
        guard storedSession?.context == context else { return false }
        storedSession = nil
        return true
    }

    func backgroundUploadContext() throws -> BackgroundUploadContext {
        guard let storedSession,
              let ownerID = storedSession.context.accountID else {
            throw AfterimageError.missingCredential
        }
        return BackgroundUploadContext(
            baseURL: resolver.baseURL,
            session: storedSession,
            ownerID: ownerID
        )
    }

    func legalURL(_ page: LegalPage) throws -> URL {
        try LegalURLPolicy.resolve(page, against: resolver.baseURL)
    }

    func revokeSession() async throws {
        let request = try makeRequest(path: "/v1/auth/session", method: "DELETE")
        let (data, response) = try await session.data(for: request.urlRequest)
        try await validate(
            response: response,
            data: data,
            authContext: request.authContext
        )
    }

    func appleAuthChallenge() async throws -> AppleAuthChallenge {
        let request = try makeRequest(
            path: "/v1/auth/apple/challenge",
            method: "GET",
            authenticated: false
        )
        return try await decode(request)
    }

    func signIn(
        identityToken: String,
        challengeID: String,
        displayName: String?
    ) async throws -> AuthResponse {
        struct Body: Encodable {
            let identityToken: String
            let challengeId: String
            let displayName: String?
        }
        let body = try encoder.encode(Body(
            identityToken: identityToken,
            challengeId: challengeID,
            displayName: displayName
        ))
        let request = try makeRequest(path: "/v1/auth/apple", method: "POST", body: body, contentType: "application/json", authenticated: false)
        return try await decode(request)
    }

    func aiConsent() async throws -> AIConsent {
        let request = try makeRequest(path: "/v1/privacy/ai", method: "GET")
        let response: AIConsentResponse = try await decode(request)
        return response.consent
    }

    func updateAIConsent(granted: Bool) async throws -> AIConsent {
        let request = try makeRequest(
            path: "/v1/privacy/ai",
            method: "PUT",
            body: try encoder.encode(UpdateAIConsentRequest(
                version: AIConsentPolicy.currentVersion,
                consented: granted
            )),
            contentType: "application/json"
        )
        let response: AIConsentResponse = try await decode(request)
        return response.consent
    }

    func deleteAccount(
        reauthorization: AccountDeletionReauthorization? = nil
    ) async throws {
        let body = try reauthorization.map(encoder.encode)
        let request = try makeRequest(
            path: "/v1/account",
            method: "DELETE",
            body: body,
            contentType: body == nil ? nil : "application/json"
        )
        let (data, response) = try await session.data(for: request.urlRequest)
        try await validate(
            response: response,
            data: data,
            authContext: request.authContext
        )
    }

    func currentUser() async throws -> UserProfile {
        struct Response: Decodable { let user: UserProfile }
        let request = try makeRequest(path: "/v1/me", method: "GET")
        let response: Response = try await decode(request)
        return response.user
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

    func searchMemories(query: String, cursor: String? = nil, limit: Int = 20) async throws -> MemorySearchPage {
        var components = URLComponents()
        components.path = "/v1/memories/search"
        var items = [
            URLQueryItem(name: "q", value: query),
            URLQueryItem(name: "limit", value: String(limit)),
        ]
        if let cursor { items.append(URLQueryItem(name: "cursor", value: cursor)) }
        components.queryItems = items
        let request = try makeRequest(path: components.string ?? "/v1/memories/search", method: "GET")
        return try await decode(request)
    }

    func videoAnalysis(assetID: String) async throws -> VideoAnalysisResponse {
        let request = try makeRequest(path: "/v1/assets/\(assetID)/analysis", method: "GET")
        return try await decode(request)
    }

    func dailyWeather(in range: ClosedRange<String>) async throws -> [DailyWeather] {
        var components = URLComponents()
        components.path = "/v1/weather/days"
        components.queryItems = [
            URLQueryItem(name: "from", value: range.lowerBound),
            URLQueryItem(name: "to", value: range.upperBound),
        ]
        let request = try makeRequest(path: components.string ?? "/v1/weather/days", method: "GET")
        let page: DailyWeatherPage = try await decode(request)
        return page.items
    }

    func saveDailyWeather(_ weather: DailyWeatherDraft) async throws -> DailyWeather {
        let request = try makeRequest(
            path: "/v1/weather/days/\(weather.localDate)",
            method: "PUT",
            body: encoder.encode(weather),
            contentType: "application/json"
        )
        let response: DailyWeatherResponse = try await decode(request)
        return response.item
    }

    func dailyPlayback(startAt: Date, endAt: Date) async throws -> DailyPlaybackResponse {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var components = URLComponents()
        components.path = "/v1/days/playback"
        components.queryItems = [
            URLQueryItem(name: "startAt", value: formatter.string(from: startAt)),
            URLQueryItem(name: "endAt", value: formatter.string(from: endAt)),
        ]
        let request = try makeRequest(path: components.string ?? "/v1/days/playback", method: "GET")
        return try await decode(request)
    }

    func dailySummary(startAt: Date, endAt: Date) async throws -> DailySummaryResponse {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var components = URLComponents()
        components.path = "/v1/days/summary"
        components.queryItems = [
            URLQueryItem(name: "startAt", value: formatter.string(from: startAt)),
            URLQueryItem(name: "endAt", value: formatter.string(from: endAt)),
        ]
        let request = try makeRequest(path: components.string ?? "/v1/days/summary", method: "GET")
        return try await decode(request)
    }

    func existingSourceFingerprints(
        for candidates: [ExistingAssetCandidate]
    ) async throws -> Set<String> {
        guard !candidates.isEmpty else { return [] }
        let request = try makeRequest(
            path: "/v1/assets/existing",
            method: "POST",
            body: try encoder.encode(ExistingAssetsRequest(items: candidates)),
            contentType: "application/json"
        )
        let response: ExistingAssetsResponse = try await decode(request)
        return Set(response.existingSourceFingerprints)
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
        var request = try makeRequest(path: path, method: "PUT", contentType: contentType)
        request.urlRequest.setValue(
            String(try contentLength(of: fileURL)),
            forHTTPHeaderField: "Content-Length"
        )
        let (_, response) = try await session.upload(
            for: request.urlRequest,
            fromFile: fileURL
        )
        try await validate(
            response: response,
            data: nil,
            authContext: request.authContext
        )
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
        var request = try makeRequest(path: "/v1/assets/\(assetID)/thumbnail", method: "PUT", contentType: "image/jpeg")
        request.urlRequest.setValue(
            String(try contentLength(of: fileURL)),
            forHTTPHeaderField: "Content-Length"
        )
        let (_, response) = try await session.upload(
            for: request.urlRequest,
            fromFile: fileURL
        )
        try await validate(
            response: response,
            data: nil,
            authContext: request.authContext
        )
    }

    func thumbnailData(assetID: String) async throws -> Data {
        let request = try makeRequest(path: "/v1/assets/\(assetID)/thumbnail", method: "GET")
        return try await rawData(request)
    }

    func contentData(assetID: String) async throws -> Data {
        let request = try makeRequest(path: "/v1/assets/\(assetID)/content", method: "GET")
        return try await rawData(request)
    }

    func playbackGrant(assetID: String) async throws -> ResolvedPlaybackGrant {
        let request = try makeRequest(path: "/v1/assets/\(assetID)/playback", method: "POST")
        let grant: PlaybackGrant = try await decode(request)
        return ResolvedPlaybackGrant(url: try resolver.resolve(grant.url), expiresAt: grant.expiresAt)
    }

    func transcript(assetID: String) async throws -> TranscriptResponse {
        let request = try makeRequest(path: "/v1/assets/\(assetID)/transcript", method: "GET")
        return try await decode(request)
    }

    func transcript(assetID: String) async throws -> AssetTranscript {
        let request = try makeRequest(path: "/v1/assets/\(assetID)/transcript", method: "GET")
        return try await decode(request)
    }

    func mcpEndpoint() throws -> URL {
        try resolver.resolve("/mcp")
    }

    func mcpTokens() async throws -> [MCPToken] {
        let request = try makeRequest(path: "/v1/mcp/tokens", method: "GET")
        let response: MCPTokenListResponse = try await decode(request)
        return response.items
    }

    func createMCPToken(name: String) async throws -> MCPTokenCreationResponse {
        struct Body: Encodable { let name: String }
        let request = try makeRequest(
            path: "/v1/mcp/tokens",
            method: "POST",
            body: try encoder.encode(Body(name: name)),
            contentType: "application/json"
        )
        return try await decode(request)
    }

    func revokeMCPToken(id: String) async throws {
        let request = try makeRequest(path: "/v1/mcp/tokens/\(id)", method: "DELETE")
        let (data, response) = try await session.data(for: request.urlRequest)
        try await validate(
            response: response,
            data: data,
            authContext: request.authContext
        )
    }

    func setAgentAccess(assetID: String, enabled: Bool) async throws -> Asset {
        struct Body: Encodable { let enabled: Bool }
        struct Result: Decodable { let asset: Asset }
        let request = try makeRequest(
            path: "/v1/assets/\(assetID)/agent-access",
            method: "PATCH",
            body: try encoder.encode(Body(enabled: enabled)),
            contentType: "application/json"
        )
        let result: Result = try await decode(request)
        return result.asset
    }

    func deleteAsset(assetID: String) async throws {
        let request = try makeRequest(path: "/v1/assets/\(assetID)", method: "DELETE")
        let (data, response) = try await session.data(for: request.urlRequest)
        try await validate(
            response: response,
            data: data,
            authContext: request.authContext
        )
    }

    private func contentLength(of fileURL: URL) throws -> Int {
        let values = try fileURL.resourceValues(forKeys: [.fileSizeKey])
        guard let fileSize = values.fileSize, fileSize > 0 else {
            throw AfterimageError.invalidConfiguration
        }
        return fileSize
    }

    private func rawData(_ request: BoundAPIRequest) async throws -> Data {
        let (data, response) = try await session.data(for: request.urlRequest)
        try await validate(
            response: response,
            data: data,
            authContext: request.authContext
        )
        return data
    }

    private func decode<T: Decodable>(_ request: BoundAPIRequest) async throws -> T {
        let (data, response) = try await session.data(for: request.urlRequest)
        try await validate(
            response: response,
            data: data,
            authContext: request.authContext
        )
        do { return try decoder.decode(T.self, from: data) }
        catch { throw AfterimageError.invalidResponse }
    }

    private func makeRequest(
        path: String,
        method: String,
        body: Data? = nil,
        contentType: String? = nil,
        authenticated: Bool = true
    ) throws -> BoundAPIRequest {
        let url = try resolver.resolve(path)
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.httpBody = body
        request.timeoutInterval = 120
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let contentType { request.setValue(contentType, forHTTPHeaderField: "Content-Type") }
        let boundSession = authenticated && resolver.isAPIOrigin(url)
            ? storedSession
            : nil
        if let boundSession {
            request.setValue(
                "Bearer \(boundSession.token)",
                forHTTPHeaderField: "Authorization"
            )
        }
        return BoundAPIRequest(
            urlRequest: request,
            authContext: boundSession?.context
        )
    }

    private func validate(
        response: URLResponse,
        data: Data?,
        authContext: AuthSessionContext?
    ) async throws {
        guard let http = response as? HTTPURLResponse else { throw AfterimageError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            let error: AfterimageError
            if let data, let envelope = try? decoder.decode(APIErrorEnvelope.self, from: data) {
                error = AfterimageError.api(
                    status: http.statusCode,
                    code: envelope.error.code,
                    message: envelope.error.message
                )
            } else {
                error = AfterimageError.api(
                    status: http.statusCode,
                    code: .httpError,
                    message: L10n.format("error.http_status", Int64(http.statusCode))
                )
            }
            if error.invalidatesSession, let authContext {
                await authGeneration.invalidate(authContext)
            }
            throw error
        }
    }
}
