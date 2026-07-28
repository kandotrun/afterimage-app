@preconcurrency import AVFoundation

extension CameraCaptureClient {
    static func live() -> CameraCaptureClient {
        let capture = CameraCaptureSession()
        return CameraCaptureClient(
            session: capture.session,
            cameraPermission: {
                permission(for: .video)
            },
            requestCameraPermission: {
                await AVCaptureDevice.requestAccess(for: .video)
            },
            microphonePermission: {
                permission(for: .audio)
            },
            requestMicrophonePermission: {
                await AVCaptureDevice.requestAccess(for: .audio)
            },
            configure: { eventHandler in
                try await capture.configure(eventHandler: eventHandler)
            },
            startSession: {
                capture.startSession()
            },
            stopSession: {
                capture.stopSession()
            },
            startRecording: { url, hasAudio in
                try capture.startRecording(to: url, hasAudio: hasAudio)
            },
            stopRecording: {
                capture.stopRecording()
            },
            recordingHasAudio: { url in
                let asset = AVURLAsset(url: url)
                let tracks = try await asset.loadTracks(withMediaType: .audio)
                return !tracks.isEmpty
            },
            resetSession: {
                try await capture.resetSession()
            },
            switchCamera: {
                try await capture.switchCamera()
            },
            focus: { point in
                capture.focus(at: point)
            },
            zoom: { factor in
                capture.zoom(to: factor)
            },
            attachPreviewLayer: { layer in
                capture.attachPreviewLayer(layer)
            }
        )
    }

    private static func permission(
        for mediaType: AVMediaType
    ) -> CameraPermission {
        switch AVCaptureDevice.authorizationStatus(for: mediaType) {
        case .notDetermined:
            .notDetermined
        case .authorized:
            .authorized
        case .denied, .restricted:
            .denied
        @unknown default:
            .denied
        }
    }
}
