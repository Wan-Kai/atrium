import Foundation

/// The pixel cat illustration as a 32×32 grid of cells (design-language "像素猫插图").
///
/// - Remark: Drawn with Atrium's rounded-square dots; the outline, ears and nose follow the brand
///   cat `atrium.svg`, made cuter: a rounder head, 2×3 eyes with a highlight, two blushes, pink
///   inside the ears; sitting, it shows two paws with a gap between and its tail curled beside it.
///   The shapes are the final prototype's (`mobile-app-final-prototype.html`, `pxMap`), ported
///   cell for cell so the phone matches what was chosen. Pure, so the grid is tested on macOS;
///   `PixelCatView` paints it.
nonisolated enum PixelCat {
  /// The grid's width and height.
  static let size = 32

  /// Where the cat is.
  ///
  /// - Remark: The five uses design-language lists.
  enum Scene: Equatable, Sendable, CaseIterable {
    /// Sitting on nothing, small (the new session page).
    case sit
    /// Sitting in a grey-blue tile, like an app icon (nothing yet, pairing).
    case tile
    /// Peeking out of a folder, front paws on its edge (no projects yet).
    case peek
    /// Asleep in a faded tile, eyes shut (revoked).
    case asleep
    /// In the tile with a green dot tick at the bottom right (paired).
    case paired
  }

  /// A momentary change of the idle cat.
  ///
  /// - Remark: See `PixelCatIdle` for when each happens.
  struct Pose: Hashable, Sendable {
    /// The eyes shut to one line.
    var blink = false
    /// The head one cell to the right.
    var tilt = false
    /// The left ear bent down.
    var flick = false

    /// The cat at rest.
    static let rest = Pose()
  }

  /// What one cell holds.
  ///
  /// - Remark: Kinds, not colours: `PixelCatColors` colours them per appearance.
  enum Cell: Equatable, Sendable {
    /// Background: a very faint dot inside the circle (not drawn when sitting on nothing).
    case empty
    /// Outside the tile: not drawn.
    case outside
    /// The body, cream shading darker downwards.
    case body
    /// An eye.
    case eye
    /// The highlight in an eye.
    case highlight
    /// The nose.
    case nose
    /// A blush.
    case blush
    /// The pink inside an ear.
    case ear
    /// A shade between paws and toes.
    case toe
    /// The grey-blue of things that are not the cat: the tile, the folder.
    case tile
    /// The folder's back tab, lighter.
    case tab
    /// The green of the "paired" badge.
    case ok
    /// The tick inside the badge.
    case check
    /// The warm grey ring round the cat in light mode.
    case outline
  }

  /// The cells of a scene in a pose, row by row from the top.
  ///
  /// - Remark: See the type.
  /// - SideEffects: none
  /// - Parameters:
  ///   - scene: Where the cat is.
  ///   - pose: Blink, tilt or flick; ignored asleep, where the eyes stay shut.
  /// - Returns: `size` rows of `size` cells.
  static func grid(_ scene: Scene, pose: Pose = .rest) -> [[Cell]] {
    var grid = Grid()
    if scene == .peek {
      drawPeek(&grid, pose: pose)
    } else {
      for row in 0..<size {
        for column in 0..<size {
          grid[row, column] =
            scene == .sit ? .empty : insideRoundedSquare(row, column, radius: 6) ? .tile : .outside
        }
      }
      var resting = pose
      if scene == .asleep {
        resting = Pose(blink: true)
      }
      drawCat(&grid, rowOffset: 1, sitting: true, pose: resting)
      grid.replaceGaps(with: scene == .sit ? .empty : .tile)
      if scene == .paired {
        drawBadge(&grid)
      }
    }
    grid.replaceGaps(with: .empty)
    grid.outlineCat()
    return grid.cells.map { $0.map { $0 ?? .empty } }
  }

  /// Tells whether a cell lies in a square of the whole grid with rounded corners.
  ///
  /// - Remark: The tile's outline.
  /// - SideEffects: none
  /// - Parameters:
  ///   - row: The row.
  ///   - column: The column.
  ///   - radius: The corner radius, in cells.
  /// - Returns: Whether it is inside.
  private static func insideRoundedSquare(_ row: Int, _ column: Int, radius: Double) -> Bool {
    let edge = Double(size) - radius
    let dx = max(radius - Double(column) - 0.5, 0, Double(column) + 0.5 - edge)
    let dy = max(radius - Double(row) - 0.5, 0, Double(row) + 0.5 - edge)
    return dx * dx + dy * dy <= radius * radius
  }

  /// Draws the folder and the cat peeking out of it, paws on its edge.
  ///
  /// - Remark: The folder's front covers the cat's lower half; a light shade over the paws parts
  ///   them from the chin.
  /// - SideEffects: Writes into the grid.
  /// - Parameters:
  ///   - grid: The grid.
  ///   - pose: The pose.
  private static func drawPeek(_ grid: inout Grid, pose: Pose) {
    for row in 18..<22 {
      for column in 1..<10 where !(row == 18 && (column == 1 || column == 9)) {
        grid[row, column] = .tab
      }
    }
    drawCat(&grid, rowOffset: 0, sitting: false, pose: pose)
    for row in 21..<size {
      for column in 0..<size {
        grid[row, column] = insideRoundedSquare(row - 10, column, radius: 4) ? .tile : .empty
      }
    }
    for left in [8, 19] {
      for row in 20..<23 {
        for column in left..<(left + 5) where !(row == 22 && (column == left || column == left + 4)) {
          grid[row, column] = .body
        }
      }
      grid[22, left + 1] = .toe
      grid[22, left + 3] = .toe
      for column in left..<(left + 5) where grid[19, column] == .body {
        grid[19, column] = .toe
      }
    }
  }

  /// Draws the green badge with a tick at the bottom right.
  ///
  /// - Remark: The badge sits on the tile with a ring of tile round it, so it reads apart from the
  ///   cat's tail.
  /// - SideEffects: Writes into the grid.
  /// - Parameter grid: The grid.
  private static func drawBadge(_ grid: inout Grid) {
    for row in 18..<size {
      for column in 18..<size {
        let distance = hypot(Double(column) + 0.5 - 26, Double(row) + 0.5 - 26)
        if distance <= 4.6 {
          grid[row, column] = .ok
        } else if distance <= 5.7 && grid[row, column] != .outside {
          grid[row, column] = .tile
        }
      }
    }
    for (column, row) in [(24, 26), (25, 27), (26, 26), (27, 25), (28, 24), (23, 25)] {
      grid[row, column] = .check
    }
  }

  /// Draws the cat: head and ears, eyes, nose, blushes, and when sitting its body, tail and paws.
  ///
  /// - Remark: Shapes are ellipses and triangles sampled at each cell's centre, as the prototype
  ///   does. A tilt moves the upper head one cell right; a flick bends the left ear's tip down.
  /// - SideEffects: Writes into the grid.
  /// - Parameters:
  ///   - grid: The grid.
  ///   - rowOffset: How far the head sits below the top.
  ///   - sitting: Whether to draw the body.
  ///   - pose: The pose.
  private static func drawCat(_ grid: inout Grid, rowOffset: Int, sitting: Bool, pose: Pose) {
    let dy = Double(rowOffset)
    let left = ear(left: true, dy: dy, flick: pose.flick)
    let right = ear(left: false, dy: dy, flick: pose.flick)
    for row in 0..<size {
      for column in 0..<size {
        let y = Double(row) + 0.5
        let x0 = Double(column) + 0.5
        let x = x0 - (pose.tilt && y < 13 + dy ? 1 : 0)
        if sitting {
          if inEllipse(x0, y, 16, 25.6, 8.6, 6.4) && y < 28.6 { grid[row, column] = .body }
          let distance = hypot(x0 - 21, y - 25)
          let angle = atan2(y - 25, x0 - 21)
          if distance > 6.2 && distance < 8.3 && angle > -0.9 && angle < 1.75 && y < 31 {
            grid[row, column] = .body
          }
          if inEllipse(x0, y, 12.6, 29, 2.3, 1.5) || inEllipse(x0, y, 19.4, 29, 2.3, 1.5) {
            grid[row, column] = .body
          }
        }
        if inEllipse(x, y, 16, 12.8 + dy, 10.4, 8.6) || inTriangle(x, y, left.outer)
          || inTriangle(x, y, right.outer)
        {
          grid[row, column] = .body
        }
        if inTriangle(x, y, left.inner) || inTriangle(x, y, right.inner) { grid[row, column] = .ear }
      }
    }
    let shift = { (row: Int) in pose.tilt && Double(row) < 13 + dy ? 1 : 0 }
    for eyeColumn in [11, 19] {
      for row in 12..<15 {
        for column in eyeColumn..<(eyeColumn + 2) {
          let shifted = row + rowOffset
          let cell = column + shift(shifted)
          if pose.blink {
            if row == 13 { grid[shifted, cell] = .eye }
          } else {
            grid[shifted, cell] = row == 12 && column == eyeColumn ? .highlight : .eye
          }
        }
      }
    }
    let faceRow = 16 + rowOffset
    grid[faceRow, 15 + shift(faceRow)] = .nose
    grid[faceRow, 16 + shift(faceRow)] = .nose
    for blush in [8, 22] {
      grid[faceRow, blush + shift(faceRow)] = .blush
      grid[faceRow, blush + 1 + shift(faceRow)] = .blush
    }
    if sitting {
      for (row, column) in [(28, 15), (28, 16), (29, 16), (29, 15)] { grid.markGap(row, column) }
      for column in [11, 13, 18, 20] { grid[29, column] = .toe }
      for column in [11, 12, 13, 14, 17, 18, 19, 20] where grid[27, column] == .body { grid[27, column] = .toe }
    }
  }

  /// An ear's outer and inner triangles.
  ///
  /// - Remark: The right ear mirrors the left; only the left one flicks.
  /// - SideEffects: none
  /// - Parameters:
  ///   - left: Which ear.
  ///   - dy: How far the head sits below the top.
  ///   - flick: Whether the left ear is bent.
  /// - Returns: The two triangles.
  private static func ear(left: Bool, dy: Double, flick: Bool) -> (outer: [SIMD2<Double>], inner: [SIMD2<Double>]) {
    let mirror = { (point: SIMD2<Double>) in left ? point : SIMD2(32 - point.x, point.y) }
    let bent = left && flick
    let tip = bent ? SIMD2(4.6, 3.2 + dy) : SIMD2(6.4, 1.6 + dy)
    return (
      [mirror(tip), mirror(SIMD2(7.6, 10.5 + dy)), mirror(SIMD2(14, 5.8 + dy))],
      [mirror(SIMD2(bent ? 6 : 7.6, 4.4 + dy)), mirror(SIMD2(8.6, 8.8 + dy)), mirror(SIMD2(11.8, 6.6 + dy))]
    )
  }

  /// Tells whether a point lies in an axis-aligned ellipse.
  ///
  /// - Remark: Boundary included, as in the prototype.
  /// - SideEffects: none
  /// - Parameters:
  ///   - x: The point's x.
  ///   - y: The point's y.
  ///   - cx: The centre's x.
  ///   - cy: The centre's y.
  ///   - rx: The horizontal radius.
  ///   - ry: The vertical radius.
  /// - Returns: Whether it is inside.
  private static func inEllipse(
    _ x: Double, _ y: Double, _ cx: Double, _ cy: Double, _ rx: Double, _ ry: Double
  ) -> Bool {
    let u = (x - cx) / rx
    let v = (y - cy) / ry
    return u * u + v * v <= 1
  }

  /// Tells whether a point lies in a triangle.
  ///
  /// - Remark: By the signs of the three edge functions; the boundary counts as inside.
  /// - SideEffects: none
  /// - Parameters:
  ///   - x: The point's x.
  ///   - y: The point's y.
  ///   - corners: The three corners.
  /// - Returns: Whether it is inside.
  private static func inTriangle(_ x: Double, _ y: Double, _ corners: [SIMD2<Double>]) -> Bool {
    let point = SIMD2(x, y)
    let side = { (p: SIMD2<Double>, q: SIMD2<Double>, r: SIMD2<Double>) in
      (p.x - r.x) * (q.y - r.y) - (q.x - r.x) * (p.y - r.y)
    }
    let d1 = side(point, corners[0], corners[1])
    let d2 = side(point, corners[1], corners[2])
    let d3 = side(point, corners[2], corners[0])
    let negative = d1 < 0 || d2 < 0 || d3 < 0
    let positive = d1 > 0 || d2 > 0 || d3 > 0
    return !(negative && positive)
  }
}

/// The grid while it is drawn: cells, with gaps marked between the paws until the scene fills them.
///
/// - Remark: `nil` marks a gap, the prototype's `"x?"`: between the paws it shows the tile, or
///   nothing when sitting on nothing.
nonisolated private struct Grid {
  /// The cells; `nil` is a gap.
  var cells: [[PixelCat.Cell?]] = Array(
    repeating: Array(repeating: PixelCat.Cell.empty, count: PixelCat.size),
    count: PixelCat.size
  )

  /// A cell, `.outside` beyond the edges; writes beyond the edges are dropped.
  ///
  /// - Remark: Shapes are sampled over the whole grid and may reach past it, as in the prototype.
  /// - SideEffects: Setting writes into the grid.
  subscript(row: Int, column: Int) -> PixelCat.Cell? {
    get {
      guard (0..<PixelCat.size).contains(row), (0..<PixelCat.size).contains(column) else { return .outside }
      return cells[row][column]
    }
    set {
      guard (0..<PixelCat.size).contains(row), (0..<PixelCat.size).contains(column) else { return }
      cells[row][column] = newValue
    }
  }

  /// Marks a cell as a gap.
  ///
  /// - Remark: See the type.
  /// - SideEffects: Writes into the grid.
  /// - Parameters:
  ///   - row: The row.
  ///   - column: The column.
  mutating func markGap(_ row: Int, _ column: Int) {
    self[row, column] = nil
  }

  /// Fills every gap.
  ///
  /// - Remark: See the type.
  /// - SideEffects: Writes into the grid.
  /// - Parameter cell: What the gaps become.
  mutating func replaceGaps(with cell: PixelCat.Cell) {
    cells = cells.map { $0.map { $0 ?? cell } }
  }

  /// Rings the cat: every empty cell next to a cat cell becomes outline.
  ///
  /// - Remark: Four neighbours, so the ring is one cell wide and does not cut corners. Outline is
  ///   no cat cell, so the ring does not grow from itself.
  /// - SideEffects: Writes into the grid.
  mutating func outlineCat() {
    let cat: Set<PixelCat.Cell> = [.body, .eye, .highlight, .nose, .blush, .ear, .toe]
    for row in 0..<PixelCat.size {
      for column in 0..<PixelCat.size where cells[row][column] == .empty {
        let neighbours = [self[row + 1, column], self[row - 1, column], self[row, column + 1], self[row, column - 1]]
        if neighbours.contains(where: { $0.map(cat.contains) ?? false }) {
          cells[row][column] = .outline
        }
      }
    }
  }
}
