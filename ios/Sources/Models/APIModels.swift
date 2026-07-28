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

enum TranscriptionStatus: String, Codable, Hashable, Sendable {
    case pending
    case processing
    case completed
    case failed
    case skipped
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
    var location: CaptureLocation? = nil
    let createdAt: Date
    let updatedAt: Date
    let thumbnailUrl: String?
    let contentUrl: String?
    let transcriptionStatus: TranscriptionStatus?
    let transcriptPreview: String?
    let transcriptUrl: String?

    private enum CodingKeys: String, CodingKey {
        case id, status, filename, contentType, byteSize, width, height, durationMs
        case capturedAt, location, createdAt, updatedAt, thumbnailUrl, contentUrl
        case transcriptionStatus, transcriptPreview, transcriptUrl
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

struct DailyPlaybackResponse: Codable, Equatable, Sendable {
    let startAt: Date
    let endAt: Date
    let clipCount: Int
    let durationMs: Int
    let clips: [DailyPlaybackClip]
}

struct DailyPlaybackClip: Codable, Identifiable, Hashable, Sendable {
    let asset: Asset
    let startMs: Int
    let endMs: Int
    let transcript: DailyPlaybackTranscript

    var id: String { asset.id }
    var duration: TimeInterval { TimeInterval(max(0, endMs - startMs)) / 1_000 }
}

struct DailyPlaybackTranscript: Codable, Hashable, Sendable {
    let status: TranscriptionStatus?
    let language: String?
    let text: String?
    let updatedAt: Date?
}

struct ExistingAssetCandidate: Codable, Equatable, Sendable {
    let sourceFingerprint: String
    let filename: String
}

struct ExistingAssetsRequest: Encodable, Sendable {
    let items: [ExistingAssetCandidate]
}

struct ExistingAssetsResponse: Decodable, Sendable {
    let existingSourceFingerprints: [String]
}

struct CreateAssetRequest: Encodable, Sendable {
    let mediaType: MediaKind
    let sourceFingerprint: String?
    let filename: String
    let contentType: String
    let byteSize: Int64
    let width: Int?
    let height: Int?
    let durationMs: Int?
    let capturedAt: Date
    var location: CaptureLocation? = nil

    private enum CodingKeys: String, CodingKey {
        case mediaType = "kind"
        case sourceFingerprint, filename, contentType, byteSize, width, height, durationMs, capturedAt, location
    }
}

struct CreateAssetResponse: Decodable, Sendable {
    let asset: Asset
    let upload: UploadPlan
}

enum UploadMode: String, Codable, Sendable {
    case single
    case multipart
}

struct UploadPlan: Codable, Equatable, Sendable {
    let mode: UploadMode
    let url: String?
    let method: String?
    let headers: [String: String]
    let maxBytes: Int64?
    let uploadId: String?
    let partSize: Int?
    let partCount: Int?
    let partUrlTemplate: String?

    func path(forPart partNumber: Int) throws -> String {
        guard mode == .multipart,
              let partCount,
              (1...partCount).contains(partNumber),
              let partUrlTemplate,
              partUrlTemplate.contains("{partNumber}") else {
            throw AfterimageError.uploadPlanInvalid
        }
        return partUrlTemplate.replacingOccurrences(of: "{partNumber}", with: String(partNumber))
    }

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
            guard partSize != nil, partCount != nil, partUrlTemplate != nil else {
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

struct ResolvedPlaybackGrant: Equatable, Sendable {
    let url: URL
    let expiresAt: Date
}

struct TranscriptResponse: Decodable, Equatable, Sendable {
    let assetId: String
    let status: String
    let language: String?
    let text: String
    let updatedAt: Date?
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
    case captureDateUnavailable
    case compressionFailed(String)
    case uploadPlanInvalid
    case cancelled

    var invalidatesSession: Bool {
        guard case let .api(status, _, _) = self else { return false }
        return status == 401
    }

    var isDuplicateAsset: Bool {
        guard case let .api(status, code, _) = self else { return false }
        return status == 409 && code == "duplicate_asset"
    }

    var errorDescription: String? {
        switch self {
        case .invalidConfiguration: L10n.string("error.invalid_configuration")
        case .invalidResponse: L10n.string("error.invalid_response")
        case let .api(status, code, _):
            if code == "http_error" {
                L10n.format("error.http_status", Int64(status))
            } else {
                L10n.apiError(code: code)
            }
        case .missingCredential: L10n.string("error.missing_credential")
        case .unsupportedMedia: L10n.string("error.unsupported_media")
        case .captureDateUnavailable: L10n.string("error.capture_date_unavailable")
        case let .compressionFailed(reason): L10n.format("error.compression_failed", reason as NSString)
        case .uploadPlanInvalid: L10n.string("error.upload_plan_invalid")
        case .cancelled: L10n.string("error.cancelled")
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
