import CoreGraphics

/// Spacing, corner radii and the sizes of floating controls on the phone.
///
/// - Remark: An 8pt grid with 4pt halves, from the final prototype; screens use these instead of
///   literal numbers so the rhythm stays one rhythm. Floating controls follow design-language
///   "手机端 · 原则": 44pt round glass buttons, a 58pt "+".
enum Metrics {
  /// Half a step: gaps inside a line.
  static let xxs: CGFloat = 4
  /// One step.
  static let xs: CGFloat = 8
  /// One and a half steps: gaps between pills.
  static let sm: CGFloat = 12
  /// Two steps.
  static let md: CGFloat = 16
  /// The page's side margin.
  static let page: CGFloat = 20
  /// Three steps: between groups.
  static let lg: CGFloat = 24
  /// Four steps: before a section title.
  static let xl: CGFloat = 32

  /// Inline code and small tags.
  static let radiusSmall: CGFloat = 6
  /// Code blocks and diff tool rows.
  static let radiusMedium: CGFloat = 12
  /// The user's bubble.
  static let radiusBubble: CGFloat = 20
  /// Sheets and the drawer.
  static let radiusSheet: CGFloat = 38

  /// A round glass button at the top.
  static let glassButton: CGFloat = 44
  /// The "+" at the bottom right.
  static let floatingAdd: CGFloat = 58
  /// The smallest target a finger can hit.
  static let minimumHit: CGFloat = 44
}
