import SwiftUI

/// The three springs every animation on the phone uses, and what they become with Reduce Motion.
///
/// - Remark: design-language "动效" and "手机端 · 动效": the desktop's springs map one to one onto
///   `.spring(duration:bounce:)`. With Reduce Motion on, the same token is a 0.18 s cross-fade and
///   says that nothing may scale or move (`allowsScale`, `allowsSpatialMotion`), so a screen asks
///   the token instead of checking the setting itself. The idea of a token that degrades with
///   switches comes from mimi-remote's motion tokens (mobile-remote.md §7); no code is taken.
enum MotionToken: Sendable, CaseIterable {
  /// Opening, closing, swapping content: 0.42 s, no bounce.
  case smooth
  /// Buttons springing back, popovers: 0.30 s, bounce 0.15.
  case snappy
  /// Send and stop trading places, emphatic feedback: 0.40 s, bounce 0.26.
  case bouncy

  /// How long the spring takes, in seconds.
  var duration: Double {
    switch self {
    case .smooth: 0.42
    case .snappy: 0.30
    case .bouncy: 0.40
    }
  }

  /// How much it overshoots, from 0.
  var bounce: Double {
    switch self {
    case .smooth: 0
    case .snappy: 0.15
    case .bouncy: 0.26
    }
  }

  /// The animation and its switches for a Reduce Motion setting.
  ///
  /// - Remark: See the type.
  /// - SideEffects: none
  /// - Parameter reduceMotion: Whether Reduce Motion is on.
  /// - Returns: The resolved motion.
  func resolved(reduceMotion: Bool) -> Motion {
    reduceMotion ? .reduced : Motion(animation: .spring(duration: duration, bounce: bounce))
  }
}

/// An animation to run, and what it may do.
///
/// - Remark: See `MotionToken`. A screen checks `allowsScale` before a scale effect and
///   `allowsSpatialMotion` before an offset or a zoom, and leaves only the opacity change otherwise.
struct Motion: Equatable, Sendable {
  /// The animation.
  let animation: Animation
  /// Whether it may scale things.
  let allowsScale: Bool
  /// Whether it may move things.
  let allowsSpatialMotion: Bool

  /// Makes a motion that may scale and move.
  ///
  /// - Remark: The normal case; `reduced` is the other.
  /// - SideEffects: none
  /// - Parameter animation: The animation.
  init(animation: Animation) {
    self.init(animation: animation, allowsScale: true, allowsSpatialMotion: true)
  }

  /// Makes a motion.
  ///
  /// - Remark: Private: only the two cases above exist.
  /// - SideEffects: none
  /// - Parameters:
  ///   - animation: The animation.
  ///   - allowsScale: Whether it may scale things.
  ///   - allowsSpatialMotion: Whether it may move things.
  private init(animation: Animation, allowsScale: Bool, allowsSpatialMotion: Bool) {
    self.animation = animation
    self.allowsScale = allowsScale
    self.allowsSpatialMotion = allowsSpatialMotion
  }

  /// What every token becomes with Reduce Motion on: a 0.18 s cross-fade.
  static let reduced = Motion(
    animation: .easeInOut(duration: reducedDuration),
    allowsScale: false,
    allowsSpatialMotion: false
  )

  /// The cross-fade's length, in seconds.
  static let reducedDuration = 0.18

  /// The fold of the process rail and other lists that collapse: 0.4 s, slow then fast, settling
  /// softly (design-language "过程轨道 · 折叠"; smooth closes nine tenths in 180 ms, which reads as
  /// a snap).
  ///
  /// - Remark: Not a spring, so not a token; with Reduce Motion on it is the cross-fade too.
  /// - SideEffects: none
  /// - Parameter reduceMotion: Whether Reduce Motion is on.
  /// - Returns: The motion.
  static func fold(reduceMotion: Bool) -> Motion {
    reduceMotion ? .reduced : Motion(animation: .timingCurve(0.45, 0, 0.15, 1, duration: 0.4))
  }
}

/// Animates changes of a value with a motion token, honouring Reduce Motion.
///
/// - Remark: See `MotionToken`; reads the setting from the environment so callers do not.
private struct TokenAnimation<V: Equatable>: ViewModifier {
  /// The spring.
  let token: MotionToken
  /// The value whose changes animate.
  let value: V
  /// Whether Reduce Motion is on.
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  /// Adds the animation.
  ///
  /// - Remark: See the type.
  /// - SideEffects: none
  /// - Parameter content: The view.
  /// - Returns: The animated view.
  func body(content: Content) -> some View {
    content.animation(token.resolved(reduceMotion: reduceMotion).animation, value: value)
  }
}

extension View {
  /// Animates changes of a value with one of the three springs.
  ///
  /// - Remark: See `MotionToken`.
  /// - SideEffects: none
  /// - Parameters:
  ///   - token: The spring.
  ///   - value: The value to watch.
  /// - Returns: The animated view.
  func motion(_ token: MotionToken, value: some Equatable) -> some View {
    modifier(TokenAnimation(token: token, value: value))
  }
}
