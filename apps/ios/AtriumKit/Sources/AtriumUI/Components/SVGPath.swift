import CoreGraphics
import Foundation

/// Reads the `d` of an SVG `<path>` into a Core Graphics path.
///
/// - Remark: For the file icons (SPEC-0005 "MP6 定的细节 · MP6a"), which are filled paths only:
///   every command of SVG 1.1 (M L H V C S Q T A Z, absolute and relative), numbers that run
///   together (`1-2.5.5`) and arc flags written without spaces. Anything else makes it give up.
nonisolated enum SVGPath {
  /// Reads a path.
  ///
  /// - Remark: See the type.
  /// - SideEffects: none
  /// - Parameter data: The path's `d`.
  /// - Returns: The path, or `nil` when it cannot be read.
  static func cgPath(_ data: String) -> CGPath? {
    var reader = Reader(Array(data.utf8))
    let path = CGMutablePath()
    var current = CGPoint.zero
    var start = CGPoint.zero
    var control: CGPoint?
    var previous: UInt8 = 0
    var started = false
    while let command = reader.command(after: previous) {
      let relative = command >= UInt8(ascii: "a")
      let base = relative ? current : .zero
      let upper = relative ? command - 32 : command
      if !started, upper != UInt8(ascii: "M") { return nil }
      switch upper {
      case UInt8(ascii: "M"):
        guard let point = reader.point(base) else { return nil }
        path.move(to: point)
        (current, start, started) = (point, point, true)
        control = nil
        // Pairs after a move are lines.
        previous = relative ? UInt8(ascii: "l") : UInt8(ascii: "L")
        continue
      case UInt8(ascii: "L"):
        guard let point = reader.point(base) else { return nil }
        path.addLine(to: point)
        current = point
        control = nil
      case UInt8(ascii: "H"):
        guard let x = reader.number() else { return nil }
        current = CGPoint(x: x + base.x, y: current.y)
        path.addLine(to: current)
        control = nil
      case UInt8(ascii: "V"):
        guard let y = reader.number() else { return nil }
        current = CGPoint(x: current.x, y: y + base.y)
        path.addLine(to: current)
        control = nil
      case UInt8(ascii: "C"):
        guard let first = reader.point(base), let second = reader.point(base), let end = reader.point(base) else {
          return nil
        }
        path.addCurve(to: end, control1: first, control2: second)
        (current, control) = (end, second)
      case UInt8(ascii: "S"):
        guard let second = reader.point(base), let end = reader.point(base) else { return nil }
        let isCubic = [UInt8(ascii: "C"), UInt8(ascii: "S")].contains(previous & ~32)
        let first = isCubic ? reflect(control ?? current, around: current) : current
        path.addCurve(to: end, control1: first, control2: second)
        (current, control) = (end, second)
      case UInt8(ascii: "Q"):
        guard let middle = reader.point(base), let end = reader.point(base) else { return nil }
        path.addQuadCurve(to: end, control: middle)
        (current, control) = (end, middle)
      case UInt8(ascii: "T"):
        guard let end = reader.point(base) else { return nil }
        let isQuadratic = [UInt8(ascii: "Q"), UInt8(ascii: "T")].contains(previous & ~32)
        let middle = isQuadratic ? reflect(control ?? current, around: current) : current
        path.addQuadCurve(to: end, control: middle)
        (current, control) = (end, middle)
      case UInt8(ascii: "A"):
        guard let rx = reader.number(), let ry = reader.number(), let rotation = reader.number(),
          let large = reader.flag(), let sweep = reader.flag(), let end = reader.point(base)
        else { return nil }
        arc(
          path, from: current, to: end, radii: CGSize(width: abs(rx), height: abs(ry)), rotation: rotation,
          large: large, sweep: sweep)
        current = end
        control = nil
      case UInt8(ascii: "Z"):
        path.closeSubpath()
        current = start
        control = nil
      default:
        return nil
      }
      previous = command
    }
    return reader.atEnd && started ? path : nil
  }

  /// A control point mirrored through the current point, for the smooth curves.
  ///
  /// - Remark: SVG's "reflection of the second control point".
  /// - SideEffects: none
  /// - Parameters:
  ///   - point: The last control point.
  ///   - center: The current point.
  /// - Returns: The mirrored point.
  private static func reflect(_ point: CGPoint, around center: CGPoint) -> CGPoint {
    CGPoint(x: 2 * center.x - point.x, y: 2 * center.y - point.y)
  }

  /// Adds an elliptical arc given as SVG gives it, by its end points.
  ///
  /// - Remark: SVG 1.1 implementation notes F.6.5: to its centre and angles, radii grown when too
  ///   small, then drawn as a unit circle's arc under a transform.
  /// - SideEffects: Adds to the path.
  /// - Parameters:
  ///   - path: The path.
  ///   - from: Where it starts.
  ///   - to: Where it ends.
  ///   - radii: Its radii.
  ///   - rotation: Its x axis's rotation, in degrees.
  ///   - large: Whether to take the larger arc.
  ///   - sweep: Whether to go the positive-angle way.
  private static func arc(
    _ path: CGMutablePath, from: CGPoint, to: CGPoint, radii: CGSize, rotation: Double, large: Bool, sweep: Bool
  ) {
    guard from != to else { return }
    guard radii.width > 0, radii.height > 0 else {
      path.addLine(to: to)
      return
    }
    let phi = rotation * .pi / 180
    let (cosPhi, sinPhi) = (cos(phi), sin(phi))
    let dx = (from.x - to.x) / 2
    let dy = (from.y - to.y) / 2
    let x1 = cosPhi * dx + sinPhi * dy
    let y1 = -sinPhi * dx + cosPhi * dy
    var rx = radii.width
    var ry = radii.height
    let grow = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry)
    if grow > 1 { (rx, ry) = (rx * grow.squareRoot(), ry * grow.squareRoot()) }
    let numerator = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1
    let denominator = rx * rx * y1 * y1 + ry * ry * x1 * x1
    let factor = (large == sweep ? -1.0 : 1.0) * (max(0, numerator) / denominator).squareRoot()
    let cx1 = factor * rx * y1 / ry
    let cy1 = -factor * ry * x1 / rx
    let center = CGPoint(
      x: cosPhi * cx1 - sinPhi * cy1 + (from.x + to.x) / 2, y: sinPhi * cx1 + cosPhi * cy1 + (from.y + to.y) / 2)
    let startAngle = atan2((y1 - cy1) / ry, (x1 - cx1) / rx)
    var delta = atan2((-y1 - cy1) / ry, (-x1 - cx1) / rx) - startAngle
    if sweep, delta < 0 { delta += 2 * .pi }
    if !sweep, delta > 0 { delta -= 2 * .pi }
    let transform = CGAffineTransform(translationX: center.x, y: center.y).rotated(by: phi).scaledBy(x: rx, y: ry)
    path.addRelativeArc(center: .zero, radius: 1, startAngle: startAngle, delta: delta, transform: transform)
  }

  /// Reads the numbers and commands of a path, one at a time.
  ///
  /// - Remark: Separators are spaces and commas; a sign or a second dot starts a new number.
  private struct Reader {
    /// The path's bytes.
    let bytes: [UInt8]
    /// Where reading is.
    var index = 0

    /// Starts at the beginning.
    ///
    /// - Remark: See the type.
    /// - SideEffects: none
    /// - Parameter bytes: The path's bytes.
    init(_ bytes: [UInt8]) { self.bytes = bytes }

    /// Whether only separators are left.
    var atEnd: Bool {
      var copy = self
      copy.skip()
      return copy.index >= copy.bytes.count
    }

    /// The next command letter, or the previous one again when a number follows instead.
    ///
    /// - Remark: SVG lets a command repeat without its letter.
    /// - SideEffects: Moves past the letter.
    /// - Parameter previous: The last command, `0` before the first.
    /// - Returns: The command, or `nil` at the end or for a stray byte.
    mutating func command(after previous: UInt8) -> UInt8? {
      skip()
      guard index < bytes.count else { return nil }
      let byte = bytes[index]
      if (byte | 32) >= UInt8(ascii: "a"), (byte | 32) <= UInt8(ascii: "z") {
        index += 1
        return byte
      }
      let startsNumber =
        byte == UInt8(ascii: "-") || byte == UInt8(ascii: "+") || byte == UInt8(ascii: ".")
        || (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(byte)
      guard startsNumber, previous != 0, previous | 32 != UInt8(ascii: "z") else { return nil }
      return previous
    }

    /// A point, added to a base for a relative command.
    ///
    /// - Remark: Two numbers.
    /// - SideEffects: Moves past them.
    /// - Parameter base: The current point for a relative command, zero otherwise.
    /// - Returns: The point.
    mutating func point(_ base: CGPoint) -> CGPoint? {
      guard let x = number(), let y = number() else { return nil }
      return CGPoint(x: base.x + x, y: base.y + y)
    }

    /// An arc's flag: a single `0` or `1`.
    ///
    /// - Remark: Flags need no separator before the next number.
    /// - SideEffects: Moves past it.
    /// - Returns: The flag.
    mutating func flag() -> Bool? {
      skip()
      guard index < bytes.count, bytes[index] == UInt8(ascii: "0") || bytes[index] == UInt8(ascii: "1") else {
        return nil
      }
      index += 1
      return bytes[index - 1] == UInt8(ascii: "1")
    }

    /// A number.
    ///
    /// - Remark: An optional sign, digits with at most one dot, an optional exponent.
    /// - SideEffects: Moves past it.
    /// - Returns: The number.
    mutating func number() -> Double? {
      skip()
      let begin = index
      if index < bytes.count, bytes[index] == UInt8(ascii: "-") || bytes[index] == UInt8(ascii: "+") { index += 1 }
      var dot = false
      var digits = false
      while index < bytes.count {
        let byte = bytes[index]
        if (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(byte) {
          digits = true
        } else if byte == UInt8(ascii: "."), !dot {
          dot = true
        } else {
          break
        }
        index += 1
      }
      if digits, index < bytes.count, bytes[index] | 32 == UInt8(ascii: "e") {
        index += 1
        if index < bytes.count, bytes[index] == UInt8(ascii: "-") || bytes[index] == UInt8(ascii: "+") { index += 1 }
        while index < bytes.count, (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(bytes[index]) { index += 1 }
      }
      guard digits else {
        index = begin
        return nil
      }
      return Double(String(decoding: bytes[begin..<index], as: UTF8.self))
    }

    /// Moves past spaces and commas.
    ///
    /// - Remark: See the type.
    /// - SideEffects: Moves.
    mutating func skip() {
      while index < bytes.count, [0x20, 0x09, 0x0A, 0x0D, UInt8(ascii: ",")].contains(bytes[index]) { index += 1 }
    }
  }
}
