import AtriumProtocol
import AtriumSync
import Foundation
import Testing

@testable import AtriumUI

/// A list state from an `index_snapshot`.
///
/// - Remark: Built as the app builds it.
/// - SideEffects: none
/// - Parameter json: The snapshot.
/// - Returns: The state.
/// - Throws: When the JSON does not decode.
func indexState(_ json: String) throws -> IndexState {
  var state = IndexState()
  guard case .indexSnapshot(let snapshot) = try JSONDecoder().decode(HostMessage.self, from: Data(json.utf8)) else {
    Issue.record("not a list snapshot")
    return state
  }
  state.apply(snapshot)
  return state
}

@Suite("New session")
struct NewSessionTests {
  @Test("asks what to do in a branch, or what to talk about in a chat")
  func sentence() {
    #expect(NewSessionPage.sentence(branch: "fix/cache-ttl") == "在 fix/cache-ttl 里要做什么？")
    #expect(NewSessionPage.sentence(branch: nil) == "要聊点什么？")
    #expect(NewSessionPage.sentence(branch: "missing", missing: true) == "这个工作区在 Mac 上找不到了，换一个位置")
  }

  @Test("offers each project's workspaces, leaving merged ones out")
  func places() throws {
    let merged = #""merge":{"dirty":false,"ahead":0,"verdict":"merged","reason":null}"#
    let state = try indexState(
      """
      {"type":"index_snapshot","generation":"h1","seq":0,"reason":"no_cursor",\
      "projects":[{"id":"p1","path":"/w","name":"weather-app","mainBranch":null}],\
      "workspaces":[\
      {"id":"w1","projectId":"p1","kind":"local","dir":"/w","alias":null,"branch":"main","head":null,"external":false,"createdAt":null,"merge":null,"archivedAt":null},\
      {"id":"w2","projectId":"p1","kind":"worktree","dir":"/w2","alias":null,"branch":"fix","head":null,"external":false,"createdAt":null,"merge":null,"archivedAt":null},\
      {"id":"w3","projectId":"p1","kind":"worktree","dir":"/w3","alias":null,"branch":"old","head":null,"external":false,"createdAt":null,\(merged),"archivedAt":null}],\
      "chats":[],"sessions":[],"layout":{"container":null,"tabs":{}},"preferences":{"setupDone":true,\
      "appearance":"system","lastModel":null,"thinkingByModel":{},"lastFast":false,"statusBar":{},"titleModel":null,\
      "proxy":null,"inbox":true,"translationLanguage":"简体中文"},"resets":[]}
      """)
    #expect(LocationSheet.workspaces(in: state).map(\.workspaces).map { $0.map(\.id) } == [["w1", "w2"]])
  }
}
