import SwiftUI

/// A button that shrinks a little under the finger and springs back.
///
/// - Remark: design-language "动效 · 按下的实体感": 0.95 for text buttons and pills, 0.9 for
///   small icon buttons, 0.985 for whole rows; released with snappy. With Reduce Motion on it
///   does not scale and dims instead, since the token forbids scaling.
struct PressStyle: ButtonStyle {
  /// How small it gets while pressed.
  let scale: CGFloat
  /// Whether Reduce Motion is on.
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  /// Makes the style.
  ///
  /// - Remark: Defaults to the pill's 0.95.
  /// - SideEffects: none
  /// - Parameter scale: How small it gets while pressed.
  init(scale: CGFloat = 0.95) {
    self.scale = scale
  }

  /// Draws the label, smaller or dimmer while pressed.
  ///
  /// - Remark: See the type.
  /// - SideEffects: none
  /// - Parameter configuration: The label and whether it is pressed.
  /// - Returns: The button's look.
  func makeBody(configuration: Configuration) -> some View {
    let motion = MotionToken.snappy.resolved(reduceMotion: reduceMotion)
    configuration.label
      .scaleEffect(configuration.isPressed && motion.allowsScale ? scale : 1)
      .opacity(configuration.isPressed && !motion.allowsScale ? 0.6 : 1)
      .animation(motion.animation, value: configuration.isPressed)
  }
}
