#if DEBUG && os(iOS)
  import AtriumProtocol
  import AtriumRender
  import AtriumSync
  import Foundation
  import Synchronization
  import SwiftUI

  /// The real session page with older turns on the Mac, answering each fetch after 0.8 s.
  ///
  /// - Remark: For checking how loading older turns scrolls: four finished turns are shown, and
  ///   every `fetch_transcript` is answered through the real `SyncCore.receive` with three more,
  ///   four times. Prints each fetch, so a test can count them from the console. Sample words only.
  struct GalleryOlder: View {
    /// The last request id the core made.
    private static let last = Mutex("")
    /// The sample connection, its open session with older turns.
    @State private var sync = GallerySync.model(history: 4, older: true) { id in last.withLock { $0 = id } }
    /// Batches answered so far.
    @State private var batches = 0
    /// The requests answered or being answered, so a restarted task does not answer one twice.
    @State private var answered: Set<String> = []
    /// The clock the answers wait on.
    private let clock = ContinuousClock()

    /// The page, answering fetches while shown.
    var body: some View {
      NavigationStack { SessionPage(sessionId: GallerySync.openSession) }
        .environment(sync)
        .task(id: sync.core.loadingOlder) { await answer() }
    }

    /// Answers the fetch on its way, if any, after 0.8 s.
    ///
    /// - Remark: Turns `o<batch>-<n>`, oldest first; the fourth batch says nothing older is left.
    /// - SideEffects: Prints; replaces the model's core.
    private func answer() async {
      guard sync.core.loadingOlder.contains(GallerySync.openSession) else { return }
      let requestId = Self.last.withLock { $0 }
      guard answered.insert(requestId).inserted else { return }
      batches += 1
      print("older fetch \(batches) \(requestId)")
      try? await clock.sleep(for: .milliseconds(800))
      guard !Task.isCancelled else { return }
      let turns = (0..<3).map { GallerySync.historyTurn(1000 - batches * 10 + $0) }
        .joined().dropLast()
      let json =
        #"{"type":"response","requestId":"\#(requestId)","ok":true,"result":{"items":[\#(turns)],"hasOlder":\#(batches < 4)}}"#
      let message: HostMessage
      do {
        message = try JSONDecoder().decode(HostMessage.self, from: Data(json.utf8))
      } catch {
        fatalError("older sample does not decode: \(error)")
      }
      // As `SyncModel` takes it: replies parsed before the turns go in.
      if let older = sync.core.olderItems(in: message) {
        await MarkdownCache.shared.warm(SyncModel.replies(older))
        await sync.rest.wait(on: clock)
      }
      var core = sync.core
      _ = core.receive(message, generation: 1)
      sync.adopt(core: core, status: .connected)
    }
  }
#endif
