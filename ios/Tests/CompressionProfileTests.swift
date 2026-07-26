import XCTest
@testable import afterimage

final class CompressionProfileTests: XCTestCase {
    func testVideoPlanCaps4KAt1080pAndKeepsAudioPassthrough() {
        let plan = VideoCompressionProfile.afterimage.plan(
            sourceWidth: 3840,
            sourceHeight: 2160,
            estimatedDataRate: 80_000_000
        )

        XCTAssertEqual(plan.width, 1920)
        XCTAssertEqual(plan.height, 1080)
        XCTAssertEqual(plan.averageBitRate, 6_000_000)
        XCTAssertEqual(plan.audioStrategy, .passthrough)
        XCTAssertEqual(plan.fileExtension, "mov")
        XCTAssertEqual(plan.contentType, "video/quicktime")
    }

    func testVideoPlanPreservesPortraitAspectAndUsesEvenDimensions() {
        let plan = VideoCompressionProfile.afterimage.plan(
            sourceWidth: 2160,
            sourceHeight: 3840,
            estimatedDataRate: 40_000_000
        )

        XCTAssertEqual(plan.width, 1080)
        XCTAssertEqual(plan.height, 1920)
        XCTAssertEqual(plan.width % 2, 0)
        XCTAssertEqual(plan.height % 2, 0)
    }

    func testPhotoProfileProducesBoundedHEIC() {
        XCTAssertEqual(PhotoCompressionProfile.afterimage.maxPixelDimension, 3_072)
        XCTAssertEqual(PhotoCompressionProfile.afterimage.quality, 0.88, accuracy: 0.001)
        XCTAssertEqual(PhotoCompressionProfile.afterimage.fileExtension, "heic")
        XCTAssertEqual(PhotoCompressionProfile.afterimage.contentType, "image/heic")
    }
}
