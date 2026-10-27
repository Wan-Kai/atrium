import CoreGraphics
import Foundation
import SwiftUI

/// The desktop's material-icon-theme file icons, as paths the phone can draw.
///
/// - Remark: SPEC-0005 "MP6 定的细节 · MP6a" and design-language "消息流 · 文件胶囊": the same lookups
///   as the desktop's `fileIconName`, by the whole name first, then each extension from the
///   longest; in the light appearance the theme's light variant first. `file-icons.json` is built by
///   `scripts/ios-file-icons.mjs` from the desktop's table; icons that are not plain filled paths are
///   left out of it, so their files get the plain file icon.
nonisolated struct FileIcons: Sendable {
  /// One drawable icon.
  ///
  /// - Remark: Its SVG view box and filled paths, already read.
  struct Icon: Sendable {
    /// The view box.
    let box: CGRect
    /// The paths, with their colours.
    let paths: [Shape]
  }

  /// One filled path of an icon.
  ///
  /// - Remark: `opacity` 1 unless the SVG says otherwise.
  struct Shape: @unchecked Sendable {
    // Unchecked: a CGPath is immutable once made.
    /// The path.
    let path: CGPath
    /// Its fill, as `#rgb` or `#rrggbb`.
    let fill: String
    /// Whether it fills by the even-odd rule.
    let evenOdd: Bool
    /// Its opacity.
    let opacity: Double
  }

  /// The table, read once from the package's resources; `nil` if it cannot be read.
  static let shared: FileIcons? = {
    guard let url = Bundle.module.url(forResource: "file-icons", withExtension: "json"),
      let data = try? Data(contentsOf: url)
    else { return nil }
    return FileIcons(json: data)
  }()

  /// The plain file icon's name.
  let file: String
  /// Whole file names to icons.
  let fileNames: [String: String]
  /// Extensions to icons.
  let fileExtensions: [String: String]
  /// The light appearance's own whole names.
  let lightNames: [String: String]
  /// The light appearance's own extensions.
  let lightExtensions: [String: String]
  /// The icons, by name, as stored.
  private let raw: [String: RawIcon]

  /// Reads the table.
  ///
  /// - Remark: Paths are read when an icon is first drawn, not all at once.
  /// - SideEffects: none
  /// - Parameter json: The resource's bytes.
  init?(json: Data) {
    guard let table = try? JSONDecoder().decode(Table.self, from: json) else { return nil }
    file = table.file
    fileNames = table.fileNames
    fileExtensions = table.fileExtensions
    lightNames = table.light.fileNames
    lightExtensions = table.light.fileExtensions
    raw = table.icons
  }

  /// The icon's name for a file.
  ///
  /// - Remark: See the type; case is ignored, and a leading dot starts an extension (`.env`).
  /// - SideEffects: none
  /// - Parameters:
  ///   - path: The file's path or name.
  ///   - light: Whether the appearance is light.
  /// - Returns: The icon's name.
  func name(for path: String, light: Bool) -> String {
    let name = (path.split(separator: "/").last.map(String.init) ?? path).lowercased()
    let names = light ? [lightNames, fileNames] : [fileNames]
    let extensions = light ? [lightExtensions, fileExtensions] : [fileExtensions]
    if let named = names.lazy.compactMap({ $0[name] }).first { return named }
    var rest = Substring(name)
    while let dot = rest.firstIndex(of: ".") {
      rest = rest[rest.index(after: dot)...]
      if let found = extensions.lazy.compactMap({ $0[String(rest)] }).first { return found }
    }
    return file
  }

  /// A drawable icon by name.
  ///
  /// - Remark: `nil` for an icon the table does not have, or whose paths do not read.
  /// - SideEffects: none
  /// - Parameter name: The icon's name.
  /// - Returns: The icon.
  func icon(named name: String) -> Icon? {
    guard let stored = raw[name], stored.box.count == 4 else { return nil }
    var shapes: [Shape] = []
    for path in stored.paths {
      guard let cgPath = SVGPath.cgPath(path.d) else { return nil }
      shapes.append(Shape(path: cgPath, fill: path.fill, evenOdd: path.evenOdd ?? false, opacity: path.opacity ?? 1))
    }
    return Icon(
      box: CGRect(x: stored.box[0], y: stored.box[1], width: stored.box[2], height: stored.box[3]), paths: shapes)
  }

  /// The resource as stored.
  private struct Table: Decodable {
    let file: String
    let fileNames: [String: String]
    let fileExtensions: [String: String]
    let light: Light
    let icons: [String: RawIcon]
  }

  /// The light appearance's lookups.
  private struct Light: Decodable {
    let fileNames: [String: String]
    let fileExtensions: [String: String]
  }

  /// One icon as stored.
  fileprivate struct RawIcon: Decodable, Sendable {
    let box: [Double]
    let paths: [RawPath]
  }

  /// One path as stored.
  fileprivate struct RawPath: Decodable, Sendable {
    let d: String
    let fill: String
    let evenOdd: Bool?
    let opacity: Double?
  }
}

/// A file's type icon, drawn at a size.
///
/// - Remark: The plain file icon when the table has no icon for it; nothing at all if even that
///   cannot be drawn.
struct FileIconView: View {
  /// The file's path or name.
  let path: String
  /// The width and height.
  var size: CGFloat = 14
  /// Light or dark.
  @Environment(\.colorScheme) private var scheme

  /// The icon.
  var body: some View {
    let icons = FileIcons.shared
    let name = icons?.name(for: path, light: scheme == .light)
    let icon = name.flatMap { icons?.icon(named: $0) } ?? icons.flatMap { $0.icon(named: $0.file) }
    Canvas { context, canvas in
      guard let icon else { return }
      let scale = min(canvas.width / icon.box.width, canvas.height / icon.box.height)
      context.scaleBy(x: scale, y: scale)
      context.translateBy(x: -icon.box.minX, y: -icon.box.minY)
      for shape in icon.paths {
        context.opacity = shape.opacity
        context.fill(
          Path(shape.path), with: .color(Self.color(shape.fill)), style: FillStyle(eoFill: shape.evenOdd))
      }
    }
    .frame(width: size, height: size)
    .accessibilityHidden(true)
  }

  /// A colour from `#rgb` or `#rrggbb`.
  ///
  /// - Remark: Black for anything else, as SVG fills by default.
  /// - SideEffects: none
  /// - Parameter hex: The colour.
  /// - Returns: The colour.
  static func color(_ hex: String) -> Color {
    var digits = hex.hasPrefix("#") ? String(hex.dropFirst()) : hex
    if digits.count == 3 { digits = digits.map { "\($0)\($0)" }.joined() }
    guard digits.count == 6, let value = UInt32(digits, radix: 16) else { return .black }
    return Color(
      red: Double((value >> 16) & 0xFF) / 255, green: Double((value >> 8) & 0xFF) / 255,
      blue: Double(value & 0xFF) / 255)
  }
}
