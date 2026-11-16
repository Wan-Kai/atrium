import AtriumProtocol
import Foundation
import Testing

@testable import AtriumUI

/// A run control decoded from JSON, from the idle one with some fields replaced.
///
/// - Remark: Each replacement is a `"field":value` pair.
/// - SideEffects: none
/// - Parameter fields: The fields that differ from idle.
/// - Returns: The control.
/// - Throws: When the JSON does not decode.
func control(_ fields: [String: String] = [:]) throws -> Control {
  var values: [String: String] = [
    "queue": "[]", "deliveries": "[]", "deliveriesHeld": "null", "paused": "null", "steers": "[]",
    "stopping": "false", "restarting": "false", "compacting": "false", "interactions": "[]", "question": "null",
    "reviews": "[]", "failure": "null",
  ]
  values.merge(fields) { _, new in new }
  let json = "{" + values.map { "\"\($0.key)\":\($0.value)" }.joined(separator: ",") + "}"
  return try JSONDecoder().decode(Control.self, from: Data(json.utf8))
}

/// Two queued messages, as JSON.
let twoQueued =
  #"[{"id":"q1","text":"一","createdAt":1,"images":0},{"id":"q2","text":"二","createdAt":2,"images":1}]"#

@Suite("Session controls")
struct SessionControlsTests {
  @Test("says what sending does: later when offline, into the queue while running, as an answer to a question")
  func placeholder() throws {
    #expect(SessionControls(control: try control(), running: false, connected: false).placeholder == "先写着，连上后再发")
    #expect(SessionControls(control: try control(), running: false, connected: true).placeholder == "发消息")
    #expect(SessionControls(control: try control(), running: true, connected: true).placeholder == "发送进排队 · 长按插话")
    let asking = try control([
      "question":
        #"{"id":"qq","askedAt":1,"questions":[{"header":"缓存","question":"放哪？","multiSelect":false,"options":[{"label":"内存","description":"","preview":null,"recommended":false},{"label":"磁盘","description":"","preview":null,"recommended":false}]}]}"#
    ])
    #expect(SessionControls(control: asking, running: true, connected: true).placeholder == "直接回复也行：发出后代替回答")
    #expect(SessionControls(control: nil, running: false, connected: true).placeholder == "发消息")
  }

  @Test("shows the stop key while a run goes on or a stop is on its way, busy while stopping")
  func stop() throws {
    #expect(!SessionControls(control: try control(), running: false, connected: true).showsStop)
    #expect(SessionControls(control: try control(), running: true, connected: true).showsStop)
    let stopping = SessionControls(control: try control(["stopping": "true"]), running: false, connected: true)
    #expect(stopping.showsStop)
    #expect(stopping.stopping)
    #expect(SessionControls(control: try control(), running: true, connected: true).canSteer)
    #expect(!SessionControls(control: try control(), running: false, connected: true).canSteer)
  }

  @Test("puts up a banner for a queue held by a stop or a crash, and for held deliveries")
  func banners() throws {
    let stopped = try control(["paused": #""stopped""#, "queue": twoQueued])
    #expect(SessionControls(control: stopped, running: false, connected: true).banner == .stopped(queued: 2))
    #expect(
      SessionControls(control: try control(["paused": #""stopped""#]), running: false, connected: true).banner == nil)
    let crashed = try control(["paused": #""crashed""#, "queue": twoQueued])
    #expect(SessionControls(control: crashed, running: false, connected: true).banner == .crashed(queued: 2))
    let held = try control([
      "deliveriesHeld": #""restart""#,
      "deliveries":
        #"[{"id":"d1","kind":"task","fromTitle":"子对话","event":null,"state":"waiting"}]"#,
    ])
    #expect(SessionControls(control: held, running: false, connected: true).banner == .deliveriesHeld(1))
    #expect(SessionControls(control: try control(), running: false, connected: true).banner == nil)
  }

  @Test("words the banners, the restart and a crash failure as the spec says")
  func words() {
    #expect(SessionControls.Banner.stopped(queued: 2).text == "已停止 · 排队的 2 条暂停了")
    #expect(SessionControls.Banner.crashed(queued: 1).text == "pi 崩溃了 · 排队的 1 条暂停了")
    #expect(SessionControls.Banner.deliveriesHeld(3).text == "有 3 项通知暂停了")
    #expect(SessionControls.failureText(attempts: 3) == "pi 连续崩溃 3 次，已停下")
  }

  @Test("counts the queue and reads the crash failure and the restart")
  func counts() throws {
    let queued = SessionControls(control: try control(["queue": twoQueued]), running: true, connected: true)
    #expect(queued.queued == 2)
    let failed = try control(["failure": #"{"reason":"crashed","attempts":3}"#, "restarting": "true"])
    let controls = SessionControls(control: failed, running: false, connected: true)
    #expect(controls.failure == "pi 连续崩溃 3 次，已停下")
    #expect(controls.restarting)
  }

  @Test("says why an action failed by its code")
  func actionProblem() {
    #expect(SessionControls.problemText(.init(action: .stop, code: .sessionBusy)) == "停止没成功（session_busy）")
    #expect(SessionControls.problemText(.init(action: .retryRun, code: .piUnavailable)) == "重试没成功（pi_unavailable）")
  }
}
