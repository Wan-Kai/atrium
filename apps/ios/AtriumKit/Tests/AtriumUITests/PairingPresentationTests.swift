import AtriumRemote
import AtriumTestSupport
import Foundation
import SwiftUI
import Testing

@testable import AtriumUI

/// Checks platform-independent presentation boundaries used by the real scanner and status labels.
///
/// - Remark: Camera hardware and the wall clock are not needed to verify payload routing or dates.
@Suite("Pairing presentation")
struct PairingPresentationTests {
  @Test("irrelevant QR codes do not consume the scanner's one delivery")
  func scannerCandidates() {
    var capture = PairingCodeCapture()
    #expect(capture.accept("https://example.com") == nil)
    #expect(capture.accept("atrium://other?token=private") == nil)
    #expect(capture.accept("not a URL") == nil)
    let valid = TestHost().linkText
    #expect(capture.accept(valid) == valid)
    #expect(capture.accept(valid) == nil)
    // Candidate validation belongs to PairingLink, not the camera; even missing fields are forwarded.
    var incomplete = PairingCodeCapture()
    #expect(incomplete.accept("atrium://pair?incomplete") == "atrium://pair?incomplete")
  }

  @Test("the authenticated wire rejection is shown as a Mac refusal, not a network failure")
  func wireRejectionMessage() async throws {
    let host = TestHost()
    let relay = MemoryRelay()
    let store = HostStore(MemorySecretStore())
    try store.confirm(host.record, deviceId: host.deviceId)
    let clock = ManualClock()
    let stopwatch = Stopwatch(clock)
    let environment = RemoteEnvironment(
      connect: { relay.connect($0) }, stopwatch: stopwatch, jitter: { 0 }, appVersion: "1")
    let flow = PairingFlow(
      environment: environment, store: store,
      device: DeviceInfo(deviceName: "Phone", model: "M", appVersion: "1"))
    let link = try PairingLink(host.linkText)
    try await withThrowingTaskGroup(of: PairingOutcome.self) { group in
      group.addTask { await flow.run(link) { _ in } }
      defer { group.cancelAll() }
      let incoming = await relay.next()
      defer { incoming.host.close() }
      let side = try await host.accept(incoming.host, stopwatch: stopwatch)
      defer { side.channel?.abort() }
      #expect(try await side.nextControl() == .pairConfirm)
      try await side.send(.pairRejected(reason: "rejected"))
      let outcome = try #require(await group.next())
      defer { outcome.channel?.abort() }
      guard case .failed(let failure) = outcome.state else {
        Issue.record("wire refusal did not fail pairing")
        return
      }
      #expect(failure == .declined)
      #expect(PairingView.message(for: failure) == "Mac 拒绝了配对，请在 Mac 上重新出码。")
      #expect(try store.pendingHosts().isEmpty)
      #expect(try store.hosts() == [host.record])
      #expect(incoming.host.isClosed)
    }
    #expect(clock.sleeperCount == 0)
  }

  @Test("offline labels retain the supplied absolute last-seen time")
  func offlineDate() throws {
    let date = Date(timeIntervalSince1970: 0)
    let locale = Locale(identifier: "en_US_POSIX")
    let zone = try #require(TimeZone(secondsFromGMT: 0))
    let home = PairingHome<EmptyView>.message(for: .hostOffline(lastSeen: date), locale: locale, timeZone: zone)
    let pairing = PairingView.message(for: .hostOffline(lastSeen: date), locale: locale, timeZone: zone)
    #expect(home == "Mac 不在线，上次在线：Jan 1, 1970 at 12:00:00\u{202f}AM")
    #expect(pairing == "Mac 不在线，上次在线：Jan 1, 1970 at 12:00:00\u{202f}AM。请打开 Mac 上的 Atrium 并检查远程连接。")
    let east = try #require(TimeZone(secondsFromGMT: 28_800))
    #expect(PairingLastSeen.message(date, locale: locale, timeZone: east) == "上次在线：Jan 1, 1970 at 8:00:00\u{202f}AM")
    #expect(
      PairingHome<EmptyView>.message(for: .hostOffline(lastSeen: nil), locale: locale, timeZone: zone)
        == "Mac 不在线，上次在线时间未知")
    #expect(PairingView.message(for: .hostOffline(lastSeen: nil), locale: locale, timeZone: zone).contains("上次在线时间未知"))
  }
}
