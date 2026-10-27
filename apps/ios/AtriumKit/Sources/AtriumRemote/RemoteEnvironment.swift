import AtriumProtocol
import Foundation

/// What pairing and connections need from the outside world, injected.
///
/// - Remark: Connections, time and randomness come in through here, so tests run everything with an
///   in-memory relay, a manual clock and fixed jitter (testing.md "Swift（手机端）").
public struct RemoteEnvironment: Sendable {
  /// Opens a connection to a relay endpoint.
  public var connect: @Sendable (URL) -> any RemoteTransport
  /// The injected clock.
  public var stopwatch: Stopwatch
  /// A random number in `0..<1` for the reconnect jitter.
  public var jitter: @Sendable () -> Double
  /// A fresh `traceparent` for each `hello`.
  public var traceparent: @Sendable () -> String
  /// The app's version, sent in the handshake.
  public var appVersion: String
  /// The protocol version the app speaks.
  public var protocolVersion: Int

  /// Builds an environment.
  ///
  /// - Remark: Tests pass every part.
  /// - SideEffects: none
  /// - Parameters:
  ///   - connect: Opens a connection.
  ///   - stopwatch: The clock.
  ///   - jitter: Random numbers in `0..<1`.
  ///   - traceparent: Makes trace ids.
  ///   - appVersion: The app's version.
  ///   - protocolVersion: The protocol version.
  public init(
    connect: @escaping @Sendable (URL) -> any RemoteTransport,
    stopwatch: Stopwatch,
    jitter: @escaping @Sendable () -> Double,
    traceparent: @escaping @Sendable () -> String = makeTraceparent,
    appVersion: String,
    protocolVersion: Int = AtriumProtocol.protocolVersion
  ) {
    self.connect = connect
    self.stopwatch = stopwatch
    self.jitter = jitter
    self.traceparent = traceparent
    self.appVersion = appVersion
    self.protocolVersion = protocolVersion
  }

  /// The app's environment: WebSockets, the continuous clock and system randomness.
  ///
  /// - Remark: The app target calls this once; nothing else creates real connections.
  /// - SideEffects: none
  /// - Parameter appVersion: The app's version.
  /// - Returns: The environment.
  public static func live(appVersion: String) -> RemoteEnvironment {
    RemoteEnvironment(
      connect: { WebSocketTransport(url: $0) }, stopwatch: Stopwatch(ContinuousClock()),
      jitter: { Double.random(in: 0..<1) }, appVersion: appVersion)
  }
}
