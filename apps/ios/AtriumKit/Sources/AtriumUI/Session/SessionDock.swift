import AtriumProtocol
import AtriumSync
import ImageIO
import PhotosUI
import SwiftUI

/// Everything at the bottom of a session page: the banner, the pills, and the input.
///
/// - Remark: The final prototype's dock (SPEC-0005 "MP5 定的细节 · MP5b"): from the top, the stopped
///   or held banner, the row of pills ("排队 N", "子对话 N"), then the input with the stop key to its
///   right. The banner and pills hide while the keyboard is up.
struct SessionDock: View {
  /// The session.
  let sessionId: SessionId
  /// The connection's sync.
  let sync: SyncModel
  /// Opens the queue sheet.
  let showQueue: () -> Void
  /// Opens the child list, if the session has children.
  let showChildren: (() -> Void)?
  /// How many children the session has.
  let children: Int
  /// Shows a toast.
  let toast: (String) -> Void
  /// Whether the input has the keyboard.
  @FocusState private var typing: Bool
  /// Light or dark.
  @Environment(\.colorScheme) private var scheme

  /// The dock.
  var body: some View {
    let palette = Palette(scheme: scheme)
    let state = sync.core.sessions[sessionId]
    let controls = SessionControls(
      control: state?.control, running: state?.running ?? false, connected: sync.status == .connected)
    VStack(alignment: .leading, spacing: Metrics.xs) {
      if !typing {
        if let banner = controls.banner {
          BannerView(banner: banner, palette: palette) {
            switch banner {
            case .stopped, .crashed: sync.perform(.resumeQueue, in: sessionId)
            case .deliveriesHeld: sync.perform(.resumeDeliveries, in: sessionId)
            }
          } view: {
            showQueue()
          }
        }
        if controls.queued > 0 || children > 0 {
          HStack(spacing: Metrics.xs) {
            if controls.queued > 0 {
              Pill(palette: palette, action: showQueue) {
                Circle().fill(controls.banner == nil ? palette.tint : palette.attn).frame(width: 6, height: 6)
                Text("排队 \(controls.queued)").monospacedDigit()
              }
              .accessibilityIdentifier("session.queue")
            }
            if children > 0, let showChildren {
              Pill(palette: palette, action: showChildren) { Text("子对话 \(children)").monospacedDigit() }
            }
          }
          .padding(.leading, 2)
          .transition(.opacity)
        }
      }
      Composer(sessionId: sessionId, sync: sync, controls: controls, typing: $typing, toast: toast)
    }
    .padding(.horizontal, 14)
    .padding(.bottom, Metrics.xs)
  }
}

/// A glass pill in the dock's row.
///
/// - Remark: The prototype's `.pill`: 34pt high, 13.5pt text.
private struct Pill<Label: View>: View {
  /// The colours.
  let palette: Palette
  /// What a tap does.
  let action: () -> Void
  /// The contents.
  @ViewBuilder let label: Label

  /// The pill.
  var body: some View {
    Button(action: action) {
      HStack(spacing: 6) { label }
        .font(.system(size: 13.5))
        .foregroundStyle(palette.text2)
        .padding(.horizontal, 13)
        .frame(height: 34)
        .atriumGlass(in: Capsule(), interactive: true)
    }
    .buttonStyle(PressStyle())
  }
}

/// The banner over the input for a held queue or held deliveries.
///
/// - Remark: The prototype's `.banner`: its words, a solid "继续发送" (or "继续"), and "查看" for a
///   held queue.
private struct BannerView: View {
  /// The banner.
  let banner: SessionControls.Banner
  /// The colours.
  let palette: Palette
  /// Lets the held items go.
  let resume: () -> Void
  /// Opens the queue.
  let view: () -> Void

  /// The banner.
  var body: some View {
    HStack(spacing: Metrics.xs) {
      Text(banner.text).font(.system(size: 14)).foregroundStyle(palette.text2).lineLimit(2)
      Spacer(minLength: 0)
      Button(action: resume) {
        Text(Self.isQueue(banner) ? "继续发送" : "继续")
          .font(.system(size: 13.5, weight: .semibold))
          .foregroundStyle(palette.onInk)
          .padding(.horizontal, 14)
          .frame(height: 36)
          .background(palette.ink, in: Capsule())
      }
      .buttonStyle(PressStyle())
      .accessibilityIdentifier("session.resume")
      if Self.isQueue(banner) {
        Button("查看", action: view).font(.system(size: 13.5)).foregroundStyle(palette.secondary).buttonStyle(.plain)
      }
    }
    .padding(.leading, Metrics.md)
    .padding(.trailing, 6)
    .padding(.vertical, 6)
    .atriumGlass(in: RoundedRectangle(cornerRadius: 24))
  }

  /// Whether the banner is about the queue.
  ///
  /// - Remark: Only a held queue has "查看".
  /// - SideEffects: none
  /// - Parameter banner: The banner.
  /// - Returns: Whether it is.
  private static func isQueue(_ banner: SessionControls.Banner) -> Bool {
    if case .deliveriesHeld = banner { return false }
    return true
  }
}

/// The input: text, the send key with its long-press menu, and the stop key.
///
/// - Remark: SPEC-0005 "MP4b 定的细节" and "MP5 定的细节 · MP5b": sending only when connected, synced
///   and nothing of the session unsettled; idle it sends, running it queues (toast "已排队"), and a
///   0.42 s press on send while running offers "立即插话" and "加入排队". The stop key shows while a
///   run goes on and spins while a stop is on its way. A message that did not go comes back here
///   with why.
struct Composer: View {
  /// The session.
  let sessionId: SessionId
  /// The connection's sync.
  let sync: SyncModel
  /// The run control around the input.
  let controls: SessionControls
  /// Whether the input has the keyboard.
  var typing: FocusState<Bool>.Binding
  /// Shows a toast.
  let toast: (String) -> Void
  /// Whether the long-press menu is open.
  @State private var menu = false
  /// The photos just picked, until they are shrunk into the input.
  @State private var picked: [PhotosPickerItem] = []
  /// The most images one message takes.
  static let maxImages = 4
  /// Light or dark.
  @Environment(\.colorScheme) private var scheme

  /// The input.
  var body: some View {
    let palette = Palette(scheme: scheme)
    let text = Binding(
      get: { sync.core.drafts[sessionId] ?? "" }, set: { sync.setDraft($0, for: sessionId) })
    let images = sync.core.draftImages[sessionId] ?? []
    // The picker's label is built off the main actor; it takes the colour as a value.
    let plusColor = palette.text2
    let empty = text.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && images.isEmpty
    let ready = sync.canSend(sessionId) && !empty
    VStack(alignment: .trailing, spacing: Metrics.xxs) {
      if let problem = sync.core.problems[sessionId] {
        Text(Self.problemLine(problem))
          .font(Typography.meta)
          .foregroundStyle(palette.danger)
          .frame(maxWidth: .infinity, alignment: .leading)
          .accessibilityIdentifier("session.problem")
      }
      if menu {
        SteerMenu(palette: palette) { steer in
          menu = false
          send(steer: steer)
        }
        .transition(.scale(scale: 0.3, anchor: .bottomTrailing).combined(with: .opacity))
      }
      HStack(alignment: .bottom, spacing: Metrics.xs) {
        VStack(alignment: .leading, spacing: 0) {
          if !images.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
              HStack(spacing: Metrics.xs) {
                ForEach(Array(images.enumerated()), id: \.offset) { place, image in
                  Thumbnail(image: image, palette: palette) {
                    var rest = images
                    rest.remove(at: place)
                    sync.setDraftImages(rest, for: sessionId)
                  }
                }
              }
              .padding([.horizontal, .top], Metrics.sm)
            }
            .transition(.scale(scale: 0.9).combined(with: .opacity))
          }
          HStack(alignment: .bottom, spacing: 2) {
            PhotosPicker(
              selection: $picked, maxSelectionCount: max(1, Self.maxImages - images.count), matching: .images
            ) {
              Image(systemName: "plus").font(.system(size: 20)).foregroundStyle(plusColor)
                .frame(width: 40, height: 40).contentShape(Circle())
            }
            .disabled(images.count >= Self.maxImages)
            .accessibilityLabel("添加图片")
            .accessibilityIdentifier("session.addImage")
            TextField(controls.placeholder, text: text, axis: .vertical)
              .lineLimit(1...5)
              .font(Typography.reply)
              .focused(typing)
              .padding(.vertical, 9)
              .padding(.leading, 4)
              .accessibilityIdentifier("session.input")
            SendKey(palette: palette, on: ready) {
              send(steer: false)
            } hold: {
              if ready, controls.canSteer {
                withAnimation(MotionToken.bouncy.resolved(reduceMotion: false).animation) { menu = true }
              }
            }
          }
          .padding(6)
          .frame(minHeight: 52)
        }
        .atriumGlass(in: RoundedRectangle(cornerRadius: 26))
        if controls.showsStop {
          StopKey(palette: palette, stopping: controls.stopping || sync.status != .connected) {
            if sync.perform(.stop, in: sessionId) { toast("已停止") }
          }
        }
      }
    }
    .onChange(of: controls.canSteer) { if !controls.canSteer { menu = false } }
    .task(id: picked) { await take(picked) }
  }

  /// Shrinks the photos just picked and adds them to the input.
  ///
  /// - Remark: SPEC-0005 "MP5 定的细节 · MP5c": one that cannot be made small enough is left out,
  ///   saying "图片太大".
  /// - SideEffects: Loads the photos; changes the input's images; may show a toast.
  /// - Parameter items: The photos.
  private func take(_ items: [PhotosPickerItem]) async {
    guard !items.isEmpty else { return }
    var added: [OutgoingImage] = []
    var tooLarge = false
    for item in items {
      guard let data = try? await item.loadTransferable(type: Data.self) else { continue }
      // Shrinking a photo takes long; off the main actor so the page keeps moving.
      if let jpeg = await Task.detached(priority: .userInitiated, operation: { ImageShrinker.jpeg(from: data) }).value {
        added.append(OutgoingImage(mimeType: .imageJpeg, data: jpeg.base64EncodedString()))
      } else {
        tooLarge = true
      }
    }
    guard !Task.isCancelled else { return }
    picked = []
    let images = sync.core.draftImages[sessionId] ?? []
    sync.setDraftImages(Array((images + added).prefix(Self.maxImages)), for: sessionId)
    if tooLarge { toast("图片太大") }
  }

  /// Sends the input, saying so when it went into the queue.
  ///
  /// - Remark: A prompt sent while a run goes on waits in the host's queue.
  /// - SideEffects: Queues the command; may show a toast.
  /// - Parameter steer: Whether to send it as a steer.
  private func send(steer: Bool) {
    guard sync.canSend(sessionId) else { return }
    let answering = sync.core.sessions[sessionId]?.control?.question != nil
    sync.send(sessionId, steer: steer)
    if answering {
      toast("代替回答 · 下一步前送达")
    } else if steer {
      toast("已插话 · 下一步前送达")
    } else if controls.canSteer {
      toast("已排队 · 共 \(controls.queued + 1) 条")
    }
  }

  /// Why the last message did not go, in words.
  ///
  /// - Remark: The host's refusal shows only as its code (AGENTS.md: the host sends no words).
  /// - SideEffects: none
  /// - Parameter problem: Why.
  /// - Returns: The line.
  static func problemLine(_ problem: SendProblem) -> String {
    switch problem {
    case .notSent: "没发出去"
    case .refused(let code): "没发出去（\(code.rawValue)）"
    }
  }
}

/// The send key: a tap sends, a 0.42 s press asks for the steer menu.
///
/// - Remark: The prototype's `.csend`: ink when there is something to send, quiet otherwise.
private struct SendKey: View {
  /// The colours.
  let palette: Palette
  /// Whether there is something that may be sent.
  let on: Bool
  /// A tap.
  let tap: () -> Void
  /// A long press.
  let hold: () -> Void

  /// The key.
  var body: some View {
    Image(systemName: "arrow.up")
      .font(.system(size: 18, weight: .semibold))
      .foregroundStyle(on ? palette.onInk : palette.secondary)
      .frame(width: 40, height: 40)
      .background(on ? palette.ink : palette.fill, in: Circle())
      .animation(.easeOut(duration: 0.2), value: on)
      .contentShape(Circle())
      .onTapGesture(perform: tap)
      .onLongPressGesture(minimumDuration: 0.42, perform: hold)
      .accessibilityElement()
      .accessibilityLabel("发送；运行中长按可插话")
      .accessibilityAddTraits(.isButton)
      .accessibilityAction(named: "立即插话", hold)
      .accessibilityAction(.default, tap)
      .accessibilityIdentifier("session.send")
  }
}

/// The stop key beside the input.
///
/// - Remark: The prototype's `.cstop`: a 52pt glass circle with a square; while a stop is on its
///   way it spins and cannot be pressed (SPEC-0005 "MP5 定的细节 · MP5b").
private struct StopKey: View {
  /// The colours.
  let palette: Palette
  /// Whether a stop is on its way.
  let stopping: Bool
  /// A tap.
  let stop: () -> Void

  /// The key.
  var body: some View {
    Button(action: stop) {
      Group {
        if stopping {
          ProgressView()
        } else {
          Image(systemName: "stop.fill").font(.system(size: 18)).foregroundStyle(palette.text)
        }
      }
      .frame(width: 52, height: 52)
      .atriumGlass(in: Circle(), interactive: true)
    }
    .buttonStyle(PressStyle())
    .disabled(stopping)
    .accessibilityLabel("停止")
    .accessibilityIdentifier("session.stop")
  }
}

/// The glass menu a long press on send opens while a run goes on.
///
/// - Remark: The prototype's `.smenu`: "立即插话" (before pi's next step, without interrupting it)
///   and "加入排队" (after the run).
private struct SteerMenu: View {
  /// The colours.
  let palette: Palette
  /// Sends as a steer (`true`) or into the queue.
  let choose: (Bool) -> Void

  /// The menu.
  var body: some View {
    VStack(spacing: 0) {
      row("立即插话", "下一步前送达，不打断当前这步", icon: "arrow.turn.down.right", steer: true)
      row("加入排队", "运行结束后依次发送", icon: "text.line.last.and.arrowtriangle.forward", steer: false)
    }
    .padding(6)
    .frame(width: 252)
    .atriumGlass(in: RoundedRectangle(cornerRadius: 26))
  }

  /// One choice.
  ///
  /// - Remark: 54pt high, its title and what it does.
  /// - SideEffects: none
  /// - Parameters:
  ///   - title: The title.
  ///   - detail: What it does.
  ///   - icon: Its symbol.
  ///   - steer: Whether it steers.
  /// - Returns: The row.
  private func row(_ title: String, _ detail: String, icon: String, steer: Bool) -> some View {
    Button {
      choose(steer)
    } label: {
      HStack(spacing: Metrics.sm) {
        Image(systemName: icon).font(.system(size: 18)).foregroundStyle(steer ? palette.tint : palette.text2)
          .frame(width: 24)
        VStack(alignment: .leading, spacing: 2) {
          Text(title).font(.system(size: 16, weight: .medium)).foregroundStyle(palette.text)
          Text(detail).font(.system(size: 12.5)).foregroundStyle(palette.secondary)
        }
        Spacer(minLength: 0)
      }
      .padding(.horizontal, Metrics.sm)
      .frame(minHeight: 54)
      .contentShape(RoundedRectangle(cornerRadius: 20))
    }
    .buttonStyle(PressStyle())
    .accessibilityIdentifier(steer ? "session.steer" : "session.enqueue")
  }
}

/// An image waiting in the input, with a key to take it out.
///
/// - Remark: The prototype's 56pt thumbnail, radius 12, with a small ink "×".
private struct Thumbnail: View {
  /// The image.
  let image: OutgoingImage
  /// The colours.
  let palette: Palette
  /// Takes it out.
  let remove: () -> Void
  /// The decoded thumbnail, once.
  @State private var picture: CGImage?

  /// The thumbnail.
  var body: some View {
    ZStack(alignment: .topTrailing) {
      Group {
        if let picture {
          Image(decorative: picture, scale: 1).resizable().scaledToFill()
        } else {
          palette.fill
        }
      }
      .frame(width: 56, height: 56)
      .clipShape(RoundedRectangle(cornerRadius: 12))
      Button(action: remove) {
        Image(systemName: "xmark").font(.system(size: 10, weight: .bold)).foregroundStyle(palette.onInk)
          .frame(width: 22, height: 22).background(palette.ink, in: Circle())
      }
      .buttonStyle(PressStyle())
      .offset(x: 6, y: -6)
      .accessibilityLabel("移除图片")
    }
    .padding(.top, 6)
    .padding(.trailing, 6)
    // Decoded once per image, not on every keystroke that redraws the input.
    .task(id: image) { picture = Self.picture(image) }
  }

  /// The image to draw, from its base64.
  ///
  /// - Remark: A small thumbnail, decoded by ImageIO.
  /// - SideEffects: none
  /// - Parameter image: The image.
  /// - Returns: The picture, or `nil` if it does not decode.
  private static func picture(_ image: OutgoingImage) -> CGImage? {
    guard let data = Data(base64Encoded: image.data), let source = CGImageSourceCreateWithData(data as CFData, nil)
    else { return nil }
    let options: [CFString: Any] = [
      kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceThumbnailMaxPixelSize: 168,
    ]
    return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
  }
}
