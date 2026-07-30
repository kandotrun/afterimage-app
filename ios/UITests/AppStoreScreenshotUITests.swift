import UIKit
import XCTest

@MainActor
final class AppStoreScreenshotUITests: XCTestCase {
    func testCaptureAppStoreScreenshots() throws {
        let environment = ProcessInfo.processInfo.environment
        guard let outputPath = environment["AFTERIMAGE_SCREENSHOT_OUTPUT_DIR"],
              !outputPath.isEmpty else {
            XCTFail("AFTERIMAGE_SCREENSHOT_OUTPUT_DIR is required")
            return
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

            let ready = app.otherElements["app-store-screenshot-ready-\(scene)"]
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

    private func opaquePNGData(_ screenshot: XCUIScreenshot) throws -> Data {
        guard let image = UIImage(data: screenshot.pngRepresentation) else {
            throw AppStoreScreenshotError.invalidImage
        }
        let format = UIGraphicsImageRendererFormat()
        format.opaque = true
        format.scale = image.scale
        let renderer = UIGraphicsImageRenderer(size: image.size, format: format)
        let flattened = renderer.image { context in
            UIColor.black.setFill()
            context.fill(CGRect(origin: .zero, size: image.size))
            image.draw(in: CGRect(origin: .zero, size: image.size))
        }
        guard let data = flattened.pngData() else {
            throw AppStoreScreenshotError.invalidImage
        }
        return data
    }
}

private enum AppStoreScreenshotError: Error {
    case invalidImage
}
