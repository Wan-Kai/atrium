import AtriumProtocol
import AtriumRemote
import AtriumSync
import Foundation
import Testing

@testable import AtriumUI

@Suite("Home view")
struct HomeViewTests {
  @Test("is titled Atrium")
  func title() {
    #expect(HomeView.title == "Atrium")
  }

  @Test("shows connected in the pill only once synced, and every other status as its nearest pill")
  func pill() {
    #expect(HomeView.pill(for: .connected) == .connected)
    #expect(HomeView.pill(for: .connecting) == .syncing)
    #expect(HomeView.pill(for: .syncing) == .syncing)
    #expect(HomeView.pill(for: .reconnecting) == .reconnecting)
    #expect(HomeView.pill(for: .noNetwork) == .reconnecting)
    #expect(HomeView.pill(for: .relayUnreachable) == .relayUnreachable)
    #expect(HomeView.pill(for: .versionMismatch(hostProtocol: 27)) == .versionMismatch)
    #expect(HomeView.pill(for: .hostOffline(lastSeen: nil)) == .offline)
    #expect(HomeView.pill(for: .revoked) == .offline)
    #expect(HomeView.pill(for: .superseded) == .offline)
    #expect(HomeView.pill(for: .pairingIncomplete) == .offline)
  }

  @Test("marks a row with the icon of its status, and nothing without one")
  func rowIcon() {
    #expect(SessionRow.kind(.asking) == .asking)
    #expect(SessionRow.kind(.error) == .error)
    #expect(SessionRow.kind(.running) == .running)
    #expect(SessionRow.kind(nil) == .idle)
  }
}

@Suite("Session page")
struct SessionPageTests {
  @Test("says it is loading, that pi exited, or which code refused it, and nothing when up to date")
  func statusLine() {
    #expect(SessionPage.statusLine(nil) == "正在加载…")
    #expect(SessionPage.statusLine(.loading) == "正在加载…")
    #expect(SessionPage.statusLine(.ready) == nil)
    #expect(SessionPage.statusLine(.exited) == "pi 已退出")
    #expect(SessionPage.statusLine(.failed(.sessionCwdMissing)) == "打不开这个会话（session_cwd_missing）")
  }

  @Test("writes a notice as one line of its kind")
  func noticeLabel() throws {
    let notice = try JSONDecoder().decode(
      Notice.self,
      from: Data(#"{"kind":"notice","id":"n","notice":"restarted","attempt":1,"timestamp":0}"#.utf8))
    #expect(SessionPage.label(notice) == "pi 重启了")
  }
}

@Suite("Composer")
struct ComposerTests {
  @Test("says to write now and send later while the connection is down")
  func placeholder() {
    #expect(Composer.placeholder(connected: true) == "发消息")
    #expect(Composer.placeholder(connected: false) == "先写着，连上后再发")
  }

  @Test("says a message did not go, with the host's code when it refused it")
  func problem() {
    #expect(Composer.problemLine(.notSent) == "没发出去")
    #expect(Composer.problemLine(.refused(.sessionBusy)) == "没发出去（session_busy）")
  }
}
