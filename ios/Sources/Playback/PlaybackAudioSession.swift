import AVFAudio

protocol AudioSessionControlling: AnyObject {
    func setCategory(
        _ category: AVAudioSession.Category,
        mode: AVAudioSession.Mode,
        options: AVAudioSession.CategoryOptions
    ) throws
    func setActive(_ active: Bool, options: AVAudioSession.SetActiveOptions) throws
}

extension AVAudioSession: AudioSessionControlling {}

@MainActor
struct PlaybackAudioSession {
    private let session: any AudioSessionControlling

    init(session: any AudioSessionControlling = AVAudioSession.sharedInstance()) {
        self.session = session
    }

    func activate() throws {
        try session.setCategory(.playback, mode: .moviePlayback, options: [])
        try session.setActive(true, options: [])
    }

    func deactivate() {
        try? session.setActive(false, options: [.notifyOthersOnDeactivation])
    }
}
