@preconcurrency import AVFoundation
import CoreGraphics
import CoreMedia
import Foundation
import ImageIO
import UniformTypeIdentifiers

enum AudioCompressionStrategy: Equatable, Sendable {
    case passthrough
}

struct VideoCompressionPlan: Equatable, Sendable {
    let width: Int
    let height: Int
    let averageBitRate: Int
    let audioStrategy: AudioCompressionStrategy
    let fileExtension: String
    let contentType: String
}

struct VideoCompressionProfile: Equatable, Sendable {
    let maxPixelDimension: Int
    let maximumBitRate: Int
    let minimumBitRate: Int

    static let afterimage = VideoCompressionProfile(
        maxPixelDimension: 1_920,
        maximumBitRate: 6_000_000,
        minimumBitRate: 800_000
    )

    func plan(sourceWidth: Int, sourceHeight: Int, estimatedDataRate: Double) -> VideoCompressionPlan {
        let sourceLong = max(sourceWidth, sourceHeight)
        let scale = sourceLong > maxPixelDimension ? Double(maxPixelDimension) / Double(sourceLong) : 1
        let width = Self.even(max(2, Int((Double(sourceWidth) * scale).rounded())))
        let height = Self.even(max(2, Int((Double(sourceHeight) * scale).rounded())))
        let pixelScale = scale * scale
        let proposed = estimatedDataRate > 0
            ? Int(estimatedDataRate * pixelScale * 0.65)
            : maximumBitRate
        let bitrate = min(maximumBitRate, max(minimumBitRate, proposed))
        return VideoCompressionPlan(
            width: width,
            height: height,
            averageBitRate: bitrate,
            audioStrategy: .passthrough,
            fileExtension: "mov",
            contentType: "video/quicktime"
        )
    }

    private static func even(_ value: Int) -> Int {
        value.isMultiple(of: 2) ? value : value - 1
    }
}

struct PhotoCompressionProfile: Equatable, Sendable {
    let maxPixelDimension: Int
    let quality: Double
    let fileExtension: String
    let contentType: String

    static let afterimage = PhotoCompressionProfile(
        maxPixelDimension: 3_072,
        quality: 0.88,
        fileExtension: "heic",
        contentType: "image/heic"
    )
}

struct OptimizedMedia: Sendable {
    let kind: MediaKind
    let url: URL
    let thumbnailURL: URL
    let filename: String
    let contentType: String
    let byteSize: Int64
    let sourceByteSize: Int64
    let width: Int
    let height: Int
    let durationMs: Int?
    let capturedAt: Date

    func removeTemporaryFiles() {
        try? FileManager.default.removeItem(at: url)
        try? FileManager.default.removeItem(at: thumbnailURL)
    }
}

actor MediaCompressor {
    typealias ProgressHandler = @Sendable (Double) -> Void

    private let videoProfile: VideoCompressionProfile
    private let photoProfile: PhotoCompressionProfile

    init(
        videoProfile: VideoCompressionProfile = .afterimage,
        photoProfile: PhotoCompressionProfile = .afterimage
    ) {
        self.videoProfile = videoProfile
        self.photoProfile = photoProfile
    }

    func optimize(_ media: ImportedMedia, progress: @escaping ProgressHandler) async throws -> OptimizedMedia {
        try Task.checkCancellation()
        progress(0)
        switch media.kind {
        case .image:
            return try await optimizePhoto(media, progress: progress)
        case .video:
            return try await optimizeVideo(media, progress: progress)
        }
    }

    private func optimizePhoto(_ media: ImportedMedia, progress: @escaping ProgressHandler) async throws -> OptimizedMedia {
        let profile = photoProfile
        let outputURL = try Self.temporaryURL(extension: profile.fileExtension)
        let thumbnailURL = try Self.temporaryURL(extension: "jpg")
        let sourceByteSize = try Self.fileSize(media.url)

        do {
            let result = try await Task.detached(priority: .userInitiated) {
                guard let source = CGImageSourceCreateWithURL(media.url as CFURL, nil) else {
                    throw AfterimageError.compressionFailed("画像を読み込めませんでした。")
                }
                let thumbnailOptions: [CFString: Any] = [
                    kCGImageSourceCreateThumbnailFromImageAlways: true,
                    kCGImageSourceCreateThumbnailWithTransform: true,
                    kCGImageSourceShouldCacheImmediately: true,
                    kCGImageSourceThumbnailMaxPixelSize: profile.maxPixelDimension,
                ]
                guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, thumbnailOptions as CFDictionary) else {
                    throw AfterimageError.compressionFailed("画像を展開できませんでした。")
                }
                guard let destination = CGImageDestinationCreateWithURL(
                    outputURL as CFURL,
                    UTType.heic.identifier as CFString,
                    1,
                    nil
                ) else {
                    throw AfterimageError.compressionFailed("HEIC出力を作成できませんでした。")
                }
                let outputOptions: [CFString: Any] = [
                    kCGImageDestinationLossyCompressionQuality: profile.quality,
                    kCGImagePropertyOrientation: 1,
                ]
                CGImageDestinationAddImage(destination, image, outputOptions as CFDictionary)
                guard CGImageDestinationFinalize(destination) else {
                    throw AfterimageError.compressionFailed("HEIC変換を完了できませんでした。")
                }
                try Self.writeJPEGThumbnail(from: image, to: thumbnailURL)
                return (image.width, image.height)
            }.value

            progress(1)
            return OptimizedMedia(
                kind: .image,
                url: outputURL,
                thumbnailURL: thumbnailURL,
                filename: "\(media.baseFilename).\(profile.fileExtension)",
                contentType: profile.contentType,
                byteSize: try Self.fileSize(outputURL),
                sourceByteSize: sourceByteSize,
                width: result.0,
                height: result.1,
                durationMs: nil,
                capturedAt: media.capturedAt ?? Date()
            )
        } catch {
            try? FileManager.default.removeItem(at: outputURL)
            try? FileManager.default.removeItem(at: thumbnailURL)
            if error is CancellationError { throw AfterimageError.cancelled }
            throw error
        }
    }

    private func optimizeVideo(_ media: ImportedMedia, progress: @escaping ProgressHandler) async throws -> OptimizedMedia {
        let asset = AVURLAsset(url: media.url)
        guard let videoTrack = try await asset.loadTracks(withMediaType: .video).first else {
            throw AfterimageError.compressionFailed("映像トラックが見つかりませんでした。")
        }

        let naturalSize = try await videoTrack.load(.naturalSize)
        let estimatedDataRate = try await videoTrack.load(.estimatedDataRate)
        let preferredTransform = try await videoTrack.load(.preferredTransform)
        let frameRate = try await videoTrack.load(.nominalFrameRate)
        let duration = try await asset.load(.duration)
        let plan = videoProfile.plan(
            sourceWidth: max(2, Int(abs(naturalSize.width).rounded())),
            sourceHeight: max(2, Int(abs(naturalSize.height).rounded())),
            estimatedDataRate: Double(estimatedDataRate)
        )
        let outputURL = try Self.temporaryURL(extension: plan.fileExtension)
        let thumbnailURL = try Self.temporaryURL(extension: "jpg")
        let sourceByteSize = try Self.fileSize(media.url)

        let reader = try AVAssetReader(asset: asset)
        let writer = try AVAssetWriter(outputURL: outputURL, fileType: .mov)
        writer.shouldOptimizeForNetworkUse = true
        let ioSession = AVReadWriteSession(reader: reader, writer: writer)

        let pixelSettings: [String: Any] = [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
        ]
        let videoOutput = AVAssetReaderTrackOutput(track: videoTrack, outputSettings: pixelSettings)
        videoOutput.alwaysCopiesSampleData = false
        guard reader.canAdd(videoOutput) else {
            throw AfterimageError.compressionFailed("映像の読み込みを準備できませんでした。")
        }
        reader.add(videoOutput)

        let expectedFrameRate = max(1, min(60, Int(frameRate.rounded())))
        let compressionProperties: [String: Any] = [
            AVVideoAverageBitRateKey: plan.averageBitRate,
            AVVideoExpectedSourceFrameRateKey: expectedFrameRate,
            AVVideoMaxKeyFrameIntervalDurationKey: 2,
            AVVideoAllowFrameReorderingKey: true,
        ]
        let videoSettings: [String: Any] = [
            AVVideoCodecKey: AVVideoCodecType.hevc,
            AVVideoWidthKey: plan.width,
            AVVideoHeightKey: plan.height,
            AVVideoCompressionPropertiesKey: compressionProperties,
        ]
        let videoInput = AVAssetWriterInput(mediaType: .video, outputSettings: videoSettings)
        videoInput.expectsMediaDataInRealTime = false
        let scaleX = CGFloat(plan.width) / max(1, abs(naturalSize.width))
        let scaleY = CGFloat(plan.height) / max(1, abs(naturalSize.height))
        videoInput.transform = CGAffineTransform(
            a: preferredTransform.a,
            b: preferredTransform.b,
            c: preferredTransform.c,
            d: preferredTransform.d,
            tx: preferredTransform.tx * scaleX,
            ty: preferredTransform.ty * scaleY
        )
        guard writer.canAdd(videoInput) else {
            throw AfterimageError.compressionFailed("HEVC圧縮を準備できませんでした。")
        }
        writer.add(videoInput)

        var audioPipelines: [MediaSamplePipeline] = []
        for audioTrack in try await asset.loadTracks(withMediaType: .audio) {
            let descriptions = try await audioTrack.load(.formatDescriptions)
            let formatHint = descriptions.first
            let output = AVAssetReaderTrackOutput(track: audioTrack, outputSettings: nil)
            output.alwaysCopiesSampleData = false
            let input = AVAssetWriterInput(mediaType: .audio, outputSettings: nil, sourceFormatHint: formatHint)
            input.expectsMediaDataInRealTime = false
            guard reader.canAdd(output), writer.canAdd(input) else {
                throw AfterimageError.compressionFailed("音声を無劣化のまま格納できない形式です。")
            }
            reader.add(output)
            writer.add(input)
            audioPipelines.append(MediaSamplePipeline(input: input, output: output, session: ioSession))
        }

        guard writer.startWriting() else {
            throw AfterimageError.compressionFailed(writer.error?.localizedDescription ?? "出力を開始できませんでした。")
        }
        guard reader.startReading() else {
            writer.cancelWriting()
            throw AfterimageError.compressionFailed(reader.error?.localizedDescription ?? "入力を開始できませんでした。")
        }
        writer.startSession(atSourceTime: .zero)
        let videoPipeline = MediaSamplePipeline(input: videoInput, output: videoOutput, session: ioSession)

        do {
            try await withTaskCancellationHandler {
                try await withThrowingTaskGroup(of: Void.self) { group in
                    group.addTask {
                        try await Self.pump(
                            pipeline: videoPipeline,
                            duration: duration,
                            progress: progress
                        )
                    }
                    for pipeline in audioPipelines {
                        group.addTask {
                            try await Self.pump(
                                pipeline: pipeline,
                                duration: nil,
                                progress: nil
                            )
                        }
                    }
                    try await group.waitForAll()
                }
                await ioSession.finishWriting()
            } onCancel: {
                ioSession.cancel()
            }
        } catch {
            ioSession.cancel()
            try? FileManager.default.removeItem(at: outputURL)
            if error is CancellationError {
                throw AfterimageError.cancelled
            }
            if case AfterimageError.cancelled = error {
                throw AfterimageError.cancelled
            }
            throw error
        }

        guard writer.status == .completed else {
            try? FileManager.default.removeItem(at: outputURL)
            throw AfterimageError.compressionFailed(writer.error?.localizedDescription ?? "動画変換を完了できませんでした。")
        }

        do {
            let generator = AVAssetImageGenerator(asset: AVURLAsset(url: outputURL))
            generator.appliesPreferredTrackTransform = true
            generator.maximumSize = CGSize(width: 960, height: 960)
            let seconds = max(0, min(0.25, duration.seconds / 3))
            let image = try await generator.image(at: CMTime(seconds: seconds, preferredTimescale: 600)).image
            try Self.writeJPEGThumbnail(from: image, to: thumbnailURL)
        } catch {
            try? FileManager.default.removeItem(at: outputURL)
            throw AfterimageError.compressionFailed("動画のプレビューを作成できませんでした。")
        }

        progress(1)
        let isQuarterTurn = abs(preferredTransform.b) > 0.5 || abs(preferredTransform.c) > 0.5
        let displayWidth = isQuarterTurn ? plan.height : plan.width
        let displayHeight = isQuarterTurn ? plan.width : plan.height
        return OptimizedMedia(
            kind: .video,
            url: outputURL,
            thumbnailURL: thumbnailURL,
            filename: "\(media.baseFilename).\(plan.fileExtension)",
            contentType: plan.contentType,
            byteSize: try Self.fileSize(outputURL),
            sourceByteSize: sourceByteSize,
            width: displayWidth,
            height: displayHeight,
            durationMs: Int((duration.seconds * 1_000).rounded()),
            capturedAt: media.capturedAt ?? Date()
        )
    }

    private static func pump(
        pipeline: MediaSamplePipeline,
        duration: CMTime?,
        progress: ProgressHandler?
    ) async throws {
        let cancellation = PumpCancellationRelay()
        try await withTaskCancellationHandler {
            try Task.checkCancellation()
            try await withCheckedThrowingContinuation { continuation in
                let gate = ContinuationGate(continuation)
                guard cancellation.install(gate) else { return }
                let queue = DispatchQueue(label: "com.2-38.afterimage.media-pump.\(UUID().uuidString)")
                pipeline.input.requestMediaDataWhenReady(on: queue) { [pipeline] in
                    while pipeline.input.isReadyForMoreMediaData {
                        if pipeline.session.reader.status == .cancelled || pipeline.session.writer.status == .cancelled {
                            pipeline.input.markAsFinished()
                            gate.resume(throwing: AfterimageError.cancelled)
                            return
                        }
                        if pipeline.session.reader.status == .failed {
                            pipeline.input.markAsFinished()
                            gate.resume(throwing: pipeline.session.reader.error ?? AfterimageError.compressionFailed("メディアを読み込めませんでした。"))
                            return
                        }
                        guard let sampleBuffer = pipeline.output.copyNextSampleBuffer() else {
                            pipeline.input.markAsFinished()
                            gate.resume()
                            return
                        }
                        guard pipeline.input.append(sampleBuffer) else {
                            pipeline.input.markAsFinished()
                            gate.resume(throwing: pipeline.session.writer.error ?? AfterimageError.compressionFailed("メディアを書き込めませんでした。"))
                            return
                        }
                        if let duration, duration.seconds > 0, let progress {
                            let time = CMSampleBufferGetPresentationTimeStamp(sampleBuffer).seconds
                            progress(min(0.99, max(0, time / duration.seconds)))
                        }
                    }
                }
            }
        } onCancel: {
            cancellation.cancel(session: pipeline.session)
        }
    }

    private static func temporaryURL(extension fileExtension: String) throws -> URL {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("afterimage-optimized", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory.appendingPathComponent(UUID().uuidString).appendingPathExtension(fileExtension)
    }

    private static func fileSize(_ url: URL) throws -> Int64 {
        let values = try url.resourceValues(forKeys: [.fileSizeKey])
        guard let size = values.fileSize else {
            throw AfterimageError.compressionFailed("ファイルサイズを確認できませんでした。")
        }
        return Int64(size)
    }

    private static func writeJPEGThumbnail(from image: CGImage, to url: URL) throws {
        guard let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.jpeg.identifier as CFString, 1, nil) else {
            throw AfterimageError.compressionFailed("プレビュー出力を作成できませんでした。")
        }
        let options: [CFString: Any] = [kCGImageDestinationLossyCompressionQuality: 0.78]
        CGImageDestinationAddImage(destination, image, options as CFDictionary)
        guard CGImageDestinationFinalize(destination) else {
            throw AfterimageError.compressionFailed("プレビューを保存できませんでした。")
        }
    }
}

private final class AVReadWriteSession: @unchecked Sendable {
    let reader: AVAssetReader
    let writer: AVAssetWriter

    init(reader: AVAssetReader, writer: AVAssetWriter) {
        self.reader = reader
        self.writer = writer
    }

    func cancel() {
        reader.cancelReading()
        writer.cancelWriting()
    }

    func finishWriting() async {
        await writer.finishWriting()
    }
}

private final class MediaSamplePipeline: @unchecked Sendable {
    let input: AVAssetWriterInput
    let output: AVAssetReaderOutput
    let session: AVReadWriteSession

    init(input: AVAssetWriterInput, output: AVAssetReaderOutput, session: AVReadWriteSession) {
        self.input = input
        self.output = output
        self.session = session
    }
}

private final class PumpCancellationRelay: @unchecked Sendable {
    private let lock = NSLock()
    private var isCancelled = false
    private var gate: ContinuationGate?

    func install(_ gate: ContinuationGate) -> Bool {
        lock.lock()
        if isCancelled {
            lock.unlock()
            gate.resume(throwing: AfterimageError.cancelled)
            return false
        }
        self.gate = gate
        lock.unlock()
        return true
    }

    func cancel(session: AVReadWriteSession) {
        lock.lock()
        guard !isCancelled else {
            lock.unlock()
            return
        }
        isCancelled = true
        let gate = gate
        lock.unlock()

        session.cancel()
        gate?.resume(throwing: AfterimageError.cancelled)
    }
}

private final class ContinuationGate: @unchecked Sendable {
    private let lock = NSLock()
    private var resumed = false
    private let continuation: CheckedContinuation<Void, Error>

    init(_ continuation: CheckedContinuation<Void, Error>) {
        self.continuation = continuation
    }

    func resume() {
        lock.lock()
        guard !resumed else {
            lock.unlock()
            return
        }
        resumed = true
        lock.unlock()
        continuation.resume()
    }

    func resume(throwing error: Error) {
        lock.lock()
        guard !resumed else {
            lock.unlock()
            return
        }
        resumed = true
        lock.unlock()
        continuation.resume(throwing: error)
    }
}
