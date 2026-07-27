import SwiftUI
import UIKit

struct AIConnectionView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss

    @State private var endpoint: URL?
    @State private var tokens: [MCPToken] = []
    @State private var isLoading = true
    @State private var isCreating = false
    @State private var proposedName = "Hermes"
    @State private var showCreatePrompt = false
    @State private var tokenToRevoke: MCPToken?
    @State private var showRevocationConfirmation = false
    @State private var reveal: MCPReveal?
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    VStack(alignment: .leading, spacing: 12) {
                        Image(systemName: "brain.head.profile")
                            .font(.system(size: 38, weight: .medium))
                            .foregroundStyle(.tint)
                            .symbolEffect(.breathe)
                        Text("記憶を、AIが読めるように")
                            .font(.title2.weight(.bold))
                        Text("動画の文字起こしだけを、あなたが許可したAIエージェントへ安全に渡します。写真や動画本体を書き換える権限はありません。")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .lineSpacing(3)
                    }
                    .padding(.vertical, 8)
                }

                Section("MCPサーバー") {
                    LabeledContent("URL") {
                        Text(endpoint?.absoluteString ?? "確認中…")
                            .font(.caption.monospaced())
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                    }
                    Label("文字起こしの読み取り専用", systemImage: "lock.shield")
                        .foregroundStyle(.secondary)
                }

                Section("接続中のAI") {
                    if isLoading {
                        HStack {
                            ProgressView()
                            Text("接続を確認しています…")
                                .foregroundStyle(.secondary)
                        }
                    } else if tokens.isEmpty {
                        ContentUnavailableView(
                            "まだ接続していません",
                            systemImage: "link.badge.plus",
                            description: Text("新しい接続を作ると、設定用tokenを一度だけ表示します。")
                        )
                    } else {
                        ForEach(tokens) { token in
                            HStack(spacing: 12) {
                                Image(systemName: "cpu")
                                    .foregroundStyle(.tint)
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(token.name)
                                        .font(.body.weight(.semibold))
                                    Text(token.lastUsedAt.map {
                                        "最終利用 \($0.formatted(.relative(presentation: .named)))"
                                    } ?? "まだ利用されていません")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                }
                                Spacer()
                                Button {
                                    tokenToRevoke = token
                                    showRevocationConfirmation = true
                                } label: {
                                    Image(systemName: "trash")
                                }
                                .buttonStyle(.borderless)
                                .foregroundStyle(.red)
                                .accessibilityLabel("\(token.name)の接続を解除")
                            }
                        }
                    }
                }

                Section {
                    Button {
                        proposedName = "Hermes"
                        showCreatePrompt = true
                    } label: {
                        Label("AIエージェントを接続", systemImage: "link.badge.plus")
                            .frame(maxWidth: .infinity)
                    }
                    .disabled(isCreating || endpoint == nil)
                } footer: {
                    Text("tokenは作成直後に一度だけ表示され、サーバーにはhashだけを保存します。いつでもここから失効できます。")
                }
            }
            .navigationTitle("AI連携")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("完了") { dismiss() }
                }
            }
            .task { await load() }
            .refreshable { await load() }
            .alert("接続名", isPresented: $showCreatePrompt) {
                TextField("例: Hermes", text: $proposedName)
                Button("キャンセル", role: .cancel) {}
                Button("作成") {
                    Task { await createToken() }
                }
                .disabled(proposedName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            } message: {
                Text("どのAIへ渡したtokenか分かる名前を付けます。")
            }
            .confirmationDialog(
                "このAIとの接続を解除しますか？",
                isPresented: $showRevocationConfirmation,
                titleVisibility: .visible
            ) {
                Button("接続を解除", role: .destructive) {
                    guard let tokenToRevoke else { return }
                    Task { await revoke(tokenToRevoke) }
                }
                Button("キャンセル", role: .cancel) {}
            } message: {
                Text("解除すると、設定済みのAIはすぐに文字起こしを読めなくなります。")
            }
            .alert(
                "うまくいきませんでした",
                isPresented: Binding(
                    get: { errorMessage != nil },
                    set: { if !$0 { errorMessage = nil } }
                )
            ) {
                Button("OK", role: .cancel) { errorMessage = nil }
            } message: {
                Text(errorMessage ?? "")
            }
            .sheet(item: $reveal) { reveal in
                MCPTokenRevealView(configuration: reveal.configuration)
            }
        }
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            endpoint = try await model.mcpEndpoint()
            tokens = try await model.mcpTokens()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func createToken() async {
        let name = proposedName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, let endpoint else { return }
        isCreating = true
        defer { isCreating = false }
        do {
            let created = try await model.createMCPToken(name: name)
            tokens.insert(created.item, at: 0)
            reveal = MCPReveal(configuration: MCPAgentConfiguration(endpoint: endpoint, token: created.token))
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func revoke(_ token: MCPToken) async {
        do {
            try await model.revokeMCPToken(id: token.id)
            tokens.removeAll { $0.id == token.id }
        } catch {
            errorMessage = error.localizedDescription
        }
        tokenToRevoke = nil
    }
}

private struct MCPReveal: Identifiable {
    let id = UUID()
    let configuration: MCPAgentConfiguration
}

private struct MCPTokenRevealView: View {
    @Environment(\.dismiss) private var dismiss
    let configuration: MCPAgentConfiguration
    @State private var copiedMessage: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    VStack(alignment: .leading, spacing: 10) {
                        Image(systemName: "checkmark.seal.fill")
                            .font(.system(size: 42))
                            .foregroundStyle(.green)
                            .symbolEffect(.bounce)
                        Text("接続の準備ができました")
                            .font(.title.weight(.bold))
                        Text("このtokenは閉じると二度と表示できません。まず下のボタンからAIへ設定を依頼してください。")
                            .foregroundStyle(.secondary)
                            .lineSpacing(3)
                    }

                    VStack(alignment: .leading, spacing: 8) {
                        Text("一度だけ表示されるtoken")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                        Text(configuration.token)
                            .font(.caption.monospaced())
                            .textSelection(.enabled)
                            .privacySensitive()
                            .padding(14)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(.quaternary, in: .rect(cornerRadius: 14))
                    }

                    ShareLink(item: configuration.agentSetupPrompt) {
                        Label("AIに設定を頼む", systemImage: "square.and.arrow.up")
                            .font(.headline)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 5)
                    }
                    .buttonStyle(.glassProminent)

                    Button {
                        copy(configuration.agentSetupPrompt, message: "設定依頼文をコピーしました")
                    } label: {
                        Label("設定依頼文をコピー", systemImage: "doc.on.doc")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.glass)

                    DisclosureGroup("手動設定") {
                        VStack(alignment: .leading, spacing: 16) {
                            configurationBlock("JSON", text: configuration.genericJSON)
                            configurationBlock("Hermes YAML", text: configuration.hermesYAML)
                        }
                        .padding(.top, 12)
                    }

                    if let copiedMessage {
                        Label(copiedMessage, systemImage: "checkmark")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(.green)
                            .frame(maxWidth: .infinity)
                            .transition(.opacity.combined(with: .scale))
                    }
                }
                .padding(22)
            }
            .navigationTitle("MCP接続")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("閉じる") { dismiss() }
                }
            }
        }
        .sensoryFeedback(.success, trigger: copiedMessage)
    }

    @ViewBuilder
    private func configurationBlock(_ title: String, text: String) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack {
                Text(title)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                Spacer()
                Button("コピー") { copy(text, message: "\(title)をコピーしました") }
                    .font(.caption.weight(.semibold))
            }
            Text(text)
                .font(.caption2.monospaced())
                .textSelection(.enabled)
                .privacySensitive()
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.quaternary, in: .rect(cornerRadius: 12))
        }
    }

    private func copy(_ text: String, message: String) {
        UIPasteboard.general.string = text
        withAnimation(.snappy) { copiedMessage = message }
    }
}
