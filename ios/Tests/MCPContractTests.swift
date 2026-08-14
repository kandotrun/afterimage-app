import XCTest
@testable import afterimage

final class MCPContractTests: XCTestCase {
    func testDecodesTokenMetadataWithoutRawSecret() throws {
        let data = Data(#"""
        {
          "items": [
            {
              "id": "token-1",
              "name": "Hermes",
              "createdAt": "2026-07-27T08:00:00.000Z",
              "expiresAt": "2027-07-27T08:00:00.000Z",
              "lastUsedAt": null
            }
          ]
        }
        """#.utf8)

        let response = try JSONDecoder.afterimage.decode(MCPTokenListResponse.self, from: data)

        XCTAssertEqual(response.items.count, 1)
        XCTAssertEqual(response.items[0].id, "token-1")
        XCTAssertEqual(response.items[0].name, "Hermes")
        XCTAssertNil(response.items[0].lastUsedAt)
    }

    func testGeneratedAgentConfigurationIsValidAndContainsBearerCredential() throws {
        let endpoint = try XCTUnwrap(URL(string: "https://afterimage.2-38.com/mcp"))
        let fixtureToken = "aft_" + "mcp_" + String(repeating: "x", count: 48)
        let configuration = MCPAgentConfiguration(
            endpoint: endpoint,
            token: fixtureToken
        )

        let jsonData = try XCTUnwrap(configuration.genericJSON.data(using: .utf8))
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: jsonData) as? [String: Any])
        let servers = try XCTUnwrap(json["mcpServers"] as? [String: Any])
        let afterimage = try XCTUnwrap(servers["afterimage"] as? [String: Any])
        let headers = try XCTUnwrap(afterimage["headers"] as? [String: String])

        XCTAssertEqual(afterimage["url"] as? String, endpoint.absoluteString)
        XCTAssertEqual(headers["Authorization"], "Bearer \(configuration.token)")
        XCTAssertTrue(configuration.hermesYAML.contains("mcp_servers:"))
        XCTAssertTrue(configuration.agentSetupPrompt.contains("tools/list"))
    }
}
