import CoreGraphics
import Testing

@testable import AtriumUI

@Suite("File icons")
struct FileIconTests {
  @Test("finds an icon by the whole name first, then the longest extension, then the plain file")
  func lookup() throws {
    let icons = try #require(FileIcons.shared)
    #expect(icons.name(for: "src/cache/ttl.ts", light: false) == "typescript")
    #expect(icons.name(for: "Package.swift", light: false) == icons.name(for: "package.swift", light: false))
    #expect(icons.name(for: "README.md", light: false) != icons.file)
    #expect(icons.name(for: "noextension", light: false) == icons.file)
    #expect(icons.name(for: "a.unknownthing", light: false) == icons.file)
    #expect(icons.icon(named: icons.file) != nil)
  }

  @Test("reads every icon the table names")
  func everyIcon() throws {
    let icons = try #require(FileIcons.shared)
    let named = Set(icons.fileNames.values).union(icons.fileExtensions.values).union(icons.lightNames.values)
      .union(icons.lightExtensions.values).union([icons.file])
    #expect(named.filter { icons.icon(named: $0) == nil }.sorted() == [])
  }

  @Test("prefers an icon's light variant in the light appearance")
  func light() throws {
    let icons = try #require(FileIcons.shared)
    let lightOnly = try #require(icons.lightExtensions.first)
    #expect(icons.name(for: "x.\(lightOnly.key)", light: true) == lightOnly.value)
  }
}

@Suite("SVG path")
struct SVGPathTests {
  @Test("draws absolute and relative lines and closes the shape")
  func lines() throws {
    let path = try #require(SVGPath.cgPath("M2 2v12h12V2zm4 6h3"))
    #expect(path.boundingBoxOfPath == CGRect(x: 2, y: 2, width: 12, height: 12))
  }

  @Test("draws curves, smooth curves and quadratics")
  func curves() throws {
    let path = try #require(SVGPath.cgPath("M0 0C0 10 10 10 10 0S20-10 20 0Q25 5 30 0T40 0"))
    let box = path.boundingBoxOfPath
    #expect(box.minX == 0)
    #expect(box.maxX == 40)
  }

  @Test("draws arcs, with numbers that run together")
  func arcs() throws {
    let path = try #require(SVGPath.cgPath("M0 5a5 5 0 1 0 10 0a5 5 0 1 0-10 0"))
    let box = path.boundingBoxOfPath
    #expect(abs(box.width - 10) < 0.01)
    #expect(abs(box.height - 10) < 0.01)
    let flags = try #require(SVGPath.cgPath("M0 5a5 5 0 1010 0z"))
    #expect(abs(flags.boundingBoxOfPath.width - 10) < 0.01)
  }

  @Test("gives up on what it cannot read")
  func invalid() {
    #expect(SVGPath.cgPath("M0 0 X 4") == nil)
    #expect(SVGPath.cgPath("L1") == nil)
  }
}
