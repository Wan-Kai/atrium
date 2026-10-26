import Foundation
import Testing

@testable import AtriumUI

@Suite("Vortex pattern")
struct VortexPatternTests {
  @Test("keeps the 21 dots of a 5×5 grid inside the circle, corners cut")
  func dots() {
    #expect(VortexPattern.dots.count == 21)
    let corners = [(0, 0), (4, 0), (0, 4), (4, 4)]
    for (column, row) in corners {
      #expect(!VortexPattern.dots.contains { $0.column == column && $0.row == row })
    }
    #expect(VortexPattern.dots.contains { $0.column == 2 && $0.row == 0 })
    #expect(VortexPattern.dots.contains { $0.column == 1 && $0.row == 0 })
    #expect(VortexPattern.dotDiameter == 0.76)
  }

  @Test("lights each dot in one of three steps by the spiral's wave")
  func steps() throws {
    // The centre dot has radius 0 and angle 0, so its wave is cos(−ωt).
    let centre = try #require(VortexPattern.dots.first { $0.radius == 0 })
    let omega = 2 * Double.pi / 1.65
    #expect(VortexPattern.brightness(of: centre, at: 0) == 1)
    #expect(VortexPattern.brightness(of: centre, at: acos(0.3) / omega) == 0.55)
    #expect(VortexPattern.brightness(of: centre, at: acos(-0.3) / omega) == 0.2)
    #expect(VortexPattern.brightness(of: centre, at: acos(0.61) / omega) == 1)
    #expect(VortexPattern.brightness(of: centre, at: acos(0.59) / omega) == 0.55)
    let levels = Set((0..<200).flatMap { VortexPattern.frame(at: Double($0) * 0.01) })
    #expect(levels == [1, 0.55, 0.2])
  }

  @Test("turns once every 1.65 seconds")
  func period() {
    for step in 0..<50 {
      let time = Double(step) * 0.033
      #expect(VortexPattern.frame(at: time) == VortexPattern.frame(at: time + 1.65))
    }
    #expect(VortexPattern.frame(at: 0) != VortexPattern.frame(at: 0.4))
  }

  @Test("shows the same phase for the same moment of the shared clock, however far from 2001")
  func sharedClock() {
    let late = 1.65 * 500_000_000 + 0.3
    let a = VortexPattern.frame(at: late)
    let b = VortexPattern.frame(at: 0.3)
    #expect(zip(a, b).filter { $0 != $1 }.count <= 1)
  }

  @Test("still frame is t = 1.15 s, and the arm shows in it")
  func still() {
    #expect(VortexPattern.stillTime == 1.15)
    let frame = VortexPattern.frame(at: VortexPattern.stillTime)
    #expect(frame.contains(1) && frame.contains(0.2))
  }
}
