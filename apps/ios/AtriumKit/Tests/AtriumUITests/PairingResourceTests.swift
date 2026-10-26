import AtriumRemote
import AtriumTestSupport
import Testing

@Suite("Pairing test resource cleanup")
struct PairingResourceTests {
  @Test(
    "throwing after start and after responder acceptance still releases actors and sleepers", arguments: [false, true])
  func throwingBody(acceptHost: Bool) async throws {
    let resources = PairingTestResources()
    let clock = ManualClock()
    var caught = false
    do {
      try await resources.run {
        let host = TestHost()
        let relay = MemoryRelay()
        let store = HostStore(MemorySecretStore())
        let stopwatch = Stopwatch(clock)
        let environment = RemoteEnvironment(
          connect: { relay.connect($0) }, stopwatch: stopwatch, jitter: { 0 }, appVersion: "1")
        let connection = RemoteConnection(
          host: host.record, deviceKey: try store.deviceKey(), store: store, environment: environment)
        await resources.register(connection, clock: clock)
        await connection.start()
        let incoming = await relay.next()
        if acceptHost {
          let side = try await host.accept(incoming.host, stopwatch: stopwatch)
          await resources.register(side.channel)
          try await side.answerHello(protocolVersion: environment.protocolVersion)
        }
        throw DeliberateFailure.afterStart
      }
    } catch DeliberateFailure.afterStart {
      caught = true
    }
    #expect(caught)
    #expect(clock.sleeperCount == 0)
  }

  /// The intentional body error, distinct from a teardown failure.
  ///
  /// - Remark: The regression must prove that cleanup preserves the original thrown error.
  private enum DeliberateFailure: Error { case afterStart }
}
