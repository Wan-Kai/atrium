import AtriumProtocol
import Foundation

/// Decodes one host message from its JSON text, as it comes off the wire.
///
/// - Remark: Tests write messages as JSON so they read like what the host sends; a fixture that
///   does not decode is a broken test, so it traps.
/// - SideEffects: none
/// - Parameter json: The message.
/// - Returns: The message.
func host(_ json: String) -> HostMessage {
  do {
    return try JSONDecoder().decode(HostMessage.self, from: Data(json.utf8))
  } catch {
    fatalError("fixture does not decode: \(error)\n\(json)")
  }
}

/// Takes the session event out of a host message.
///
/// - Remark: For tests of ``SessionState`` written as JSON.
/// - SideEffects: none
/// - Parameter json: A session event.
/// - Returns: The event.
func event(_ json: String) -> SessionEvent {
  guard case .sessionEvent(let event) = host(json) else { fatalError("not a session event: \(json)") }
  return event
}

/// A finished turn, as JSON.
///
/// - Remark: Steps are given as JSON too.
/// - SideEffects: none
/// - Parameters:
///   - id: Its id.
///   - text: The user's message.
///   - steps: Its steps.
///   - outcome: How it ended, or `running`.
/// - Returns: The JSON.
func turnJSON(_ id: String, text: String = "q", steps: [String] = [], outcome: String = "done") -> String {
  let duration = outcome == "running" ? "null" : "1"
  return """
    {"kind":"turn","id":"\(id)","source":null,
    "user":{"text":"\(text)","images":0,"clientMessageId":null,"auto":false,"command":null,"timestamp":1},
    "steps":[\(steps.joined(separator: ","))],"outcome":"\(outcome)","error":null,"startedAt":1,
    "durationMs":\(duration),"usage":null,"changes":[]}
    """
}

/// A compaction notice, as JSON.
///
/// - Remark: The simplest notice.
/// - SideEffects: none
/// - Parameter id: Its id.
/// - Returns: The JSON.
func noticeJSON(_ id: String) -> String {
  """
  {"kind":"notice","id":"\(id)","notice":"compacted","tokensBefore":1,"tokensAfter":null,"summary":"","timestamp":0}
  """
}

/// A session snapshot, as JSON.
///
/// - Remark: Idle, with the default control and unknown figures.
/// - SideEffects: none
/// - Parameters:
///   - sessionId: The session.
///   - epoch: Its epoch.
///   - seq: Its seq.
///   - items: The items, as JSON.
///   - exited: Whether pi has exited.
///   - hasOlder: Whether older items exist.
/// - Returns: The JSON.
func snapshotJSON(
  _ sessionId: String = "s1", epoch: Int = 1, seq: Int = 0, items: [String] = [], exited: Bool = false,
  hasOlder: Bool = false
) -> String {
  """
  {"type":"session_snapshot","sessionId":"\(sessionId)","epoch":\(epoch),"seq":\(seq),"traceId":null,
  "stream":"st-1","items":[\(items.joined(separator: ","))],"hasOlder":\(hasOlder),"run":null,
  "exited":\(exited),"control":\(controlJSON),"model":null,"fast":false,"metrics":\(metricsJSON)}
  """
}

/// The run control of an idle session, as JSON.
let controlJSON = """
  {"queue":[],"deliveries":[],"deliveriesHeld":null,"paused":null,"steers":[],"stopping":false,\
  "restarting":false,"compacting":false,"interactions":[],"question":null,"failure":null}
  """

/// Status bar figures nobody knows yet, as JSON.
let metricsJSON = """
  {"turns":null,"steps":null,"tokens":null,"cost":null,"reasoning":null,"branchTokens":0,"context":null,\
  "timing":null,"children":null}
  """

/// A list snapshot, as JSON.
///
/// - Remark: Default preferences and an empty layout; the collections are given as JSON.
/// - SideEffects: none
/// - Parameters:
///   - generation: The host instance.
///   - seq: Its list position.
///   - projects: The projects.
///   - workspaces: The workspaces.
///   - chats: The chats.
///   - sessions: The sessions.
/// - Returns: The JSON.
func indexSnapshotJSON(
  generation: String = "h1", seq: Int = 0, projects: [String] = [], workspaces: [String] = [],
  chats: [String] = [], sessions: [String] = []
) -> String {
  """
  {"type":"index_snapshot","generation":"\(generation)","seq":\(seq),"reason":"no_cursor",\
  "projects":[\(projects.joined(separator: ","))],"workspaces":[\(workspaces.joined(separator: ","))],\
  "chats":[\(chats.joined(separator: ","))],"directions":[],"sessions":[\(sessions.joined(separator: ","))],\
  "layout":{"container":null,"tabs":{}},"preferences":\(preferencesJSON),"resets":[],"learningDir":"~/Atrium/Learning"}
  """
}

/// List changes, as JSON.
///
/// - Remark: Collections not given are unchanged.
/// - SideEffects: none
/// - Parameters:
///   - generation: The host instance.
///   - seq: Its list position.
///   - sessions: Sessions that changed.
///   - removed: Sessions that went.
///   - projects: Projects that changed.
/// - Returns: The JSON.
func indexChangesJSON(
  generation: String = "h1", seq: Int, sessions: [String] = [], removed: [String] = [], projects: [String] = []
) -> String {
  let gone = removed.map { "\"\($0)\"" }.joined(separator: ",")
  return """
    {"type":"index_changes","generation":"\(generation)","seq":\(seq),\
    "projects":{"upsert":[\(projects.joined(separator: ","))],"remove":[]},\
    "workspaces":{"upsert":[],"remove":[]},"chats":{"upsert":[],"remove":[]},"directions":{"upsert":[],"remove":[]},\
    "sessions":{"upsert":[\(sessions.joined(separator: ","))],"remove":[\(gone)]},"layout":null,"preferences":null}
    """
}

/// Preferences as a new install has them, as JSON.
let preferencesJSON = """
  {"setupDone":true,"appearance":"system","lastModel":null,"thinkingByModel":{},"lastFast":false,\
  "statusBar":{},"titleModel":null,"proxy":null,"inbox":true,"translationLanguage":"简体中文"}
  """

/// A project, as JSON.
///
/// - Remark: Without a main branch.
/// - SideEffects: none
/// - Parameters:
///   - id: Its id.
///   - name: Its name.
/// - Returns: The JSON.
func projectJSON(_ id: String, name: String) -> String {
  #"{"id":"\#(id)","path":"/work/\#(name)","name":"\#(name)","mainBranch":null}"#
}

/// A workspace, as JSON.
///
/// - Remark: The project's own directory unless a branch is given, which makes it a worktree.
/// - SideEffects: none
/// - Parameters:
///   - id: Its id.
///   - project: Its project.
///   - branch: Its branch.
///   - alias: The name it was given.
/// - Returns: The JSON.
func workspaceJSON(_ id: String, project: String, branch: String? = nil, alias: String? = nil) -> String {
  let kind = branch == nil ? "local" : "worktree"
  let branchValue = branch.map { "\"\($0)\"" } ?? "null"
  let aliasValue = alias.map { "\"\($0)\"" } ?? "null"
  return """
    {"id":"\(id)","projectId":"\(project)","kind":"\(kind)","dir":"/work/\(id)","alias":\(aliasValue),\
    "branch":\(branchValue),"head":null,"external":false,"createdAt":null,"merge":null,"archivedAt":null}
    """
}

/// A chat, as JSON.
///
/// - Remark: Not archived, not pinned.
/// - SideEffects: none
/// - Parameters:
///   - id: Its id.
///   - pinnedAt: When it was pinned, for the ordering by pinning.
/// - Returns: The JSON.
func chatJSON(_ id: String, pinnedAt: Int? = nil) -> String {
  #"{"id":"\#(id)","dir":"/chats/\#(id)","alias":null,"firstSessionId":null,"archivedAt":null,"pinnedAt":\#(pinnedAt.map(String.init) ?? "null")}"#
}

/// A session summary on the list, as JSON.
///
/// - Remark: Persisted, idle and not archived unless the fields say otherwise.
/// - SideEffects: none
/// - Parameters:
///   - id: The session.
///   - container: Its workspace or chat.
///   - name: pi's name for it.
///   - prompt: Its first message.
///   - extra: Fields that replace the defaults, as `"key":value` pairs.
/// - Returns: The JSON.
func summaryJSON(
  _ id: String, in container: String, name: String? = nil, prompt: String? = nil, extra: [String: String] = [:]
) -> String {
  var fields: [String: String] = [
    "sessionId": "\"\(id)\"", "containerId": "\"\(container)\"",
    "name": name.map { "\"\($0)\"" } ?? "null", "prompt": prompt.map { "\"\($0)\"" } ?? "null",
    "file": "null", "state": "\"persisted\"", "updatedAt": "1", "archived": "false", "running": "false",
    "attention": "null", "asking": "null", "question": "null", "model": "null", "parent": "null",
    "agent": "null", "heldDeliveries": "0", "study": "null",
  ]
  fields.merge(extra) { _, new in new }
  return "{" + fields.sorted { $0.key < $1.key }.map { "\"\($0.key)\":\($0.value)" }.joined(separator: ",") + "}"
}
