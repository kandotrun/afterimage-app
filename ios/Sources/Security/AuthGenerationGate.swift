import Foundation

struct AuthSessionContext: Codable, Equatable, Hashable, Sendable {
    let generationID: UUID
    let accountID: String?
}

struct StoredSession: Codable, Equatable, Sendable {
    let token: String
    let context: AuthSessionContext
}

enum SessionCASPolicy {
    static func canClear(
        stored: StoredSession?,
        expected: AuthSessionContext
    ) -> Bool {
        stored?.context == expected
    }
}

actor AuthGenerationGate {
    typealias TerminationHandler = @Sendable (AuthSessionContext) async -> Void

    static let shared = AuthGenerationGate()

    private var boundContext: AuthSessionContext?
    private var invalidatedGenerations: Set<UUID> = []
    private var terminatedGenerations: Set<UUID> = []
    private var terminationTasks: [UUID: Task<Void, Never>] = [:]
    private var terminationHandler: TerminationHandler?

    func setTerminationHandler(_ handler: @escaping TerminationHandler) {
        terminationHandler = handler
    }

    @discardableResult
    func bind(_ context: AuthSessionContext) -> Bool {
        guard !invalidatedGenerations.contains(context.generationID) else {
            return false
        }
        boundContext = context
        return true
    }

    func currentContext() -> AuthSessionContext? {
        boundContext
    }

    func unbind(ifCurrent context: AuthSessionContext) {
        if boundContext == context {
            boundContext = nil
        }
    }

    func invalidate(_ context: AuthSessionContext) async {
        invalidatedGenerations.insert(context.generationID)
        if boundContext == context {
            boundContext = nil
        }
        if let existing = terminationTasks[context.generationID] {
            await existing.value
            return
        }
        guard !terminatedGenerations.contains(context.generationID) else {
            return
        }
        guard let terminationHandler else { return }
        let task = Task {
            await terminationHandler(context)
        }
        terminationTasks[context.generationID] = task
        await task.value
        terminationTasks.removeValue(forKey: context.generationID)
        terminatedGenerations.insert(context.generationID)
    }
}
