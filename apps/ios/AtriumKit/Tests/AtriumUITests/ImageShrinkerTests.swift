import CoreGraphics
import Foundation
import ImageIO
import Testing
import UniformTypeIdentifiers

@testable import AtriumUI

/// A noisy PNG of a size, which compresses badly, as a photo does.
///
/// - Remark: Noise so the encoder cannot shrink it to nothing.
/// - SideEffects: none
/// - Parameters:
///   - width: Its width.
///   - height: Its height.
/// - Returns: The PNG's bytes.
/// - Throws: When the image cannot be drawn.
func noisyPNG(width: Int, height: Int) throws -> Data {
  var pixels = [UInt8](repeating: 0, count: width * height * 4)
  var seed: UInt32 = 7
  for index in pixels.indices {
    seed = seed &* 1_664_525 &+ 1_013_904_223
    pixels[index] = UInt8(truncatingIfNeeded: seed >> 24)
  }
  let context = try #require(
    CGContext(
      data: &pixels, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue))
  let image = try #require(context.makeImage())
  let data = NSMutableData()
  let destination = try #require(CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil))
  CGImageDestinationAddImage(destination, image, nil)
  #expect(CGImageDestinationFinalize(destination))
  return data as Data
}

@Suite("Image shrinker")
struct ImageShrinkerTests {
  @Test("makes a JPEG no longer than 2048 on its long side and small enough to upload")
  func shrinks() throws {
    let shrunk = try #require(ImageShrinker.jpeg(from: try noisyPNG(width: 3000, height: 1500)))
    #expect(shrunk.count <= ImageShrinker.maxBytes)
    let source = try #require(CGImageSourceCreateWithData(shrunk as CFData, nil))
    #expect(CGImageSourceGetType(source) as String? == UTType.jpeg.identifier)
    let properties = try #require(CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any])
    #expect(properties[kCGImagePropertyPixelWidth] as? Int == 2048)
    #expect(properties[kCGImagePropertyPixelHeight] as? Int == 1024)
  }

  @Test("keeps a small image's size")
  func small() throws {
    let shrunk = try #require(ImageShrinker.jpeg(from: try noisyPNG(width: 300, height: 200)))
    let source = try #require(CGImageSourceCreateWithData(shrunk as CFData, nil))
    let properties = try #require(CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any])
    #expect(properties[kCGImagePropertyPixelWidth] as? Int == 300)
  }

  @Test("gives up on what is not an image")
  func notAnImage() {
    #expect(ImageShrinker.jpeg(from: Data("not an image".utf8)) == nil)
  }

  @Test("allows at most 750,000 bytes, which is 1,000,000 characters of base64")
  func limit() {
    #expect(ImageShrinker.maxBytes == 750_000)
    #expect(Data(count: ImageShrinker.maxBytes).base64EncodedString().count == 1_000_000)
  }
}
