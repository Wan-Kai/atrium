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
  @Test("says a message did not go, with the host's code when it refused it")
  func problem() {
    #expect(Composer.problemLine(.notSent) == "没发出去")
    #expect(Composer.problemLine(.refused(.sessionBusy)) == "没发出去（session_busy）")
  }
}

@Suite("Home: workspace tags")
struct WorkspaceTagTests {
  @Test("says uncommitted and how far ahead, merged over everything, and nothing for a clean branch")
  func tags() {
    #expect(WorkspaceHeader.tag(dirty: true, ahead: 3, merged: false) == "未提交 · ↑3")
    #expect(WorkspaceHeader.tag(dirty: false, ahead: 1, merged: false) == "↑1")
    #expect(WorkspaceHeader.tag(dirty: true, ahead: 0, merged: false) == "未提交")
    #expect(WorkspaceHeader.tag(dirty: false, ahead: 0, merged: false) == nil)
    #expect(WorkspaceHeader.tag(dirty: true, ahead: 2, merged: true) == "已合并")
  }
}

@Suite("Home: drawer")
struct DrawerTests {
  @Test("follows the appearance chosen, or the system")
  func appearance() {
    #expect(HomeView.scheme("light") == .light)
    #expect(HomeView.scheme("dark") == .dark)
    #expect(HomeView.scheme("system") == nil)
  }

  @Test("words the host's status as the drawer does")
  func status() {
    #expect(Drawer.statusText(.connected) == "已连接")
    #expect(Drawer.statusText(.syncing) == "正在同步…")
    #expect(Drawer.statusText(.hostOffline(lastSeen: nil)) == "离线")
    #expect(Drawer.statusText(.relayUnreachable) == "连不上 relay")
  }
}
