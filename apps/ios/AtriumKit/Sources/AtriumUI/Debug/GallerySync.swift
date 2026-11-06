#if DEBUG
  import AtriumProtocol
  import AtriumRemote
  import AtriumSync
  import CryptoKit
  import Foundation
  import SwiftUI

  /// A secret store that keeps nothing, for a connection that is never started.
  ///
  /// - Remark: The gallery needs a `RemoteConnection` only because `SyncModel` holds one.
  private struct EmptySecretStore: SecretStore {
    /// Reads nothing.
    ///
    /// - Remark: Part of the gallery sample; see the type.
    /// - SideEffects: none
    func read(_ account: String) throws(StoreError) -> Data? { nil }

    /// Writes nothing.
    ///
    /// - Remark: Part of the gallery sample; see the type.
    /// - SideEffects: none
    func write(_ account: String, _ data: Data) throws(StoreError) {}

    /// Deletes nothing.
    ///
    /// - Remark: Part of the gallery sample; see the type.
    /// - SideEffects: none
    func delete(_ account: String) throws(StoreError) {}

    /// Lists nothing.
    ///
    /// - Remark: Part of the gallery sample; see the type.
    /// - SideEffects: none
    func accounts() throws(StoreError) -> [String] { [] }
  }

  /// Sample sync data for the gallery's connected screens: two projects, workspaces, sessions, a
  /// model catalog and a workspace the Mac cannot find.
  ///
  /// - Remark: The data goes through the real `SyncCore.receive`, as host JSON, so the screens read
  ///   what a live Mac would give them. Sample words only.
  @MainActor
  enum GallerySync {
    /// The workspace the sample Mac cannot find.
    static let missingWorkspace = "w4"
    /// The open session the model sheet is for.
    static let openSession = "s1"

    /// A workspace, as JSON.
    ///
    /// - Remark: `merged` and `branch` are the only fields that vary.
    /// - SideEffects: none
    private static func workspace(
      _ id: String, _ project: String, branch: String, local: Bool = false, merged: Bool = false
    )
      -> String
    {
      let merge = merged ? #"{"dirty":false,"ahead":0,"verdict":"merged","reason":null}"# : "null"
      return """
        {"id":"\(id)","projectId":"\(project)","kind":"\(local ? "local" : "worktree")","dir":"/work/\(id)","alias":null,\
        "branch":"\(branch)","head":null,"external":false,"createdAt":null,"merge":\(merge),"archivedAt":null}
        """
    }

    /// A session summary, as JSON.
    ///
    /// - Remark: Part of the gallery sample; see the type.
    /// - SideEffects: none
    private static func session(_ id: String, in container: String, prompt: String, updated: Int) -> String {
      """
      {"sessionId":"\(id)","containerId":"\(container)","name":null,"prompt":"\(prompt)","file":null,\
      "state":"persisted","updatedAt":\(updated),"archived":false,"running":false,"attention":null,"asking":null,\
      "handedOff":false,"model":null,"parent":null,"agent":null,"heldDeliveries":0,"study":null}
      """
    }

    /// The list: two projects, five workspaces (one merged), recent sessions.
    private static let index = """
      {"type":"index_snapshot","generation":"h1","seq":0,"reason":"no_cursor",\
      "projects":[{"id":"p1","path":"/work/weather-app","name":"weather-app","mainBranch":"main"},\
      {"id":"p2","path":"/work/atrium","name":"atrium","mainBranch":"main"}],\
      "workspaces":[\(workspace("w1", "p1", branch: "main", local: true)),\
      \(workspace("w2", "p1", branch: "fix/cache-ttl")),\
      \(workspace("w3", "p1", branch: "feat/old-radar", merged: true)),\
      \(workspace("w4", "p2", branch: "feat/radar-layer")),\
      \(workspace("w5", "p2", branch: "main", local: true))],\
      "chats":[],"directions":[],"sessions":[\(session("s1", in: "w1", prompt: "修一下缓存过期", updated: 50)),\
      \(session("s2", in: "w2", prompt: "把 TTL 改成可配置", updated: 40)),\
      \(session("s3", in: "w5", prompt: "整理 README", updated: 30))],\
      "layout":{"container":null,"tabs":{}},"preferences":{"setupDone":true,"appearance":"system","lastModel":null,\
      "thinkingByModel":{},"lastFast":false,"statusBar":{},"titleModel":null,"proxy":null,"inbox":true,\
      "translationLanguage":"简体中文"},"resets":[],"learningDir":"~/Atrium/Learning"}
      """

    /// The open session's snapshot: idle, on a model with a thinking level and Fast on.
    private static let snapshot = """
      {"type":"session_snapshot","sessionId":"s1","epoch":1,"seq":0,"traceId":null,"stream":"st-1","items":[],\
      "hasOlder":false,"run":null,"exited":false,"control":{"queue":[],"deliveries":[],"deliveriesHeld":null,\
      "paused":null,"steers":[],"stopping":false,"restarting":false,"compacting":false,"interactions":[],\
      "question":null,"failure":null},\
      "model":{"providerId":"openai-codex","modelId":"gpt-6","thinkingLevel":"high"},"fast":true,\
      "metrics":{"turns":null,"steps":null,"tokens":null,"cost":null,"reasoning":null,"branchTokens":0,\
      "context":null,"timing":null,"children":null}}
      """

    /// One catalog model, as JSON.
    ///
    /// - Remark: Part of the gallery sample; see the type.
    /// - SideEffects: none
    private static func model(
      _ provider: String, _ id: String, _ name: String, context: Int, output: Int, levels: [String], fast: Bool
    ) -> String {
      let quoted = levels.map { "\"\($0)\"" }.joined(separator: ",")
      return """
        {"providerId":"\(provider)","modelId":"\(id)","name":"\(name)","contextWindow":\(context),"maxOutput":\(output),\
        "supportsImage":true,"thinkingLevels":[\(quoted)],"fast":\(fast ? #"{"speed":2,"moreUsage":true}"# : "null")}
        """
    }

    /// A `list_models` answer for a request, as JSON.
    ///
    /// - Remark: Part of the gallery sample; see the type.
    /// - SideEffects: none
    private static func models(_ requestId: String) -> String {
      let all = [
        model(
          "anthropic", "opus", "Claude Opus", context: 200_000, output: 32_000, levels: ["off", "low", "high"],
          fast: false),
        model(
          "anthropic", "sonnet", "Claude Sonnet", context: 200_000, output: 64_000,
          levels: ["off", "low", "medium", "high"], fast: false),
        model(
          "openai-codex", "gpt-6", "GPT-6", context: 400_000, output: 128_000,
          levels: ["low", "medium", "high", "xhigh"], fast: true),
        model(
          "openai-codex", "gpt-6-mini", "GPT-6 mini", context: 272_000, output: 64_000,
          levels: ["low", "medium", "high"], fast: false),
        model(
          "github-copilot", "claude-sonnet", "Claude Sonnet", context: 128_000, output: 16_000,
          levels: ["off", "medium"], fast: false),
        model(
          "github-copilot", "gpt-5", "GPT-5", context: 128_000, output: 16_000, levels: ["low", "medium", "high"],
          fast: false),
        model("deepseek", "chat", "DeepSeek Chat", context: 128_000, output: 8_000, levels: ["off"], fast: false),
        model(
          "deepseek", "reasoner", "DeepSeek Reasoner", context: 128_000, output: 32_000, levels: ["high"], fast: false),
      ]
      return """
        {"type":"response","requestId":"\(requestId)","ok":true,"result":{"models":[\(all.joined(separator: ","))],\
        "defaultModel":{"providerId":"anthropic","modelId":"sonnet"}}}
        """
    }

    /// Decodes host JSON, trapping on a broken fixture.
    ///
    /// - Remark: A fixture that does not decode is a bug, so it traps.
    /// - SideEffects: none
    private static func host(_ json: String) -> HostMessage {
      do { return try JSONDecoder().decode(HostMessage.self, from: Data(json.utf8)) } catch {
        fatalError("gallery fixture does not decode: \(error)")
      }
    }

    /// Makes a connected sync model around a synced sample core.
    ///
    /// - Remark: Replays what a Mac would send: the list, the open session, optionally a failed
    ///   `create_session` that marks `w4` missing, and a model catalog for one place. Request ids
    ///   count r1, r2, … as in the sync tests. The connection is never started.
    /// - SideEffects: Makes a stand-in connection; nothing is sent.
    /// - Parameters:
    ///   - missing: Whether `w4` is marked as not found.
    ///   - modelsFor: The workspace whose models are answered.
    /// - Returns: The model, status connected.
    static func model(missing: Bool = false, modelsFor: String? = nil) -> SyncModel {
      var next = 0
      var core = SyncCore(
        requestId: {
          next += 1
          return "r\(next)"
        },
        traceparent: { "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01" }, now: { .zero })
      _ = core.open(openSession)
      _ = core.connected(generation: 1)
      let ok = { (id: String) in #"{"type":"response","requestId":"\#(id)","ok":true,"result":{}}"# }
      for json in [ok("r1"), index, ok("r2"), ok("r3"), snapshot] {
        _ = core.receive(host(json), generation: 1)
      }
      if missing {
        _ = core.startSession(in: missingWorkspace, chat: false, text: "x", images: [])
        let failure = #"{"type":"response","requestId":"r4","ok":false,"error":{"code":"workspace_not_found"}}"#
        _ = core.receive(host(failure), generation: 1)
      }
      if let modelsFor {
        _ = core.listModels(workspaceId: modelsFor, refresh: false)
        _ = core.receive(host(models("r\(next)")), generation: 1)
      }
      let connection = RemoteConnection(
        host: HostRecord(
          hostId: "gallery", relay: URL(filePath: "/relay.example.net"), hostKey: Data(count: 32),
          hostName: "Kai 的 Mac"),
        deviceKey: Curve25519.KeyAgreement.PrivateKey(), store: HostStore(EmptySecretStore()),
        environment: .live(appVersion: "0.1.0"))
      let model = SyncModel(
        connection: connection, hostName: "Kai 的 Mac", traceparent: { "" }, now: { .zero }, requestId: { "" })
      model.adopt(core: core, status: .connected)
      return model
    }
  }
#endif
