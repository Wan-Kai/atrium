import AtriumProtocol
import AtriumSync
import Testing

/// An image as the phone sends it.
///
/// - Remark: Tiny base64, as the tests do not decode it.
let photo = OutgoingImage(mimeType: .imageJpeg, data: "AAAA")

/// An `upload_attachment` as the core sends it.
///
/// - Remark: Of `photo`.
/// - SideEffects: none
/// - Parameter id: Its request id.
/// - Returns: The command.
func uploadCommand(_ id: String) -> Command {
  .uploadAttachment(
    UploadAttachmentCommand(requestId: id, traceparent: traceparent, mimeType: .imageJpeg, data: "AAAA"))
}

/// The host's answer to an upload, as JSON.
///
/// - Remark: With the attachment's id.
/// - SideEffects: none
/// - Parameters:
///   - requestId: The upload's request id.
///   - attachmentId: The attachment.
/// - Returns: The JSON.
func uploaded(_ requestId: String, _ attachmentId: String) -> String {
  #"{"type":"response","requestId":"\#(requestId)","ok":true,"result":{"attachmentId":"\#(attachmentId)"}}"#
}

@Suite("Sync core: images")
struct SyncImagesTests {
  @Test("uploads each image first, then sends the message with their ids")
  func uploadsThenSends() {
    var sync = syncedCore()
    sync.setDraft("看图", for: "s1")
    sync.setDraftImages([photo, photo], for: "s1")
    #expect(sync.send("s1") == [.send(uploadCommand("r5"), generation: 1), .send(uploadCommand("r6"), generation: 1)])
    #expect(sync.draftImages["s1"] == nil)
    #expect(sync.outbox.map(\.images) == [2])
    #expect(receive(&sync, generation: 1, uploaded("r6", "a2")) == [])
    #expect(
      receive(&sync, generation: 1, uploaded("r5", "a1")) == [
        .send(
          .prompt(
            PromptCommand(
              requestId: "r4", traceparent: traceparent, sessionId: "s1", text: "看图", attachmentIds: ["a1", "a2"])),
          generation: 1)
      ])
  }

  @Test("sends images without text, and refuses nothing at all")
  func imagesOnly() {
    var sync = syncedCore()
    #expect(sync.send("s1") == [])
    sync.setDraftImages([photo], for: "s1")
    #expect(sync.send("s1") == [.send(uploadCommand("r5"), generation: 1)])
  }

  @Test("gives the text and images back when an upload is refused")
  func uploadRefused() {
    var sync = syncedCore()
    sync.setDraft("看图", for: "s1")
    sync.setDraftImages([photo], for: "s1")
    _ = sync.send("s1")
    _ = receive(&sync, generation: 1, failed("r5", "attachment_limit"))
    #expect(sync.outbox.isEmpty)
    #expect(sync.drafts["s1"] == "看图")
    #expect(sync.draftImages["s1"] == [photo])
    #expect(sync.problems["s1"] == .refused(.attachmentLimit))
  }

  @Test("uploads the images again after a reconnect, as the old ids were the old connection's, and sends once")
  func reuploadAfterReconnect() {
    var sync = syncedCore()
    sync.setDraftImages([photo], for: "s1")
    _ = sync.send("s1")
    _ = sync.connected(generation: 2)
    #expect(
      receive(&sync, generation: 2, ok("r6"), indexSnapshotJSON(), ok("r7"), ok("r8"), snapshotJSON("s1")) == [
        .markSynced(generation: 2), .send(uploadCommand("r9"), generation: 2),
      ])
    #expect(
      receive(&sync, generation: 2, uploaded("r9", "b1")) == [
        .send(
          .prompt(
            PromptCommand(requestId: "r4", traceparent: traceparent, sessionId: "s1", text: "", attachmentIds: ["b1"])),
          generation: 2)
      ])
  }
}

@Suite("Sync core: MP5 review")
struct SyncMP5ReviewTests {
  @Test("sends the input as a steer while a question waits, so it answers it")
  func answersByReply() {
    var sync = core()
    _ = sync.open("s1")
    _ = sync.connected(generation: 1)
    let question =
      #"{"id":"qq","askedAt":1,"questions":[{"header":"位置","question":"放哪？","multiSelect":false,"options":[{"label":"a","description":"","preview":null,"recommended":false},{"label":"b","description":"","preview":null,"recommended":false}]}]}"#
    let snapshot = snapshotJSON("s1").replacingOccurrences(of: #""question":null"#, with: #""question":\#(question)"#)
    _ = receive(&sync, generation: 1, ok("r1"), indexSnapshotJSON(), ok("r2"), ok("r3"), snapshot)
    sync.setDraft("放内存", for: "s1")
    #expect(sync.send("s1") == [.send(steerCommand("r4", "放内存"), generation: 1)])
  }

  @Test("gives the images back with the text when the message after its uploads could not be written")
  func imagesBackWhenNotWritten() {
    var sync = syncedCore()
    sync.setDraft("看图", for: "s1")
    sync.setDraftImages([photo], for: "s1")
    _ = sync.send("s1")
    _ = receive(&sync, generation: 1, uploaded("r5", "a1"))
    sync.notWritten("r4")
    #expect(sync.drafts["s1"] == "看图")
    #expect(sync.draftImages["s1"] == [photo])
  }

  @Test("takes an upload that could not be written as its message not written")
  func uploadNotWritten() {
    var sync = syncedCore()
    sync.setDraftImages([photo], for: "s1")
    _ = sync.send("s1")
    sync.notWritten("r5")
    #expect(sync.outbox.isEmpty)
    #expect(sync.draftImages["s1"] == [photo])
    #expect(sync.problems["s1"] == .notSent)
  }

  @Test("makes a message uncertain when an upload of its one retry is refused, as the first may have run")
  func retryUploadRefused() {
    var sync = syncedCore()
    sync.setDraftImages([photo], for: "s1")
    _ = sync.send("s1")
    _ = sync.connected(generation: 2)
    _ = receive(&sync, generation: 2, ok("r6"), indexSnapshotJSON(), ok("r7"), ok("r8"), snapshotJSON("s1"))
    _ = receive(&sync, generation: 2, failed("r9", "attachment_limit"))
    #expect(sync.outbox.map(\.state) == [.uncertain])
    #expect(sync.draftImages["s1"] == nil)
  }

  @Test("sends an uncertain message with images again with its images")
  func resendWithImages() {
    var sync = syncedCore()
    sync.setDraftImages([photo], for: "s1")
    _ = sync.send("s1")
    _ = receive(&sync, generation: 1, uploaded("r5", "a1"))
    _ = receive(&sync, generation: 1, failed("r4", "outcome_unknown"))
    #expect(sync.resend("r4") == [.send(uploadCommand("r7"), generation: 1)])
  }

  @Test("does not let a closed page's late action failure show when it is opened again")
  func lateActionFailure() {
    var sync = syncedCore()
    _ = sync.perform(.stop, in: "s1")
    _ = sync.close("s1")
    _ = sync.open("s1")
    _ = receive(&sync, generation: 1, failed("r4", "session_busy"))
    #expect(sync.actionProblems["s1"] == nil)
  }
}
