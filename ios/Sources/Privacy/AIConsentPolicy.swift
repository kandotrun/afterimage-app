import Foundation

enum AIConsentPolicy {
    static let currentVersion = "2026-07-30"

    static func canTransferExternally(consent: AIConsent?) -> Bool {
        guard let consent else { return false }
        return consent.granted
            && consent.version == currentVersion
            && consent.consentedAt != nil
            && consent.withdrawnAt == nil
    }

    static func canEnableAgentAccess(consent: AIConsent?) -> Bool {
        canTransferExternally(consent: consent)
    }
}
