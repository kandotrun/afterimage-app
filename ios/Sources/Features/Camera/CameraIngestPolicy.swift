enum CameraIngestPolicy {
    static func canAccept(
        hasUploadTask: Bool,
        hasPendingBackgroundUpload: Bool
    ) -> Bool {
        !hasUploadTask && !hasPendingBackgroundUpload
    }
}
