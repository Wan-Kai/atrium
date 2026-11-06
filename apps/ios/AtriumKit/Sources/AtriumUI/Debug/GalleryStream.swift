#if DEBUG && os(iOS)
  import AtriumProtocol
  import AtriumSync
  import Foundation
  import SwiftUI

  /// The real session page while a long reply streams in, for measuring how smoothly it draws.
  ///
  /// - Remark: Four finished turns, then the running one gets a text step whose words arrive a few
  ///   characters every 33 ms, as a Mac relays a model's output, through the real `SyncCore.receive`.
  ///   It loops, so a profiler can record any stretch of it. Sample words only.
  struct GalleryStream: View {
    /// The sample connection, its open session with history.
    @State private var sync = GallerySync.model(history: 4)
    /// The clock the fragments and reports are paced on.
    private let clock = ContinuousClock()

    /// The page, fed while shown.
    var body: some View {
      NavigationStack { SessionPage(sessionId: GallerySync.openSession) }
        .environment(sync)
        .task { await feed() }
        .task { await measure() }
    }

    /// Prints the frame and redraw counts every five seconds, until cancelled.
    ///
    /// - Remark: Read from the simulator's console; counts only, no content.
    /// - SideEffects: Runs a display link; prints.
    private func measure() async {
      let probe = GalleryFrameProbe(clock: clock)
      defer { probe.stop() }
      while !Task.isCancelled {
        probe.start()
        try? await clock.sleep(for: .seconds(5))
        print(probe.summary(prefix: "stream"))
      }
    }

    /// Streams the sample reply into the running turn, over and over, until cancelled.
    ///
    /// - Remark: Each round adds a new text step, so the reply restarts without a new snapshot.
    /// - SideEffects: Replaces the model's core on every tick.
    private func feed() async {
      var seq = 0
      var round = 0
      let words = Array(GalleryMarkdown.sample + "\n\n" + GalleryMarkdown.sample)
      while !Task.isCancelled {
        round += 1
        let step = "stream-\(round)"
        seq += 1
        receive(
          #"{"type":"step_added","sessionId":"s1","epoch":1,"seq":\#(seq),"traceId":null,"turnId":"t2","step":{"kind":"text","id":"\#(step)","text":""}}"#
        )
        var at = 0
        while at < words.count, !Task.isCancelled {
          let piece = String(words[at..<min(words.count, at + 4)])
          at += 4
          seq += 1
          let delta = String(decoding: (try? JSONEncoder().encode(piece)) ?? Data(#""""#.utf8), as: UTF8.self)
          receive(
            #"{"type":"step_delta","sessionId":"s1","epoch":1,"seq":\#(seq),"traceId":null,"turnId":"t2","stepId":"\#(step)","delta":\#(delta)}"#
          )
          try? await clock.sleep(for: .milliseconds(33))
        }
      }
    }

    /// Hands one host message to the core and shows the result.
    ///
    /// - Remark: A message that does not decode is a broken sample, so it traps.
    /// - SideEffects: Replaces the model's core.
    /// - Parameter json: The host message.
    private func receive(_ json: String) {
      var core = sync.core
      do {
        _ = core.receive(try JSONDecoder().decode(HostMessage.self, from: Data(json.utf8)), generation: 1)
      } catch {
        fatalError("stream sample does not decode: \(error)")
      }
      sync.adopt(core: core, status: .connected)
    }
  }
#endif
