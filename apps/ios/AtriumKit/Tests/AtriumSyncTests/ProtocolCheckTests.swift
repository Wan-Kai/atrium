import AtriumProtocol
import AtriumSync
import Testing

/// Makes a welcome with the given protocol version.
///
/// - Remark: The other fields do not matter to the check.
/// - SideEffects: none
/// - Parameter version: The host's protocol version.
/// - Returns: The welcome.
func welcome(_ version: Int) -> WelcomeMessage {
  WelcomeMessage(
    protocolVersion: version, hostVersion: "0.0.0", hostInstanceId: "h1", heartbeatMs: 15_000, installSeed: 1,
    logDir: "/tmp")
}

@Suite("Protocol check")
struct ProtocolCheckTests {
  @Test("talks to a host with the same protocol version, and to no other")
  func versions() {
    #expect(ProtocolCheck.isCompatible(welcome(protocolVersion)))
    #expect(!ProtocolCheck.isCompatible(welcome(protocolVersion + 1)))
    #expect(!ProtocolCheck.isCompatible(welcome(protocolVersion - 1)))
  }
}
