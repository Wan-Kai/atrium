import AtriumProtocol

/// Decides whether the app can talk to a host after the handshake.
///
/// - Remark: The app and the host must speak the same protocol version (the handshake's purpose,
///   SPEC-0001 "握手与心跳"); on a mismatch the app says so and offers no retry (design-language
///   "手机端 · 首页"). The generated `protocolVersion` is the one the app was built with.
public enum ProtocolCheck {
  /// Tells whether the host's welcome speaks this app's protocol version.
  ///
  /// - Remark: There is no range of compatible versions; any change bumps the version.
  /// - SideEffects: none
  /// - Parameter welcome: The host's handshake reply.
  /// - Returns: Whether the versions are equal.
  public static func isCompatible(_ welcome: WelcomeMessage) -> Bool {
    welcome.protocolVersion == AtriumProtocol.protocolVersion
  }
}
