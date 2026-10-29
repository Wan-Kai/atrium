import AtriumSync
import SwiftUI

/// Where the home "+"'s keys sit and how they move (design-language "手机端 · 首页", 2026-10-29).
///
/// - Remark: One ring centred on the "+": 92pt out, keys 48° apart from -84° (just right of straight
///   up) round to its left; three fit, the rest come in as the ring turns. Angles are in
///   degrees, screen-wise (y down), so a turn clockwise raises them. Kept free of views so the maths
///   is tested on its own.
enum PlaceRing {
  /// How far the keys sit from the plus key's centre, in points.
  static let radius: CGFloat = 92
  /// The degrees between two keys, about 75pt between centres.
  static let slot: Double = 48
  /// Where the first key sits.
  static let first: Double = -84
  /// How many keys fit before the ring has to turn.
  static let shown = 3
  /// Where the last key that fits sits: straight left of the "+".
  static let last: Double = first - Double(shown - 1) * slot
  /// A key's diameter.
  static let size: CGFloat = 52
  /// How far a tap may land from a key's centre and still hit it.
  static let reach: CGFloat = 32
  /// The radius of the frosted pad behind the ring, the part that takes touches: the keys shown
  /// and their names, with a little room.
  static let pad: CGFloat = 146
  /// How far past the pad its frost fades out.
  static let feather: CGFloat = 40

  /// Where a key sits on the ring.
  ///
  /// - Remark: Turning by one slot moves every key one slot round.
  /// - SideEffects: none
  /// - Parameters:
  ///   - index: The key, 0 for 新对话.
  ///   - scroll: How far the ring has turned, in slots.
  /// - Returns: Its angle.
  static func angle(index: Int, scroll: Double) -> Double {
    first - (Double(index) - scroll) * slot
  }

  /// A point on the ring, from the plus key's centre.
  ///
  /// - Remark: Screen-wise, y down.
  /// - SideEffects: none
  /// - Parameters:
  ///   - angle: The angle.
  ///   - radius: How far out.
  /// - Returns: The point.
  static func point(angle: Double, radius: CGFloat = radius) -> CGPoint {
    let radians = angle * .pi / 180
    return CGPoint(x: radius * cos(radians), y: radius * sin(radians))
  }

  /// How far the ring may turn.
  ///
  /// - Remark: None while everything fits; otherwise until the last key reaches the last slot shown.
  /// - SideEffects: none
  /// - Parameter count: How many keys.
  /// - Returns: The most, in slots.
  static func maxScroll(count: Int) -> Double {
    Double(max(0, count - shown))
  }

  /// A dragged turn, held back past either end.
  ///
  /// - Remark: Past an end the ring gives a third of the pull, a rubber band.
  /// - SideEffects: none
  /// - Parameters:
  ///   - raw: The turn the finger asks for.
  ///   - max: The most the ring turns.
  /// - Returns: The turn shown.
  static func rubber(_ raw: Double, max: Double) -> Double {
    if raw < 0 { return raw * 0.35 }
    if raw > max { return max + (raw - max) * 0.35 }
    return raw
  }

  /// Where a released ring comes to rest.
  ///
  /// - Remark: Thrown nine times its last step's speed, then on the nearest whole slot in range.
  /// - SideEffects: none
  /// - Parameters:
  ///   - scroll: Where it is.
  ///   - velocity: Its last step, in slots.
  ///   - max: The most it turns.
  /// - Returns: The slot.
  static func settle(scroll: Double, velocity: Double, max: Double) -> Double {
    min(max, Swift.max(0, (scroll + velocity * 9).rounded()))
  }

  /// The step between two angles a finger went through.
  ///
  /// - Remark: Wraps across ±180° so crossing the left of the "+" is not a whole turn back.
  /// - SideEffects: none
  /// - Parameters:
  ///   - from: The angle before.
  ///   - to: The angle now.
  /// - Returns: The step, positive clockwise.
  static func step(from: Double, to: Double) -> Double {
    var delta = to - from
    if delta > 180 { delta -= 360 }
    if delta < -180 { delta += 360 }
    return delta
  }

  /// How much of a key shows at an angle.
  ///
  /// - Remark: Keys turned past the first slot or not yet up to the last fade out over 60% of a slot,
  ///   so the ones waiting do not show under the "+".
  /// - SideEffects: none
  /// - Parameter angle: The key's angle.
  /// - Returns: From 0 to 1.
  static func fade(angle: Double) -> Double {
    let past = max(angle - first, last - angle, 0)
    return max(0, 1 - past / (slot * 0.6))
  }

  /// The key under a tap, if any.
  ///
  /// - Remark: The nearest key within reach of the tap that still shows.
  /// - SideEffects: none
  /// - Parameters:
  ///   - location: The tap, from the "+"'s centre.
  ///   - count: How many keys.
  ///   - scroll: How far the ring has turned.
  /// - Returns: The key's index.
  static func key(at location: CGPoint, count: Int, scroll: Double) -> Int? {
    (0..<count)
      .filter { fade(angle: angle(index: $0, scroll: scroll)) > 0.5 }
      .map { index -> (Int, CGFloat) in
        let centre = point(angle: angle(index: index, scroll: scroll))
        return (index, hypot(location.x - centre.x, location.y - centre.y))
      }
      .filter { $0.1 <= reach }
      .min { $0.1 < $1.1 }?.0
  }

  /// How long after opening a key starts out of the "+".
  ///
  /// - Remark: The ripple: each key 0.028 s after the one before.
  /// - SideEffects: none
  /// - Parameter order: The key's index.
  /// - Returns: Seconds.
  static func delay(order: Int) -> Double {
    Double(order) * 0.028
  }

  /// How long after opening a key's name fades in.
  ///
  /// - Remark: Once the key has landed, 0.2 s after it starts.
  /// - SideEffects: none
  /// - Parameter order: The key's index.
  /// - Returns: Seconds.
  static func labelDelay(order: Int) -> Double {
    delay(order: order) + 0.2
  }
}

/// The home's "+" and the ring of places it opens (design-language "手机端 · 首页", 2026-10-29).
///
/// - Remark: Closed, only the "+" shows. Open, a frosted layer grows out of the "+", the "+" turns
///   to "×", and the keys ripple out: 新对话 first, then a project each, the latest activity first.
///   Dragging round the "+" anywhere turns the ring when it overflows; a tap on a key starts a
///   session there; a tap anywhere else closes it.
struct PlaceRingKey: View {
  /// The projects, the latest activity first.
  let places: [HomeList.RingPlace]
  /// Starts a new session at a place.
  let go: (NewSessionRoute) -> Void
  /// Whether the ring is open.
  @State private var open = false
  /// How far the ring has turned, in slots.
  @State private var scroll: Double = 0
  /// The drag going on, if any.
  @State private var drag: RingDrag?
  /// Light or dark.
  @Environment(\.colorScheme) private var scheme
  /// Whether Reduce Motion is on.
  @Environment(\.atriumReduceMotion) private var reduceMotion

  /// The "+" and, when open, the ring.
  var body: some View {
    GeometryReader { proxy in
      // Where the "+" sat before: 20pt in from the right, 8pt above the bottom of the safe area.
      let centre = CGPoint(
        x: proxy.size.width - Metrics.page - Metrics.floatingAdd / 2,
        y: proxy.size.height - Metrics.xs - Metrics.floatingAdd / 2)
      ZStack(alignment: .topLeading) {
        backdrop.position(centre)
        ForEach(Array(keys.enumerated()), id: \.offset) { index, key in
          keyView(key, index: index)
            .position(centre)
        }
        plus.position(centre)
      }
    }
    // Touches outside the pad reach the page, which may push another page over the ring.
    .onDisappear { open = false }
  }

  /// The keys: 新对话, then the projects.
  private var keys: [RingKey] {
    [RingKey(title: "新对话", glyph: nil, running: false, route: NewSessionRoute(container: nil))]
      + places.map {
        RingKey(
          title: $0.name, glyph: $0.name.first.map { String($0).uppercased() }, running: $0.running > 0,
          route: NewSessionRoute(container: $0.workspace))
      }
  }

  /// The frosted pad that grows out of the "+" behind the ring and takes its drags and taps.
  ///
  /// - Remark: Only the "+" and the ring get a backdrop; the rest of the page stays as it is and
  ///   still takes touches. Its edge fades out over `feather`. It opens as a ripple from the "+";
  ///   with Reduce Motion it only fades.
  /// - SideEffects: none
  private var backdrop: some View {
    let palette = Palette(scheme: scheme)
    let outer = PlaceRing.pad + PlaceRing.feather
    let grown = open || reduceMotion
    return Circle()
      .fill(.ultraThinMaterial)
      .overlay(Circle().fill(palette.page.opacity(0.36)))
      .mask {
        RadialGradient(
          stops: [
            .init(color: .black, location: 0), .init(color: .black, location: PlaceRing.pad / outer),
            .init(color: .clear, location: 1),
          ],
          center: .center, startRadius: 0, endRadius: outer)
      }
      .frame(width: outer * 2, height: outer * 2)
      .scaleEffect(grown ? 1 : 0.01)
      .opacity(reduceMotion ? (open ? 1 : 0) : 1)
      .animation(
        reduceMotion ? .easeInOut(duration: Motion.reducedDuration) : .easeOut(duration: open ? 0.32 : 0.24),
        value: open
      )
      .contentShape(Circle().inset(by: PlaceRing.feather))
      .gesture(turning(centre: CGPoint(x: outer, y: outer)))
      .allowsHitTesting(open)
      .accessibilityHidden(true)
  }

  /// One key, placed on the ring for the current turn and opening.
  ///
  /// - Remark: The ripple's springs ride on `open` only, so turning the ring is not delayed by them.
  /// - SideEffects: none
  /// - Parameters:
  ///   - key: The key.
  ///   - index: Its place in the ring.
  /// - Returns: The key.
  private func keyView(_ key: RingKey, index: Int) -> some View {
    let palette = Palette(scheme: scheme)
    let angle = PlaceRing.angle(index: index, scroll: scroll)
    let out = open || reduceMotion
    let shown = open ? PlaceRing.fade(angle: angle) : 0
    let landing: Animation =
      reduceMotion
      ? .easeInOut(duration: Motion.reducedDuration)
      : open
        ? .spring(duration: 0.42, bounce: 0.28).delay(PlaceRing.delay(order: index))
        : .easeIn(duration: 0.2).delay(Double(max(0, keys.count - 1 - index)) * 0.008)
    return ZStack(alignment: .topTrailing) {
      Group {
        if let glyph = key.glyph {
          Text(glyph).font(.system(size: 18, weight: .semibold, design: .serif)).foregroundStyle(palette.tint)
        } else {
          Image(systemName: "plus").font(.system(size: 22, weight: .light)).foregroundStyle(palette.page)
        }
      }
      .frame(width: PlaceRing.size, height: PlaceRing.size)
      .background {
        if key.glyph == nil { Circle().fill(palette.text) }
      }
      .modifier(RingKeyGlass(ink: key.glyph == nil))
      if key.running {
        Circle().fill(palette.tint).frame(width: 11, height: 11)
          .overlay(Circle().stroke(palette.page, lineWidth: 2))
      }
    }
    // The name hangs below the key in an overlay, so the key's centre is what sits on the ring.
    .overlay(alignment: .top) {
      Text(key.title)
        .font(.system(size: 11.5, weight: .semibold))
        .foregroundStyle(palette.text)
        .lineLimit(1)
        .truncationMode(.tail)
        .frame(width: 84)
        .shadow(color: palette.page, radius: 4)
        .offset(y: PlaceRing.size + 4)
        .opacity(open ? 1 : 0)
        .animation(
          reduceMotion
            ? .easeInOut(duration: Motion.reducedDuration)
            : open ? .easeOut(duration: 0.15).delay(PlaceRing.labelDelay(order: index)) : .easeIn(duration: 0.1),
          value: open)
    }
    .scaleEffect(out ? 1 : 0.35)
    .modifier(RingPlacement(angle: angle, radius: out ? PlaceRing.radius : 0))
    .opacity(shown)
    .animation(landing, value: open)
    .allowsHitTesting(false)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(key.glyph == nil ? "新对话" : "在 \(key.title) 里新建")
    .accessibilityAddTraits(.isButton)
    .accessibilityAction { pick(key) }
    .accessibilityHidden(!open || shown < 0.5)
  }

  /// The "+", which turns to "×" while the ring is open.
  private var plus: some View {
    let palette = Palette(scheme: scheme)
    return Button {
      if !open { scroll = 0 }
      open.toggle()
    } label: {
      Image(systemName: "plus")
        .font(.system(size: 22, weight: .medium))
        .foregroundStyle(palette.text)
        .rotationEffect(.degrees(open ? 45 : 0))
        .animation(
          reduceMotion ? .easeInOut(duration: Motion.reducedDuration) : .spring(duration: 0.36, bounce: 0.3),
          value: open
        )
        .frame(width: Metrics.floatingAdd, height: Metrics.floatingAdd)
        // Not interactive: the system's press bounce swells the glass but not its ring, which then
        // jumps out of step; `PressStyle` shrinks both together.
        .atriumGlass(in: Circle())
        // The glass does not take touches on a device; without this only the glyph does, and a tap
        // on the rest of the circle falls through to the row under it.
        .contentShape(Circle())
    }
    .buttonStyle(PressStyle())
    .accessibilityLabel(open ? "收起" : "新建会话")
    .accessibilityIdentifier("new.key")
  }

  /// Turning the ring by dragging round the "+", and picking or closing with a tap.
  ///
  /// - Remark: The finger's angle round the "+" drives the turn, so it follows the ring wherever on
  ///   the screen the drag is; a release springs to the nearest slot with the drag's speed.
  /// - SideEffects: none
  /// - Parameter centre: The "+"'s centre.
  /// - Returns: The gesture.
  private func turning(centre: CGPoint) -> some Gesture {
    DragGesture(minimumDistance: 0)
      .onChanged { value in
        let at = CGPoint(x: value.location.x - centre.x, y: value.location.y - centre.y)
        let angle = atan2(at.y, at.x) * 180 / .pi
        var current = drag ?? RingDrag(angle: angle, raw: scroll, velocity: 0)
        current.raw += PlaceRing.step(from: current.angle, to: angle) / PlaceRing.slot
        current.angle = angle
        let next = PlaceRing.rubber(current.raw, max: PlaceRing.maxScroll(count: keys.count))
        current.velocity = next - scroll
        drag = current
        scroll = next
      }
      .onEnded { value in
        let velocity = drag?.velocity ?? 0
        drag = nil
        if hypot(value.translation.width, value.translation.height) < 6 {
          let at = CGPoint(x: value.location.x - centre.x, y: value.location.y - centre.y)
          if let index = PlaceRing.key(at: at, count: keys.count, scroll: scroll) {
            pick(keys[index])
          } else {
            open = false
          }
          return
        }
        let target = PlaceRing.settle(
          scroll: scroll, velocity: velocity, max: PlaceRing.maxScroll(count: keys.count))
        withAnimation(reduceMotion ? nil : .spring(duration: 0.42, bounce: 0.15)) { scroll = target }
      }
  }

  /// Starts a session at a key's place and closes the ring.
  ///
  /// - Remark: The ring closes as the new session page pushes in.
  /// - SideEffects: Pushes the new session page.
  /// - Parameter key: The key.
  private func pick(_ key: RingKey) {
    open = false
    go(key.route)
  }
}

/// One key on the ring.
///
/// - Remark: 新对话 has no glyph and is drawn in ink.
private struct RingKey {
  /// Its name.
  let title: String
  /// The project's first letter, `nil` for 新对话.
  let glyph: String?
  /// Whether a session in it runs.
  let running: Bool
  /// Where its session starts.
  let route: NewSessionRoute
}

/// A drag turning the ring.
///
/// - Remark: Kept between drag events to turn by the finger's angle step.
private struct RingDrag {
  /// The finger's last angle round the "+".
  var angle: Double
  /// The turn the finger asks for, before the rubber band.
  var raw: Double
  /// The last step's turn, for the throw.
  var velocity: Double
}

/// Puts a view on the ring at an angle and distance, animating round the ring, not across it.
///
/// - Remark: Animating the angle and the radius, not the offset, keeps a turning key on the circle.
private struct RingPlacement: ViewModifier, Animatable {
  /// The angle.
  var angle: Double
  /// How far out.
  var radius: CGFloat

  /// The angle and the radius, for SwiftUI to step between.
  var animatableData: AnimatablePair<Double, CGFloat> {
    get { AnimatablePair(angle, radius) }
    set {
      angle = newValue.first
      radius = newValue.second
    }
  }

  /// Offsets the view to its point.
  ///
  /// - Remark: See the type.
  /// - SideEffects: none
  /// - Parameter content: The view.
  /// - Returns: The placed view.
  func body(content: Content) -> some View {
    let point = PlaceRing.point(angle: angle, radius: radius)
    return content.offset(x: point.x, y: point.y)
  }
}

/// A key's face: paper glass, or the ink of 新对话.
///
/// - Remark: The ink key keeps a hairline shadow so it sits on the frost like the others.
private struct RingKeyGlass: ViewModifier {
  /// Whether it is the ink 新对话 key.
  let ink: Bool

  /// The face.
  ///
  /// - Remark: See the type.
  /// - SideEffects: none
  /// - Parameter content: The key.
  /// - Returns: The key with its face.
  func body(content: Content) -> some View {
    if ink {
      content.clipShape(Circle()).shadow(color: .black.opacity(0.14), radius: 7, y: 4)
    } else {
      content.atriumGlass(in: Circle())
    }
  }
}
