import Foundation

struct MCPToken: Decodable, Identifiable, Equatable, Sendable {
    let id: String
    let name: String
    let createdAt: Date
    let expiresAt: Date
    let lastUsedAt: Date?
}

struct MCPTokenListResponse: Decodable, Sendable {
    let items: [MCPToken]
}

struct MCPTokenCreationResponse: Decodable, Sendable {
    let item: MCPToken
    let token: String
}

struct AssetTranscript: Decodable, Equatable, Sendable {
    let assetId: String
    let status: TranscriptionStatus
    let language: String?
    let text: String
    let updatedAt: Date?
}

struct MCPAgentConfiguration: Equatable, Sendable {
    let endpoint: URL
    let token: String

    var genericJSON: String {
        let object: [String: Any] = [
            "mcpServers": [
                "afterimage": [
                    "url": endpoint.absoluteString,
                    "headers": [
                        "Authorization": "Bearer \(token)",
                    ],
                ],
            ],
        ]
        guard let data = try? JSONSerialization.data(
            withJSONObject: object,
            options: [.prettyPrinted, .sortedKeys]
        ) else { return "{}" }
        return String(decoding: data, as: UTF8.self)
    }

    var hermesYAML: String {
        """
        mcp_servers:
          afterimage:
            url: \(quoted(endpoint.absoluteString))
            headers:
              Authorization: \(quoted("Bearer \(token)"))
        """
    }

    var agentSetupPrompt: String {
        """
        以下の認証付きAfterimage MCPをAIエージェントへ設定してください。

        URL: \(endpoint.absoluteString)
        Authorization: Bearer \(token)
        Transport: Streamable HTTP

        接続後に tools/list を実行し、list_transcriptions と get_transcription が利用できることを確認してください。tokenは秘密として扱い、ログや公開ファイルへ保存しないでください。
        """
    }

    private func quoted(_ value: String) -> String {
        guard let data = try? JSONSerialization.data(
            withJSONObject: value,
            options: [.fragmentsAllowed]
        ),
              let result = String(data: data, encoding: .utf8) else { return "\"\"" }
        return result
    }
}
