import AtriumProtocol

/// A message the phone sent that is not settled yet.
///
/// - Remark: SPEC-0005 "断线与恢复 · 发送分三态" and "MP4b 定的细节". Its id is the request id,
///   which is also the turn's `clientMessageId` once the host runs it.
public struct Outgoing: Sendable, Equatable, Identifiable {
  /// Where a message stands.
  ///
  /// - Remark: A message that did not go at all is not here: its text went back to the input.
  public enum State: Sendable, Equatable {
    /// Written, not answered yet: "发送中".
    case sending
    /// The host started it; waiting for its turn to show.
    case accepted
    /// Nobody can tell whether it went: "没能确认是否送到 · 重发".
    case uncertain
  }

  /// What the message is sent as.
  ///
  /// - Remark: Both go with a receipt (SPEC-0005 "协议改动" 4).
  public enum Kind: Sendable, Equatable {
    /// `prompt`: sent now when idle, queued on the host while a run goes on.
    case prompt
    /// `steer`: "立即插话", delivered before pi's next step.
    case steer
  }

  /// The request id.
  public let id: RequestId
  /// The session.
  public let sessionId: SessionId
  /// The text.
  public let text: String
  /// Where it stands.
  public internal(set) var state: State
  /// What it is sent as.
  public let kind: Kind
  /// How many images go with it.
  public let images: Int

  /// Makes a message.
  ///
  /// - Remark: Public for tests that compare outboxes.
  /// - SideEffects: none
  /// - Parameters:
  ///   - id: The request id.
  ///   - sessionId: The session.
  ///   - text: The text.
  ///   - state: Where it stands.
  ///   - kind: What it is sent as.
  ///   - images: How many images go with it.
  public init(
    id: RequestId, sessionId: SessionId, text: String, state: State, kind: Kind = .prompt, images: Int = 0
  ) {
    self.id = id
    self.sessionId = sessionId
    self.text = text
    self.state = state
    self.kind = kind
    self.images = images
  }
}

/// Why a session's last message did not go.
///
/// - Remark: Its text went back to the input either way.
public enum SendProblem: Sendable, Equatable {
  /// The connection was gone before it was written: "没发出去".
  case notSent
  /// The host refused it, with this code.
  case refused(ErrorCode)
}

/// An image ready to go with a message: encoded and small enough for `upload_attachment`.
///
/// - Remark: SPEC-0005 "MP5 定的细节 · MP5c": the app shrinks and encodes it before it gets here.
public struct OutgoingImage: Sendable, Equatable {
  /// Its format.
  public let mimeType: UploadAttachmentCommand.MimeType
  /// Its bytes in base64, at most 1,000,000 characters.
  public let data: String

  /// Makes an image.
  ///
  /// - Remark: The data is not checked here; the host refuses one too large.
  /// - SideEffects: none
  /// - Parameters:
  ///   - mimeType: Its format.
  ///   - data: Its bytes in base64.
  public init(mimeType: UploadAttachmentCommand.MimeType, data: String) {
    self.mimeType = mimeType
    self.data = data
  }
}
