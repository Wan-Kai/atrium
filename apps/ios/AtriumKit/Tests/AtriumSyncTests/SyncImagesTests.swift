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
