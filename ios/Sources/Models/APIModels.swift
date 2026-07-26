import Foundation

enum MediaKind: String, Codable, Hashable, Sendable {
    case image = "photo"
    case video
}

enum AssetStatus: String, Codable, Hashable, Sendable {
    case uploading
    case ready
    case failed
}

struct UserProfile: Codable, Equatable, Sendable {
    let id: String
    let appleSubject: String
    let email: String?
    let displayName: String?
}

struct AuthResponse: Codable, Equatable, Sendable {
    let token: String
    let expiresAt: Date
    let user: UserProfile
}

struct Asset: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let mediaType: MediaKind
    let status: AssetStatus
    let filename: String
    let contentType: String
    let byteSize: Int64
    let width: Int?
    let height: Int?
    let durationMs: Int?
    let capturedAt: Date
    let createdAt: Date
    let updatedAt: Date
    let thumbnailUrl: String?
    let contentUrl: String?

    private enum CodingKeys: String, CodingKey {
        case id, status, filename, contentType, byteSize, width, height, durationMs
        case capturedAt, createdAt, updatedAt, thumbnailUrl, contentUrl
        case mediaType = "kind"
    }
}

struct TimelinePage: Codable, Equatable, Sendable {
    let assets: [Asset]
    let nextCursor: String?

    private enum CodingKeys: String, CodingKey {
        case assets = "items"
        case nextCursor
    }
}

struct CreateAssetRequest: Encodable, Sendable {
    let mediaType: MediaKind
    let filename: String
    let contentType: String
    let byteSize: Int64
    let width: Int?
    let height: Int?
    let durationMs: Int?
    let capturedAt: Date

    private enum CodingKeys: String, CodingKey {
        case mediaType = "kind"
        case filename, contentType, byteSize, width, height, durationMs, capturedAt
    }
}

struct CreateAssetResponse: Decodable, Sendable {
    let asset: Asset
    let upload: UploadPlan
}

enum UploadMode: String, Decodable, Sendable {
    case single
    case multipart
}

struct UploadPlan: Decodable, Equatable, Sendable {
    let mode: UploadMode
    let url: String?
    let method: String?
    let headers: [String: String]
    let maxBytes: Int64?
    let uploadId: String?
    let partSize: Int?
    let partCount: Int?
    let partUrlTemplate: String?

    private enum CodingKeys: String, CodingKey {
        case mode, url, method, headers, maxBytes, uploadId, partSize, partCount, partUrlTemplate
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        mode = try container.decode(UploadMode.self, forKey: .mode)
        url = try container.decodeIfPresent(String.self, forKey: .url)
        method = try container.decodeIfPresent(String.self, forKey: .method)
        headers = try container.decodeIfPresent([String: String].self, forKey: .headers) ?? [:]
        maxBytes = try container.decodeIfPresent(Int64.self, forKey: .maxBytes)
        uploadId = try container.decodeIfPresent(String.self, forKey: .uploadId)
        partSize = try container.decodeIfPresent(Int.self, forKey: .partSize)
        partCount = try container.decodeIfPresent(Int.self, forKey: .partCount)
        partUrlTemplate = try container.decodeIfPresent(String.self, forKey: .partUrlTemplate)

        switch mode {
        case .single:
            guard url != nil else {
                throw DecodingError.dataCorruptedError(forKey: .url, in: container, debugDescription: "single upload requires url")
            }
        case .multipart:
            guard uploadId != nil, partSize != nil, partCount != nil, partUrlTemplate != nil else {
                throw DecodingError.dataCorruptedError(forKey: .partUrlTemplate, in: container, debugDescription: "multipart upload plan is incomplete")
            }
        }
    }
}

struct UploadPart: Codable, Equatable, Sendable {
    let partNumber: Int
    let etag: String
}

struct CompleteUploadRequest: Encodable, Sendable {
    let parts: [UploadPart]?
}

struct PlaybackGrant: Decodable, Sendable {
    let url: String
    let expiresAt: Date
}

struct APIErrorEnvelope: Decodable, Sendable {
    struct Detail: Decodable, Sendable {
        let code: String
        let message: String
    }
    let error: Detail
}

enum AfterimageError: LocalizedError, Sendable {
    case invalidConfiguration
    case invalidResponse
    case api(status: Int, code: String, message: String)
    case missingCredential
    case unsupportedMedia
    case compressionFailed(String)
    case uploadPlanInvalid
    case cancelled

    var errorDescription: String? {
        switch self {
        case .invalidConfiguration: "接続先の設定を確認できませんでした。"
        case .invalidResponse: "サーバーから正しい応答を受け取れませんでした。"
        case let .api(_, _, message): message
        case .missingCredential: "Appleの認証情報を受け取れませんでした。"
        case .unsupportedMedia: "この写真・動画形式にはまだ対応していません。"
        case let .compressionFailed(reason): "軽量化できませんでした。元データは送信していません。\n\(reason)"
        case .uploadPlanInvalid: "アップロードの準備に失敗しました。"
        case .cancelled: "アップロードをキャンセルしました。"
        }
    }
}

extension JSONDecoder {
    static var afterimage: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let value = try container.decode(String.self)
            let fractional = ISO8601DateFormatter()
            fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let date = fractional.date(from: value) { return date }
            let standard = ISO8601DateFormatter()
            standard.formatOptions = [.withInternetDateTime]
            if let date = standard.date(from: value) { return date }
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Invalid RFC3339 date")
        }
        return decoder
    }
}

extension JSONEncoder {
    static var afterimage: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }
}
