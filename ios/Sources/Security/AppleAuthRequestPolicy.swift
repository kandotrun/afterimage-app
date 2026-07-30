import AuthenticationServices
import CryptoKit
import Foundation

struct AppleAuthRequestBinding: Equatable, Sendable {
    let challengeID: String
    let hashedNonce: String
    let expiresAt: Date
}

enum AppleAuthRequestPolicy {
    static func binding(
        challenge: AppleAuthChallenge,
        now: Date = Date()
    ) throws -> AppleAuthRequestBinding {
        let challengeID = challenge.challengeId.trimmingCharacters(
            in: .whitespacesAndNewlines
        )
        guard !challengeID.isEmpty,
              !challenge.nonce.isEmpty,
              challenge.expiresAt > now else {
            throw AfterimageError.api(
                status: 401,
                code: .authChallengeExpired,
                message: "expired"
            )
        }
        return AppleAuthRequestBinding(
            challengeID: challengeID,
            hashedNonce: sha256(challenge.nonce),
            expiresAt: challenge.expiresAt
        )
    }

    static func sha256(_ rawNonce: String) -> String {
        SHA256.hash(data: Data(rawNonce.utf8))
            .map { String(format: "%02x", $0) }
            .joined()
    }

    static func configure(
        _ request: ASAuthorizationAppleIDRequest,
        binding: AppleAuthRequestBinding
    ) {
        request.requestedScopes = [.fullName, .email]
        request.nonce = binding.hashedNonce
    }
}

struct AppleAuthAttemptState: Equatable {
    private(set) var prepared: AppleAuthRequestBinding?
    private(set) var active: AppleAuthRequestBinding?

    mutating func prepare(_ binding: AppleAuthRequestBinding) {
        prepared = binding
        active = nil
    }

    mutating func consume(now: Date = Date()) throws -> AppleAuthRequestBinding {
        guard let binding = prepared, binding.expiresAt > now else {
            finish()
            throw AfterimageError.api(
                status: 401,
                code: .authChallengeExpired,
                message: "expired"
            )
        }
        prepared = nil
        active = binding
        return binding
    }

    mutating func finish() {
        prepared = nil
        active = nil
    }
}
