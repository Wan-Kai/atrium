import AtriumProtocol
import AtriumSync
import Testing

/// The host's answer to a `create_session` or `create_chat`, as JSON.
///
/// - Remark: With the new session's id.
/// - SideEffects: none
/// - Parameters:
///   - requestId: The request it answers.
///   - sessionId: The new session.
/// - Returns: The JSON.
func createdOK(_ requestId: String, _ sessionId: String) -> String {
  #"{"type":"response","requestId":"\#(requestId)","ok":true,"result":{"sessionId":"\#(sessionId)"}}"#
}

@Suite("Sync core: new sessions")
struct SyncStartTests {
  @Test("creates a session in a workspace, then opens it and sends the first message with its receipt")
  func workspace() {
    var sync = syncedCore()
    #expect(
      sync.startSession(in: "w1", chat: false, text: "修缓存", images: []) == [
        .send(
          .createSession(CreateSessionCommand(requestId: "r4", traceparent: traceparent, containerId: "w1")),
          generation: 1)
      ])
    #expect(sync.starting)
    #expect(sync.startSession(in: "w1", chat: false, text: "again", images: []) == [])
    let outputs = receive(&sync, generation: 1, createdOK("r4", "s9"))
    #expect(sync.started == "s9")
    #expect(!sync.starting)
    #expect(sync.openSessions.contains("s9"))
    #expect(outputs.last == .send(promptCommand("r7", "修缓存", session: "s9"), generation: 1))
    #expect(sync.outbox.map(\.sessionId) == ["s9"])
  }

  @Test("creates a chat with create_chat")
  func chat() {
    var sync = syncedCore()
    #expect(
      sync.startSession(in: nil, chat: true, text: "聊聊", images: []) == [
        .send(.createChat(CreateChatCommand(requestId: "r4", traceparent: traceparent)), generation: 1)
      ])
  }

  @Test("marks a workspace the Mac cannot find, and says why the start failed")
  func missing() {
    var sync = syncedCore()
    _ = sync.startSession(in: "w1", chat: false, text: "修缓存", images: [])
    _ = receive(&sync, generation: 1, failed("r4", "workspace_not_found"))
    #expect(sync.missingContainers == ["w1"])
    #expect(sync.startFailure == .workspaceNotFound)
    #expect(sync.started == nil)
    #expect(!sync.starting)
    _ = sync.startSession(in: "w2", chat: false, text: "x", images: [])
    _ = receive(&sync, generation: 1, failed("r5", "session_cwd_missing"))
    #expect(sync.missingContainers == ["w1", "w2"])
    _ = sync.startSession(in: "w3", chat: false, text: "x", images: [])
    #expect(sync.startFailure == nil)
    _ = receive(&sync, generation: 1, failed("r6", "session_busy"))
    #expect(sync.missingContainers == ["w1", "w2"])
    #expect(sync.startFailure == .sessionBusy)
  }

  @Test("cannot tell whether a start went when the connection drops before its answer")
  func dropped() {
    var sync = syncedCore()
    _ = sync.startSession(in: "w1", chat: false, text: "修缓存", images: [])
    _ = sync.connected(generation: 2)
    #expect(!sync.starting)
    #expect(sync.startFailure == .outcomeUnknown)
  }

  @Test("does not start before the sync, nor with nothing to send")
  func notYet() {
    var sync = core()
    #expect(sync.startSession(in: "w1", chat: false, text: "x", images: []) == [])
    var synced = syncedCore()
    #expect(synced.startSession(in: "w1", chat: false, text: "  ", images: []) == [])
  }
}
