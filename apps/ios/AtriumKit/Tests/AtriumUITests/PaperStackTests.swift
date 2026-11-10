import SwiftUI
import Testing

@testable import AtriumUI

/// The home empty state's paper stack (design-language "首页空状态插图").
@Suite struct PaperStackTests {
  /// Checks the edges use the tertiary text colour in light and a stronger one in dark.
  ///
  /// - Remark: Dark's tertiary is too close to the paper for the edges to show.
  /// - SideEffects: none
  @Test func edgesShowInBothAppearances() {
    #expect(PaperStack.edge(in: .light) == RGBA(0xd3cbbb))
    #expect(PaperStack.edge(in: .dark) == RGBA(0x8f887b, 0.55))
  }

  /// Checks the shadow is the prototype's warm brown in light and black in dark.
  ///
  /// - Remark: The prototype's `--shadow`.
  /// - SideEffects: none
  @Test func shadowFollowsThePrototype() {
    #expect(PaperStack.shadow(in: .light) == RGBA(0x3c2d14, 0.12))
    #expect(PaperStack.shadow(in: .dark) == RGBA(0x000000, 0.45))
  }
}
