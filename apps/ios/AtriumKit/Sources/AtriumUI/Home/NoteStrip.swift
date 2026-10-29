import AtriumProtocol
import AtriumSync
import SwiftUI

/// "等你处理" on the home: a row of sticky notes, one a thing, scrolling sideways.
///
/// - Remark: design-language "手机端 · 首页": the title and "N 件"; at most eight notes, then a pile
///   "还有 N 件"; one note alone fills the row. Notes snap one by one. New notes are pasted on and
///   handled ones peeled off; while the Mac is away the row is faded, what it last said. Hidden by
///   the caller when there is nothing.
struct NoteStrip: View {
  /// What waits on you.
  let home: HomeList
  /// Whether the list is what the Mac last said, not live.
  let stale: Bool
  /// Light or dark.
  @Environment(\.colorScheme) private var scheme
  /// Whether Reduce Motion is on.
  @Environment(\.atriumReduceMotion) private var reduceMotion

  /// The strip.
  var body: some View {
    let palette = Palette(scheme: scheme)
    VStack(alignment: .leading, spacing: 0) {
      HStack(alignment: .firstTextBaseline) {
        Text("等你处理").font(.system(size: 15, weight: .bold)).foregroundStyle(palette.text)
        Spacer()
        (Text("\(home.notes.count)").fontWeight(.bold).foregroundColor(palette.attn)
          + Text(" 件").foregroundColor(palette.secondary))
          .font(.system(size: 12.5)).monospacedDigit()
      }
      .accessibilityElement(children: .combine)
      ScrollView(.horizontal) {
        LazyHStack(alignment: .top, spacing: 12) {
          let alone = home.shownNotes.count == 1 && home.pile == 0
          ForEach(Array(home.shownNotes.enumerated()), id: \.element.id) { place, note in
            NavigationLink(value: note.id) {
              NoteCard(note: note, place: place, wide: alone)
            }
            .buttonStyle(PressStyle())
            // A sideways scroll view offers no width, so a lone note takes the row's: the screen less
            // the page margins (the scroll view spans the screen).
            .containerRelativeFrame(.horizontal) { width, _ in alone ? width - Metrics.page * 2 : 158 }
            .accessibilityIdentifier("home.note.\(note.id)")
            .transition(reduceMotion ? .opacity : Self.paste)
          }
          if home.pile > 0 {
            PileCard(count: home.pile).transition(.opacity)
          }
        }
        .scrollTargetLayout()
        .padding(.horizontal, Metrics.page)
        .padding(.top, 16)
        .padding(.bottom, 20)
        .animation(reduceMotion ? nil : MotionToken.bouncy.resolved(reduceMotion: false).animation, value: home.notes)
      }
      .scrollTargetBehavior(.viewAligned)
      .scrollIndicators(.hidden)
      // The notes' shadows reach past the row; clipping them left a hard edge under it.
      .scrollClipDisabled()
      .padding(.horizontal, -Metrics.page)
      .saturation(stale ? 0.35 : 1)
      .opacity(stale ? 0.78 : 1)
    }
    .padding(.top, 12)
  }

  /// A note coming on: from above, larger and turned, settling into place; going off: lifting away.
  ///
  /// - Remark: The prototype's `paste` and `peel` keyframes as a SwiftUI transition.
  private static let paste = AnyTransition.asymmetric(
    insertion: .scale(scale: 1.1).combined(with: .opacity).combined(with: .offset(y: -14)),
    removal: .opacity.combined(with: .offset(x: 6, y: -18))
  )
}

/// One sticky note.
///
/// - Remark: design-language "手机端 · 首页": 158×164pt, rounded only at the bottom right, a strip
///   of tape on top; tilted and taped by a hash of the session (neighbours lean opposite ways), every
///   second note 6pt lower. The kind ("对话") at the top left, how long it has waited at the top
///   right, the bold title, the smaller body (mono for pi's error text), and "项目 · 分支" at the foot.
///   The paper's colour is the level. No tilt under Reduce Motion.
struct NoteCard: View {
  /// The note.
  let note: HomeList.Note
  /// Its place in the row, from 0.
  let place: Int
  /// Whether it is alone and fills the row.
  var wide = false
  /// Light or dark.
  @Environment(\.colorScheme) private var scheme
  /// Whether Reduce Motion is on.
  @Environment(\.atriumReduceMotion) private var reduceMotion

  /// The note.
  var body: some View {
    let palette = Palette(scheme: scheme)
    let colours = Self.colours(note.level)
    let look = NoteLook(seed: note.id, place: place)
    TimelineView(.everyMinute) { time in
      VStack(alignment: .leading, spacing: 0) {
        HStack(spacing: 4) {
          NewChatIconBubble().frame(width: 12, height: 12).opacity(0.8)
          Text("对话").fontWeight(.bold)
          Spacer(minLength: 4)
          Text(HomeList.ago(note.since, now: Int(time.date.timeIntervalSince1970 * 1000)))
            .fontWeight(.medium).opacity(0.8).monospacedDigit()
        }
        .font(.system(size: 12))
        .opacity(0.85)
        Text(note.title)
          .font(.system(size: 15.5, weight: .bold))
          .lineLimit(2)
          .padding(.top, 6)
        if let body = note.body {
          Text(body)
            .font(note.code ? .system(size: 11, design: .monospaced) : .system(size: 12.5))
            .lineLimit(2)
            .opacity(0.75)
            .padding(.top, 4)
        }
        Spacer(minLength: 6)
        Text(note.place).font(.system(size: 11.5)).lineLimit(1).opacity(0.6)
      }
      .multilineTextAlignment(.leading)
      .foregroundStyle(palette(colours.ink))
      .padding(EdgeInsets(top: 14, leading: 13, bottom: 11, trailing: 13))
      .frame(maxWidth: .infinity, minHeight: 164, maxHeight: 164, alignment: .topLeading)
      .background(palette(colours.paper), in: UnevenRoundedRectangle(cornerRadii: Self.corners))
      .shadow(color: .black.opacity(scheme == .dark ? 0.45 : 0.12), radius: 9, y: 9)
      .overlay(alignment: .top) {
        Rectangle()
          .fill(.white.opacity(scheme == .dark ? 0.28 : 0.5))
          .frame(width: 50, height: 16)
          .rotationEffect(.degrees(look.tapeAngle))
          .offset(x: (look.tapeAt - 0.5) * (wide ? 200 : 158), y: -8)
      }
      .rotationEffect(.degrees(reduceMotion ? 0 : look.tilt))
      .offset(y: look.drop)
    }
    .accessibilityElement(children: .combine)
  }

  /// The corners: 2pt but 10pt at the bottom right, like a note's curled corner.
  private static let corners = RectangleCornerRadii(topLeading: 2, bottomLeading: 2, bottomTrailing: 10, topTrailing: 2)

  /// The paper and ink tokens of a level.
  ///
  /// - Remark: design-language "手机端 · 颜色 · 便签纸".
  /// - SideEffects: none
  /// - Parameter level: The note's level.
  /// - Returns: The paper and the ink.
  static func colours(_ level: HomeList.NoteLevel) -> (paper: ColorToken, ink: ColorToken) {
    switch level {
    case .stuck: (.stickyStuck, .stickyStuckInk)
    case .waiting: (.stickyWaiting, .stickyWaitingInk)
    case .reminder: (.stickyReminder, .stickyReminderInk)
    }
  }
}

/// The last place in the strip when there are more notes than fit: a small pile of blank paper.
///
/// - Remark: The prototype's `.pile`: two sheets turned under the top one, "还有 N 件" in the serif
///   and the tint.
struct PileCard: View {
  /// How many notes are not shown.
  let count: Int
  /// Light or dark.
  @Environment(\.colorScheme) private var scheme

  /// The pile.
  var body: some View {
    let palette = Palette(scheme: scheme)
    let sheet = UnevenRoundedRectangle(
      cornerRadii: RectangleCornerRadii(topLeading: 2, bottomLeading: 2, bottomTrailing: 10, topTrailing: 2))
    VStack(alignment: .leading, spacing: 6) {
      Spacer()
      Text("还有").font(.system(size: 13)).foregroundStyle(palette.secondary)
      Text("\(count) 件").font(.system(size: 22, weight: .semibold, design: .serif)).foregroundStyle(palette.text)
    }
    .padding(14)
    .frame(width: 158, height: 164, alignment: .leading)
    .background {
      ZStack {
        sheet.fill(palette.note).overlay(sheet.strokeBorder(palette.line, lineWidth: 0.5))
          .rotationEffect(.degrees(-3)).offset(x: -3, y: 2)
        sheet.fill(palette.note).overlay(sheet.strokeBorder(palette.line, lineWidth: 0.5))
          .rotationEffect(.degrees(2.5)).offset(x: 3, y: 3)
        sheet.fill(palette.note).overlay(sheet.strokeBorder(palette.line, lineWidth: 0.5))
      }
    }
    .accessibilityElement(children: .combine)
  }
}

/// How a note sits: its tilt, its drop, and where its tape is.
///
/// - Remark: From a stable hash of its session (FNV-1a, not Swift's per-run `hashValue`), so a note
///   keeps its look across launches; the sign of the tilt alternates with the place, so neighbours
///   lean opposite ways, and every second note sits 6pt lower.
struct NoteLook: Equatable {
  /// Degrees, within ±1.5.
  let tilt: Double
  /// Points down.
  let drop: CGFloat
  /// The tape's centre across the note, from 0.35 to 0.65.
  let tapeAt: CGFloat
  /// The tape's turn, within ±4 degrees.
  let tapeAngle: Double

  /// Works the look out.
  ///
  /// - Remark: See the type.
  /// - SideEffects: none
  /// - Parameters:
  ///   - seed: The session.
  ///   - place: The note's place in the row, from 0.
  init(seed: String, place: Int) {
    var hash: UInt64 = 0xcbf2_9ce4_8422_2325
    for byte in seed.utf8 {
      hash ^= UInt64(byte)
      hash = hash &* 0x0000_0100_0000_01b3
    }
    let unit = { (shift: UInt64) -> Double in Double((hash >> shift) & 0xffff) / 65535 }
    tilt = (place.isMultiple(of: 2) ? -1 : 1) * (0.6 + 0.9 * unit(0))
    drop = place.isMultiple(of: 2) ? 0 : 6
    tapeAt = 0.35 + 0.3 * unit(16)
    tapeAngle = -4 + 8 * unit(32)
  }
}

/// The small chat bubble before "对话" on a note: the new chat icon's bubble, without the plus.
///
/// - Remark: The prototype's `chat` icon on a 12-unit grid.
struct NewChatIconBubble: View {
  /// The bubble.
  private static let path: CGPath? = SVGPath.cgPath(
    "M2 3.2A1.7 1.7 0 0 1 3.7 1.5h4.6A1.7 1.7 0 0 1 10 3.2v3.1A1.7 1.7 0 0 1 8.3 8H5.4L3 10V8h0A1.7 1.7 0 0 1 2 6.3z")

  /// The icon.
  var body: some View {
    Canvas { context, canvas in
      guard let path = Self.path else { return }
      context.scaleBy(x: canvas.width / 12, y: canvas.height / 12)
      context.stroke(Path(path), with: .foreground, style: StrokeStyle(lineWidth: 1.3, lineJoin: .round))
    }
    .accessibilityHidden(true)
  }
}
