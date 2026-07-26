import Foundation

struct MultipartChunk: Equatable, Sendable {
    let partNumber: Int
    let offset: Int64
    let length: Int
}

enum MultipartChunkPlanner {
    static func chunks(fileSize: Int64, partSize: Int) -> [MultipartChunk] {
        guard fileSize > 0, partSize > 0 else { return [] }
        var chunks: [MultipartChunk] = []
        var offset: Int64 = 0
        var partNumber = 1
        while offset < fileSize {
            let remaining = fileSize - offset
            let length = Int(min(Int64(partSize), remaining))
            chunks.append(MultipartChunk(partNumber: partNumber, offset: offset, length: length))
            offset += Int64(length)
            partNumber += 1
        }
        return chunks
    }
}

actor MediaUploader {
    typealias ProgressHandler = @Sendable (Double) -> Void
    private let api: APIClient

    init(api: APIClient) {
        self.api = api
    }

    func upload(
        media: OptimizedMedia,
        assetID: String,
        plan: UploadPlan,
        progress: @escaping ProgressHandler
    ) async throws -> Asset {
        switch plan.mode {
        case .single:
            guard let url = plan.url else { throw AfterimageError.uploadPlanInvalid }
            try Task.checkCancellation()
            try await api.uploadFile(media.url, to: url, contentType: media.contentType)
            progress(1)
        case .multipart:
            guard let partSize = plan.partSize,
                  let template = plan.partUrlTemplate,
                  partSize > 0 else {
                throw AfterimageError.uploadPlanInvalid
            }
            let chunks = MultipartChunkPlanner.chunks(fileSize: media.byteSize, partSize: partSize)
            guard chunks.count == plan.partCount else { throw AfterimageError.uploadPlanInvalid }
            let handle = try FileHandle(forReadingFrom: media.url)
            defer { try? handle.close() }
            for chunk in chunks {
                try Task.checkCancellation()
                try handle.seek(toOffset: UInt64(chunk.offset))
                let data = try Self.readExactly(chunk.length, from: handle)
                guard data.count == chunk.length else { throw AfterimageError.invalidResponse }
                let path = template.replacingOccurrences(of: "{partNumber}", with: String(chunk.partNumber))
                _ = try await api.uploadPart(data, to: path)
                progress(Double(chunk.partNumber) / Double(chunks.count))
            }
        }
        return try await api.completeUpload(assetID: assetID)
    }

    private static func readExactly(_ byteCount: Int, from handle: FileHandle) throws -> Data {
        var result = Data()
        result.reserveCapacity(byteCount)
        while result.count < byteCount {
            guard let next = try handle.read(upToCount: byteCount - result.count), !next.isEmpty else { break }
            result.append(next)
        }
        return result
    }
}
