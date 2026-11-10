import AtriumProtocol
import AtriumRender
import SwiftUI

/// One file's diff (design-language "手机端 · 改动与 diff").
///
/// - Remark: SF Mono 11.5pt on 19pt lines, unwrapped by default; each hunk's header sticks to the
///   top of the scroll view while its lines pass under it (glassy page colour, a hairline below);
///   long unchanged stretches fold into "展开 N 行" (`DiffLayout`): those inside a hunk open in
///   place, those between hunks request version-matched context (`onOpenGap`). The caller must
///   match the diff's old/new revisions, not read the working tree for a merge-base/HEAD diff.
///   Added lines sit on
///   `--add-bg` with a 2pt green bar, deleted ones on `--del-bg` with a red bar and dimmed text;
///   the number column is 34pt, `--l3`, with "+" or "−" after it. Each hunk scrolls sideways on its
///   own so the sticky headers stay put (the prototype scrolls the whole file sideways; SwiftUI
///   cannot pin a header inside a horizontal scroll view). `highlight` colours a line's code.
struct DiffView: View {
  /// The file's hunks.
  let hunks: [DiffHunk]
  /// Whether long lines wrap instead of scrolling sideways.
  var wrap = false
  /// Colours a line of code; plain by default.
  var highlight: (String) -> AttributedString = { AttributedString($0) }
  /// Opens a gap between hunks: its count and where it starts in the old and new file.
  var onOpenGap: ((Int, Int, Int) -> Void)?
  /// Light or dark.
  @Environment(\.colorScheme) private var scheme
  /// The folds inside hunks that were opened, by their place among the segments.
  @State private var opened: Set<Int> = []
  /// Minimum line fill width, measured from the file's viewport rather than its shortest line.
  @State private var viewportWidth: CGFloat = 0

  /// The hunks, with sticky headers.
  var body: some View {
    let palette = Palette(scheme: scheme)
    let groups = Self.group(DiffLayout.segments(hunks))
    LazyVStack(alignment: .leading, spacing: 0, pinnedViews: .sectionHeaders) {
      ForEach(groups, id: \.id) { group in
        if let gap = group.gap {
          gapButton(gap, palette)
        }
        if let header = group.header {
          Section {
            lines(group.body, palette)
          } header: {
            hunkHeader(header, palette)
          }
          // The toolbar's "上一处 / 下一处" scroll to a hunk by its place.
          .id(group.id)
        }
      }
    }
    .font(Typography.diff)
    .onGeometryChange(for: CGFloat.self) {
      $0.size.width
    } action: {
      viewportWidth = $0
    }
  }

  /// A hunk's lines, sideways-scrolling unless wrapping.
  ///
  /// - Remark: See the type.
  /// - SideEffects: none
  /// - Parameters:
  ///   - body: The hunk's segments with their places.
  ///   - palette: The colours.
  /// - Returns: The lines.
  @ViewBuilder
  private func lines(_ body: [(Int, DiffLayout.Segment)], _ palette: Palette) -> some View {
    let stack = VStack(alignment: .leading, spacing: 0) {
      ForEach(body, id: \.0) { place, segment in
        switch segment {
        case .line(let line, _): lineRow(line, palette)
        case .folded(let lines, _):
          if opened.contains(place) {
            ForEach(Array(lines.enumerated()), id: \.offset) { _, line in lineRow(line, palette) }
          } else {
            foldButton(count: lines.count, palette) { opened.insert(place) }
          }
        default: EmptyView()
        }
      }
    }
    if wrap {
      stack
    } else {
      ScrollView(.horizontal, showsIndicators: false) { stack.fixedSize(horizontal: true, vertical: false) }
    }
  }

  /// One line: its number, its mark, its code, on its colour.
  ///
  /// - Remark: See the type.
  /// - SideEffects: none
  /// - Parameters:
  ///   - line: The line.
  ///   - palette: The colours.
  /// - Returns: The row.
  private func lineRow(_ line: DiffLine, _ palette: Palette) -> some View {
    let (background, bar, mark): (Color, Color, String) =
      switch line.kind {
      case .add: (palette.addBackground, palette.ok, "+")
      case .del: (palette.deleteBackground, palette.danger, "−")
      case .context: (.clear, .clear, "")
      }
    return HStack(alignment: .firstTextBaseline, spacing: 0) {
      HStack(spacing: 3) {
        Text(line.kind == .del ? "" : (line.newNumber.map(String.init) ?? ""))
          .monospacedDigit()
          .foregroundStyle(palette.tertiary)
        if !mark.isEmpty {
          Text(mark).foregroundStyle(line.kind == .add ? palette.okText : palette.danger)
        }
      }
      .padding(.trailing, line.kind == .context ? 8 : 2)
      .frame(width: 34, alignment: .trailing)
      Text(highlight(line.text))
        .foregroundStyle(line.kind == .del ? palette.secondary : palette.text2)
        .lineLimit(wrap ? nil : 1)
        .fixedSize(horizontal: !wrap, vertical: true)
        .padding(.trailing, 14)
      Spacer(minLength: 0)
    }
    .frame(minWidth: viewportWidth, minHeight: 19)
    .background(background)
    .overlay(alignment: .leading) { bar.frame(width: 2) }
  }

  /// A hunk's sticky header.
  ///
  /// - Remark: The paper redesign (design-language "手机端 · 改动与 diff"): deep beige words on a
  ///   faint deep beige ground, opaque over the paper so the lines pass under it.
  /// - SideEffects: none
  /// - Parameters:
  ///   - text: "@@ -a,b +c,d @@".
  ///   - palette: The colours.
  /// - Returns: The header.
  private func hunkHeader(_ text: String, _ palette: Palette) -> some View {
    Text(text)
      .font(.system(size: 11, design: .monospaced))
      .foregroundStyle(palette.tint)
      .padding(.horizontal, 14)
      .frame(maxWidth: .infinity, minHeight: 30, alignment: .leading)
      .background(palette.tintSoft)
      .background(palette.page)
      .overlay(alignment: .bottom) { palette.line.frame(height: 0.5) }
  }

  /// "展开 N 行" for lines between hunks.
  ///
  /// - Remark: The lines are not here. MP6 must fetch the corresponding comparison versions;
  ///   until then, no callback means an explicit unavailable state rather than fabricated context.
  /// - SideEffects: none
  /// - Parameters:
  ///   - gap: The count and where it starts.
  ///   - palette: The colours.
  /// - Returns: The button.
  @ViewBuilder
  private func gapButton(_ gap: (count: Int, old: Int, new: Int), _ palette: Palette) -> some View {
    if let onOpenGap {
      foldButton(count: gap.count, palette) { onOpenGap(gap.count, gap.old, gap.new) }
    } else {
      Text("\(gap.count) 行上下文未加载")
        .font(Typography.meta).foregroundStyle(palette.secondary)
        .padding(.leading, 14).frame(height: 32)
    }
  }

  /// A "展开 N 行" row.
  ///
  /// - Remark: 32pt, the accent, a small chevron, as the prototype.
  /// - SideEffects: none
  /// - Parameters:
  ///   - count: How many lines it holds.
  ///   - palette: The colours.
  ///   - action: What opening it does.
  /// - Returns: The button.
  private func foldButton(count: Int, _ palette: Palette, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      HStack(spacing: 6) {
        Image(systemName: "chevron.down").font(.system(size: 10, weight: .semibold))
        Text("展开 \(count) 行")
      }
      .font(.system(size: 13))
      .foregroundStyle(palette.tint)
      .padding(.leading, 14)
      .frame(maxWidth: .infinity, minHeight: 32, alignment: .leading)
      .contentShape(Rectangle())
    }
    .buttonStyle(PressStyle(scale: 0.985))
  }

  /// One hunk with what comes before it.
  ///
  /// - Remark: Sections need the segments grouped per hunk.
  struct Group {
    /// The hunk's index.
    let id: Int
    /// The gap before the hunk, if any.
    var gap: (count: Int, old: Int, new: Int)?
    /// The hunk's header.
    var header: String?
    /// The hunk's lines and folds, with their places among all the segments.
    var body: [(Int, DiffLayout.Segment)] = []
  }

  /// Groups segments per hunk.
  ///
  /// - Remark: A gap belongs to the hunk after it.
  /// - SideEffects: none
  /// - Parameter segments: The segments.
  /// - Returns: The groups.
  static func group(_ segments: [DiffLayout.Segment]) -> [Group] {
    var groups: [Group] = []
    var pending: (count: Int, old: Int, new: Int)?
    for (place, segment) in segments.enumerated() {
      switch segment {
      case .gap(let count, let old, let new): pending = (count, old, new)
      case .header(let text, let hunk):
        groups.append(Group(id: hunk, gap: pending, header: text))
        pending = nil
      case .line, .folded:
        if !groups.isEmpty { groups[groups.count - 1].body.append((place, segment)) }
      }
    }
    return groups
  }
}
