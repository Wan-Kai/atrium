import Foundation

/// The running indicator's dots and how bright each is at a moment (design-language "会话状态").
///
/// - Remark: A 5×5 grid cut to a circle (radius half the width plus 0.3 cell: 21 dots), each dot
///   0.76 of a cell across. One spiral arm sweeps round: a dot's brightness is one of three steps
///   (1, 0.55, 0.2) by cos(4.4·r / 2 − θ − ωt), jumping between steps like an LED, one turn per
///   1.65 s. Time is absolute, so every indicator on screen turns at the same angle and a new one
///   picks up the current phase. With Reduce Motion on it stops at t = 1.15 s, which still reads as
///   a vortex. Pure, so it is tested on macOS.
nonisolated enum VortexPattern {
  /// One dot of the grid.
  ///
  /// - Remark: Radius and angle are kept so each frame only evaluates the wave.
  struct Dot: Equatable, Sendable {
    /// Its column, from the left, 0 to 4.
    let column: Int
    /// Its row, from the top, 0 to 4.
    let row: Int
    /// Its distance from the centre, in cells.
    let radius: Double
    /// Its direction from the centre, in radians, with rows growing downwards as on screen.
    let angle: Double
  }

  /// The grid's width and height, in cells.
  static let size = 5
  /// A dot's diameter, as a fraction of a cell.
  static let dotDiameter = 0.76
  /// One turn, in seconds.
  static let period = 1.65
  /// The moment shown when nothing may move.
  static let stillTime = 1.15

  /// The dots inside the circle, row by row.
  static let dots: [Dot] = (0..<size).flatMap { row in
    (0..<size).compactMap { column -> Dot? in
      let dx = Double(column - size / 2)
      let dy = Double(row - size / 2)
      let radius = (dx * dx + dy * dy).squareRoot()
      guard radius <= Double(size) / 2 + 0.3 else { return nil }
      return Dot(column: column, row: row, radius: radius, angle: atan2(dy, dx))
    }
  }

  /// How bright a dot is at a moment.
  ///
  /// - Remark: See the type; three steps, no blending.
  /// - SideEffects: none
  /// - Parameters:
  ///   - dot: The dot.
  ///   - time: Seconds on the shared clock.
  /// - Returns: 1, 0.55 or 0.2.
  static func brightness(of dot: Dot, at time: Double) -> Double {
    let omega = 2 * Double.pi / period
    let wave = cos(4.4 * dot.radius / 2 - dot.angle - omega * time)
    if wave > 0.6 { return 1 }
    return wave > 0 ? 0.55 : 0.2
  }

  /// Every dot's brightness at a moment, in the order of `dots`.
  ///
  /// - Remark: The time is reduced modulo the period first, so a clock counting from 2001 keeps
  ///   its precision.
  /// - SideEffects: none
  /// - Parameter time: Seconds on the shared clock.
  /// - Returns: The brightnesses.
  static func frame(at time: Double) -> [Double] {
    let phase = time.truncatingRemainder(dividingBy: period)
    return dots.map { brightness(of: $0, at: phase) }
  }
}
