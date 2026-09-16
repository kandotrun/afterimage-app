import CoreGraphics
import ImageIO
import UIKit
import XCTest

@MainActor
final class AppStoreScreenshotUITests: XCTestCase {
    func testCaptureAppStoreScreenshots() throws {
        let environment = ProcessInfo.processInfo.environment
        guard let outputPath = environment["AFTERIMAGE_SCREENSHOT_OUTPUT_DIR"],
              !outputPath.isEmpty else {
            throw XCTSkip("Screenshot capture runs only with AFTERIMAGE_SCREENSHOT_OUTPUT_DIR")
        }
        let outputDirectory = URL(fileURLWithPath: outputPath, isDirectory: true)
        try FileManager.default.createDirectory(
            at: outputDirectory,
            withIntermediateDirectories: true
        )

        let captures = [
            ("timeline", "01-private-timeline.png"),
            ("memory", "02-memory-detail.png"),
            ("analysis", "03-ai-analysis.png"),
        ]
        for (scene, filename) in captures {
            let app = XCUIApplication()
            app.launchArguments = [
                "-AppleLanguages", "(ja)",
                "-AppleLocale", "ja_JP",
                "-afterimageAppStoreScreenshotScene", scene,
            ]
            app.launch()

            let ready = app.descendants(matching: .any)
                .matching(identifier: "app-store-screenshot-ready-\(scene)")
                .firstMatch
            XCTAssertTrue(ready.waitForExistence(timeout: 10))
            let screenshot = XCUIScreen.main.screenshot()
            let data = try opaquePNGData(screenshot)
            try data.write(
                to: outputDirectory.appendingPathComponent(filename),
                options: .atomic
            )
            app.terminate()
        }
    }

    /// Redraws the screenshot into an opaque device-RGB bitmap and encodes it as a
    /// PNG without an alpha channel. `UIGraphicsImageRenderer` with
    /// `format.opaque = true` can still emit colorType 6, which App Store
    /// submission rejects, so the RGB context below is the authoritative step.
    private func opaquePNGData(_ screenshot: XCUIScreenshot) throws -> Data {
        guard let image = UIImage(data: screenshot.pngRepresentation)?.cgImage else {
            throw AppStoreScreenshotError.invalidImage
        }
        let width = image.width
        let height = image.height
        let bitmapInfo = CGImageAlphaInfo.noneSkipLast.rawValue
        guard let context = CGContext(
            data: nil,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: bitmapInfo
        ) else {
            throw AppStoreScreenshotError.invalidImage
        }
        context.setFillColor(red: 0, green: 0, blue: 0, alpha: 1)
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        guard let opaque = context.makeImage() else {
            throw AppStoreScreenshotError.invalidImage
        }
        let buffer = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(
            buffer,
            "public.png" as CFString,
            1,
            nil
        ) else {
            throw AppStoreScreenshotError.invalidImage
        }
        CGImageDestinationAddImage(destination, opaque, nil)
        guard CGImageDestinationFinalize(destination) else {
            throw AppStoreScreenshotError.invalidImage
        }
        return buffer as Data
    }
}

private enum AppStoreScreenshotError: Error {
    case invalidImage
}
