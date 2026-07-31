import CoreHaptics
import UIKit

struct HapticEventDescriptor: Equatable, Sendable {
    enum Kind: Equatable, Sendable { case transient, continuous }
    let kind: Kind
    let relativeTime: TimeInterval
    let intensity: Float
    let sharpness: Float
    let duration: TimeInterval
}

enum HapticCue: Equatable, Sendable {
    case selection
    case lift
    case progress
    case focus
    case recordStart
    case recordStop
    case copy
    case warning
    case success
    case failure
    case delete

    var events: [HapticEventDescriptor] {
        switch self {
        case .selection:
            [HapticEventDescriptor(kind: .transient, relativeTime: 0, intensity: 0.32, sharpness: 0.72, duration: 0)]
        case .lift:
            [HapticEventDescriptor(kind: .transient, relativeTime: 0, intensity: 0.45, sharpness: 0.42, duration: 0)]
        case .progress:
            [HapticEventDescriptor(kind: .transient, relativeTime: 0, intensity: 0.16, sharpness: 0.35, duration: 0)]
        case .focus:
            [HapticEventDescriptor(kind: .transient, relativeTime: 0, intensity: 0.14, sharpness: 0.92, duration: 0)]
        case .recordStart:
            [
                HapticEventDescriptor(kind: .transient, relativeTime: 0, intensity: 0.42, sharpness: 0.38, duration: 0),
                HapticEventDescriptor(kind: .transient, relativeTime: 0.07, intensity: 0.82, sharpness: 0.72, duration: 0),
            ]
        case .recordStop:
            [
                HapticEventDescriptor(kind: .transient, relativeTime: 0, intensity: 0.74, sharpness: 0.64, duration: 0),
                HapticEventDescriptor(kind: .transient, relativeTime: 0.08, intensity: 0.34, sharpness: 0.28, duration: 0),
            ]
        case .copy:
            [
                HapticEventDescriptor(kind: .transient, relativeTime: 0, intensity: 0.20, sharpness: 0.62, duration: 0),
                HapticEventDescriptor(kind: .transient, relativeTime: 0.06, intensity: 0.40, sharpness: 0.80, duration: 0),
            ]
        case .warning:
            [
                HapticEventDescriptor(kind: .continuous, relativeTime: 0, intensity: 0.34, sharpness: 0.20, duration: 0.08),
                HapticEventDescriptor(kind: .transient, relativeTime: 0.10, intensity: 0.58, sharpness: 0.30, duration: 0),
            ]
        case .success:
            [
                HapticEventDescriptor(kind: .transient, relativeTime: 0, intensity: 0.55, sharpness: 0.45, duration: 0),
                HapticEventDescriptor(kind: .transient, relativeTime: 0.08, intensity: 0.90, sharpness: 0.82, duration: 0),
            ]
        case .failure:
            [
                HapticEventDescriptor(kind: .continuous, relativeTime: 0, intensity: 0.42, sharpness: 0.16, duration: 0.12),
                HapticEventDescriptor(kind: .transient, relativeTime: 0.14, intensity: 0.68, sharpness: 0.22, duration: 0),
            ]
        case .delete:
            [HapticEventDescriptor(kind: .transient, relativeTime: 0, intensity: 0.72, sharpness: 0.18, duration: 0)]
        }
    }
}

@MainActor
protocol HapticPlaying: AnyObject {
    func play(_ cue: HapticCue)
}

@MainActor
final class HapticEngine: HapticPlaying {
    private var engine: CHHapticEngine?

    init() {
        guard CHHapticEngine.capabilitiesForHardware().supportsHaptics else { return }
        do {
            let engine = try CHHapticEngine()
            engine.isAutoShutdownEnabled = true
            engine.resetHandler = { [weak self] in
                Task { @MainActor in try? self?.engine?.start() }
            }
            self.engine = engine
            try engine.start()
        } catch {
            engine = nil
        }
    }

    func play(_ cue: HapticCue) {
        guard let engine else {
            playUIKitFallback(cue)
            return
        }
        do {
            try engine.start()
            let events = cue.events.map { descriptor in
                let parameters = [
                    CHHapticEventParameter(parameterID: .hapticIntensity, value: descriptor.intensity),
                    CHHapticEventParameter(parameterID: .hapticSharpness, value: descriptor.sharpness),
                ]
                let type: CHHapticEvent.EventType = descriptor.kind == .transient ? .hapticTransient : .hapticContinuous
                return CHHapticEvent(
                    eventType: type,
                    parameters: parameters,
                    relativeTime: descriptor.relativeTime,
                    duration: descriptor.duration
                )
            }
            let pattern = try CHHapticPattern(events: events, parameters: [])
            try engine.makePlayer(with: pattern).start(atTime: CHHapticTimeImmediate)
        } catch {
            playUIKitFallback(cue)
        }
    }

    private func playUIKitFallback(_ cue: HapticCue) {
        switch cue {
        case .success:
            UINotificationFeedbackGenerator().notificationOccurred(.success)
        case .failure:
            UINotificationFeedbackGenerator().notificationOccurred(.error)
        case .warning:
            UINotificationFeedbackGenerator().notificationOccurred(.warning)
        case .selection, .progress, .focus:
            UISelectionFeedbackGenerator().selectionChanged()
        case .lift, .copy:
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
        case .recordStart:
            UIImpactFeedbackGenerator(style: .rigid).impactOccurred(intensity: 0.82)
        case .recordStop:
            UIImpactFeedbackGenerator(style: .medium).impactOccurred(intensity: 0.68)
        case .delete:
            UIImpactFeedbackGenerator(style: .heavy).impactOccurred()
        }
    }
}
