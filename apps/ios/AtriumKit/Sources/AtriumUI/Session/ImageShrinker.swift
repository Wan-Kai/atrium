import Foundation
import ImageIO
import UniformTypeIdentifiers

/// Shrinks a picked photo into a JPEG small enough for `upload_attachment`.
///
/// - Remark: SPEC-0005 "MP5 定的细节 · MP5c": the long side at most 2048, then lower JPEG quality
///   until it fits ``maxBytes`` (1,000,000 characters once in base64). ImageIO, so it runs on macOS
///   in tests as on the phone, and honours the photo's orientation.
enum ImageShrinker {
  /// The most bytes an image may have: its base64 is then at most 1,000,000 characters.
  static let maxBytes = 750_000
  /// The longest side kept, in pixels.
  static let maxSide = 2048
  /// The JPEG qualities tried, best first.
  private static let qualities: [Double] = [0.82, 0.7, 0.55, 0.4, 0.28, 0.18]

  /// The photo as a JPEG that fits, or `nil` when it is not an image or will not fit.
  ///
  /// - Remark: See the type.
  /// - SideEffects: none
  /// - Parameter data: The photo's bytes, in any format ImageIO reads.
  /// - Returns: The JPEG.
  static func jpeg(from data: Data) -> Data? {
    guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
    let options: [CFString: Any] = [
      kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true,
      kCGImageSourceThumbnailMaxPixelSize: maxSide,
    ]
    guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
    for quality in qualities {
      let output = NSMutableData()
      guard let destination = CGImageDestinationCreateWithData(output, UTType.jpeg.identifier as CFString, 1, nil)
      else { return nil }
      CGImageDestinationAddImage(
        destination, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
      guard CGImageDestinationFinalize(destination) else { return nil }
      if output.length <= maxBytes { return output as Data }
    }
    return nil
  }
}
