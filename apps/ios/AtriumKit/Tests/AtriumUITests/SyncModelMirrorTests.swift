import AtriumProtocol
import AtriumSync
import Foundation
import Observation
import Synchronization
import Testing

@testable import AtriumUI

/// What the home reads from the sync model, kept apart from the conversations' updates.
///
/// - Remark: The home stays under every pushed page; when it read the whole core, each streamed
///   fragment rebuilt its list (the phone's trace, 2026-10-29: ~10% of the main thread).
@MainActor
@Suite("Sync model mirrors")
struct SyncModelMirrorTests {
  /// Hands host JSON to a model's core.
  ///
  /// - Remark: Through the real `SyncCore.receive`, as the gallery does.
  /// - SideEffects: Replaces the model's core.
  /// - Parameters:
  ///   - model: The model.
  ///   - json: The host message.
  /// - Throws: When the JSON does not decode.
  private func receive(_ model: SyncModel, _ json: String) throws {
    var core = model.core
    _ = core.receive(try JSONDecoder().decode(HostMessage.self, from: Data(json.utf8)), generation: 1)
    model.adopt(core: core, status: .connected)
  }

  /// Whether reading a value registers a change after an update.
  ///
  /// - Remark: `withObservationTracking` fires once for the first change of what was read.
  /// - SideEffects: Runs the update.
  /// - Parameters:
  ///   - read: Reads the observed values.
  ///   - update: Changes the model.
  /// - Returns: Whether the read values were reported changed.
  /// - Throws: What the update throws.
  private func notifies(_ read: () -> Void, after update: () throws -> Void) rethrows -> Bool {
    let fired = Mutex(false)
    withObservationTracking(read) { fired.withLock { $0 = true } }
    try update()
    return fired.withLock { $0 }
  }

  /// Checks a streamed fragment in an open session neither rebuilds the home list nor reports it.
  ///
  /// - Remark: The step lands in session `s1`; the list does not change.
  /// - SideEffects: none
  /// - Throws: When the sample JSON does not decode.
  @Test func streamingLeavesTheHomeAlone() throws {
    let model = GallerySync.model()
    let homeBefore = model.home
    let builds = model.homeBuilds
    let fired = try notifies(
      { _ = (model.home, model.stale, model.indexReady, model.changes) },
      after: {
        try receive(
          model,
          #"{"type":"step_added","sessionId":"s1","epoch":1,"seq":1,"traceId":null,"turnId":"t2","step":{"kind":"text","id":"x","text":"好"}}"#
        )
      })
    #expect(!fired)
    #expect(model.home == homeBefore)
    #expect(model.homeBuilds == builds)
  }

  /// Checks a change to the list rebuilds the home and reports it.
  ///
  /// - Remark: An emptied list leaves no projects.
  /// - SideEffects: none
  /// - Throws: When the sample JSON does not decode.
  @Test func listChangesRebuildTheHome() throws {
    let model = GallerySync.model()
    #expect(!model.home.projects.isEmpty)
    let fired = try notifies(
      { _ = model.home },
      after: {
        try receive(
          model,
          #"{"type":"index_snapshot","generation":"h1","seq":1,"reason":"no_cursor","projects":[],"workspaces":[],"chats":[],"sessions":[],"layout":{"container":null,"tabs":{}},"preferences":{"setupDone":true,"appearance":"system","lastModel":null,"thinkingByModel":{},"lastFast":false,"statusBar":{},"titleModel":null,"proxy":null,"inbox":true,"translationLanguage":"简体中文"},"resets":[]}"#
        )
      })
    #expect(fired)
    #expect(model.home.projects.isEmpty)
    #expect(model.home == HomeList(model.core.index))
  }
}
