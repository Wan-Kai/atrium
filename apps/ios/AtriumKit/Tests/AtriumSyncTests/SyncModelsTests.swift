import AtriumProtocol
import AtriumSync
import Testing

/// A `list_models` answer with two models, as JSON.
///
/// - Remark: The second has Fast and three levels.
/// - SideEffects: none
/// - Parameter requestId: The request it answers.
/// - Returns: The JSON.
func modelsOK(_ requestId: String) -> String {
  let a =
    #"{"providerId":"anthropic","modelId":"opus","name":"Opus","contextWindow":200000,"maxOutput":32000,"supportsImage":true,"thinkingLevels":["off"],"fast":null}"#
  let b =
    #"{"providerId":"openai","modelId":"sol","name":"Sol","contextWindow":400000,"maxOutput":128000,"supportsImage":true,"thinkingLevels":["low","medium","high"],"fast":{"speed":2,"moreUsage":true}}"#
  return
    #"{"type":"response","requestId":"\#(requestId)","ok":true,"result":{"models":[\#(a),\#(b)],"defaultModel":{"providerId":"openai","modelId":"sol"}}}"#
}

@Suite("Sync core: models")
struct SyncModelsTests {
  @Test("lists the models for a workspace and keeps the catalog and the default")
  func catalog() {
    var sync = syncedCore()
    #expect(
      sync.listModels(workspaceId: "w1", refresh: true) == [
        .send(
          .listModels(ListModelsCommand(requestId: "r4", traceparent: traceparent, workspaceId: "w1", refresh: true)),
          generation: 1)
      ])
    _ = receive(&sync, generation: 1, modelsOK("r4"))
    #expect(sync.models?.models.map(\.modelId) == ["opus", "sol"])
    #expect(sync.models?.defaultModel == ModelRef(providerId: "openai", modelId: "sol"))
  }

  @Test("does not ask for models before the sync")
  func notYet() {
    var sync = core()
    #expect(sync.listModels(workspaceId: nil, refresh: false) == [])
  }

  @Test("sets a session's model, level and Fast")
  func set() {
    var sync = syncedCore()
    #expect(
      sync.perform(.setModel(ModelRef(providerId: "openai", modelId: "sol")), in: "s1") == [
        .send(
          .setModel(
            SetModelCommand(
              requestId: "r4", traceparent: traceparent, sessionId: "s1", providerId: "openai", modelId: "sol")),
          generation: 1)
      ])
    #expect(
      sync.perform(.setThinkingLevel(.high), in: "s1") == [
        .send(
          .setThinkingLevel(
            SetThinkingLevelCommand(requestId: "r5", traceparent: traceparent, sessionId: "s1", level: .high)),
          generation: 1)
      ])
    #expect(
      sync.perform(.setFast(true), in: "s1") == [
        .send(
          .setFast(SetFastCommand(requestId: "r6", traceparent: traceparent, sessionId: "s1", enabled: true)),
          generation: 1)
      ])
  }
}
