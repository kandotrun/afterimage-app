import Foundation
import Security

protocol SessionStoring: Sendable {
    func load() throws -> StoredSession?
    func save(_ session: StoredSession) throws
    @discardableResult
    func clear(ifCurrent context: AuthSessionContext) throws -> Bool
}

final class KeychainSessionStore: SessionStoring, @unchecked Sendable {
    private static let lock = NSLock()
    private let service: String
    private let account = "bearer-session"

    init(service: String = "com.2-38.afterimage") {
        self.service = service
    }

    func load() throws -> StoredSession? {
        try Self.lock.withLock {
            try loadUnlocked()
        }
    }

    func save(_ session: StoredSession) throws {
        try Self.lock.withLock {
            let data = try JSONEncoder().encode(session)
            try saveUnlocked(data)
        }
    }

    @discardableResult
    func clear(ifCurrent context: AuthSessionContext) throws -> Bool {
        try Self.lock.withLock {
            let stored = try loadUnlocked()
            guard SessionCASPolicy.canClear(stored: stored, expected: context) else {
                return false
            }
            let status = SecItemDelete(baseQuery as CFDictionary)
            guard status == errSecSuccess || status == errSecItemNotFound else {
                throw KeychainError(status)
            }
            return true
        }
    }

    private func loadUnlocked() throws -> StoredSession? {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else {
            throw KeychainError(status)
        }
        if let session = try? JSONDecoder().decode(StoredSession.self, from: data) {
            return session
        }
        guard let token = String(data: data, encoding: .utf8), !token.isEmpty else {
            throw KeychainError(errSecDecode)
        }
        return StoredSession(
            token: token,
            context: AuthSessionContext(generationID: UUID(), accountID: nil)
        )
    }

    private func saveUnlocked(_ data: Data) throws {
        var attributes = baseQuery
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        attributes[kSecValueData as String] = data
        let status = SecItemAdd(attributes as CFDictionary, nil)
        if status == errSecDuplicateItem {
            let update: [String: Any] = [kSecValueData as String: data]
            let updateStatus = SecItemUpdate(baseQuery as CFDictionary, update as CFDictionary)
            guard updateStatus == errSecSuccess else { throw KeychainError(updateStatus) }
        } else if status != errSecSuccess {
            throw KeychainError(status)
        }
    }

    private var baseQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }
}

private extension NSLock {
    func withLock<T>(_ operation: () throws -> T) rethrows -> T {
        lock()
        defer { unlock() }
        return try operation()
    }
}

private struct KeychainError: LocalizedError {
    let status: OSStatus
    init(_ status: OSStatus) { self.status = status }
    var errorDescription: String? {
        SecCopyErrorMessageString(status, nil) as String? ?? "Keychain error \(status)"
    }
}
