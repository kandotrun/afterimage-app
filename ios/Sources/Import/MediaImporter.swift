import CoreTransferable
import CryptoKit
import Foundation
import Photos
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

struct ImportIdentity: Equatable, Sendable {
    let sourceFingerprint: String
    let filename: String

    init(localIdentifier: String, kind: MediaKind) {
        let digest = SHA256.hash(data: Data(localIdentifier.utf8))
        sourceFingerprint = digest.map { String(format: "%02x", $0) }.joined()
        let fileExtension = kind == .video ? "mov" : "heic"
        filename = "\(ImportedMedia.sanitizedBaseFilename(from: "\(localIdentifier).\(fileExtension)")).\(fileExtension)"
    }
}

struct ImportSelectionPlan: Equatable, Sendable {
    let uploadIndexes: [Int]
    let skippedCount: Int
}

enum ImportSelectionPolicy {
    static func candidates(from identities: [ImportIdentity?]) -> [ExistingAssetCandidate] {
        var seen = Set<String>()
        return identities.compactMap { identity in
            guard let identity,
                  seen.insert(identity.sourceFingerprint).inserted else {
                return nil
            }
            return ExistingAssetCandidate(
                sourceFingerprint: identity.sourceFingerprint,
                filename: identity.filename
            )
        }
    }

    static func plan(
        identities: [ImportIdentity?],
        existing: Set<String>
    ) -> ImportSelectionPlan {
        let uploadIndexes = identities.indices.filter { index in
            guard let identity = identities[index] else { return true }
            return !existing.contains(identity.sourceFingerprint)
        }
        return ImportSelectionPlan(
            uploadIndexes: uploadIndexes,
            skippedCount: identities.count - uploadIndexes.count
        )
    }
}

struct ImportedMedia: Sendable {
    let kind: MediaKind
    let url: URL
    let originalFilename: String
    let capturedAt: Date?

    var baseFilename: String {
        Self.sanitizedBaseFilename(from: originalFilename)
    }

    static func sanitizedBaseFilename(from originalFilename: String) -> String {
        let raw = (originalFilename as NSString).deletingPathExtension
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_ "))
        let cleaned = raw.unicodeScalars.map { allowed.contains($0) ? Character($0) : "-" }
        let value = String(cleaned).trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? "afterimage" : String(value.prefix(120))
    }

    func removeTemporaryFile() {
        try? FileManager.default.removeItem(at: url)
    }
}

private struct PickedMovie: Transferable, Sendable {
    let url: URL

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(contentType: .movie) { movie in
            SentTransferredFile(movie.url)
        } importing: { received in
            Self(url: try ImportedFileCopy.copy(received.file))
        }
    }
}

private struct PickedImage: Transferable, Sendable {
    let url: URL

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(contentType: .image) { image in
            SentTransferredFile(image.url)
        } importing: { received in
            Self(url: try ImportedFileCopy.copy(received.file))
        }
    }
}

private enum ImportedFileCopy {
    static func copy(_ source: URL) throws -> URL {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("afterimage-imports", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let fileExtension = source.pathExtension.isEmpty ? "data" : source.pathExtension
        let destination = directory.appendingPathComponent(UUID().uuidString).appendingPathExtension(fileExtension)
        try FileManager.default.copyItem(at: source, to: destination)
        return destination
    }
}

@MainActor
enum MediaImporter {
    static func identity(for item: PhotosPickerItem) -> ImportIdentity? {
        guard let localIdentifier = item.itemIdentifier,
              let kind = mediaKind(for: item) else { return nil }
        return ImportIdentity(localIdentifier: localIdentifier, kind: kind)
    }

    static func load(_ item: PhotosPickerItem) async throws -> ImportedMedia {
        let capturedAt = creationDate(for: item.itemIdentifier)
        let identity = identity(for: item)
        let isMovie = item.supportedContentTypes.contains { $0.conforms(to: .movie) }
        if isMovie {
            guard let movie = try await item.loadTransferable(type: PickedMovie.self) else {
                throw AfterimageError.unsupportedMedia
            }
            return ImportedMedia(
                kind: .video,
                url: movie.url,
                originalFilename: identity?.filename ?? movie.url.lastPathComponent,
                capturedAt: capturedAt
            )
        }

        let isImage = item.supportedContentTypes.contains { $0.conforms(to: .image) }
        guard isImage, let image = try await item.loadTransferable(type: PickedImage.self) else {
            throw AfterimageError.unsupportedMedia
        }
        return ImportedMedia(
            kind: .image,
            url: image.url,
            originalFilename: identity?.filename ?? image.url.lastPathComponent,
            capturedAt: capturedAt
        )
    }

    private static func mediaKind(for item: PhotosPickerItem) -> MediaKind? {
        if item.supportedContentTypes.contains(where: { $0.conforms(to: .movie) }) {
            return .video
        }
        if item.supportedContentTypes.contains(where: { $0.conforms(to: .image) }) {
            return .image
        }
        return nil
    }

    private static func creationDate(for identifier: String?) -> Date? {
        guard let identifier else { return nil }
        return PHAsset.fetchAssets(withLocalIdentifiers: [identifier], options: nil).firstObject?.creationDate
    }
}
