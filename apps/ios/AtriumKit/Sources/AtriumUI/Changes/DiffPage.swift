import AtriumProtocol
import SwiftUI

/// A file of the change list, for navigation: the files in the order shown and which one.
///
/// - Remark: "下一个" goes through them in that order, back to the first after the last.
struct DiffRoute: Hashable, Identifiable {
  /// The files, as the list showed them.
  let files: [DiffFile]
  /// The file opened.
  let place: Int
  /// What tells routes apart.
  var id: String { "\(place)-\(files.count)" }

  /// Compares by the files' paths and the place.
  ///
  /// - Remark: The files' hunks do not make a route different.
  /// - SideEffects: none
  /// - Parameters:
  ///   - lhs: One route.
  ///   - rhs: The other.
  /// - Returns: Whether they are the same.
  static func == (lhs: Self, rhs: Self) -> Bool {
    lhs.place == rhs.place && lhs.files.map(\.path) == rhs.files.map(\.path)
  }

  /// Hashes the files' paths and the place.
  ///
  /// - Remark: As ``==(_:_:)``.
  /// - SideEffects: none
  /// - Parameter hasher: The hasher.
  func hash(into hasher: inout Hasher) {
    hasher.combine(place)
    hasher.combine(files.map(\.path))
  }
}

/// One file's diff, with the toolbar.
///
/// - Remark: The final prototype's diff page (SPEC-0005 "MP6 定的细节 · MP6a"): the file's name and
///   "目录 · +a −r · i / n" on top with a key to copy its path; ``DiffView`` unwrapped by default;
///   a glass toolbar with "上一处 / 下一处" (scrolls to the hunk), "换行", and "下一个" (the next file,
///   sliding in from the right). A binary or too large file says so instead.
struct DiffPage: View {
  /// The files and the one opened.
  let route: DiffRoute
  /// The file shown, by its place.
  @State private var place: Int
  /// The hunk last scrolled to.
  @State private var hunk = 0
  /// Whether long lines wrap.
  @State private var wrap = false
  /// Whether the path was just copied.
  @State private var copied = false
  /// Goes back.
  @Environment(\.dismiss) private var dismiss
  /// Light or dark.
  @Environment(\.colorScheme) private var scheme
  /// Whether Reduce Motion is on.
  @Environment(\.atriumReduceMotion) private var reduceMotion
  /// The clock the toast waits on.
  @Environment(\.atriumClock) private var clock

  /// Shows a file of a route.
  ///
  /// - Remark: Starts at the route's file.
  /// - SideEffects: none
  /// - Parameter route: The route.
  init(route: DiffRoute) {
    self.route = route
    _place = State(initialValue: route.place)
  }

  /// The page.
  var body: some View {
    let palette = Palette(scheme: scheme)
    let file = route.files[min(place, route.files.count - 1)]
    ScrollViewReader { proxy in
      ScrollView([.vertical]) {
        Group {
          switch file.content {
          case .text:
            DiffView(hunks: file.hunks, wrap: wrap)
          case .binary:
            Text("二进制文件，不显示内容").font(.system(size: 15)).foregroundStyle(palette.secondary)
              .frame(maxWidth: .infinity).padding(.top, 60)
          case .tooLarge:
            Text("文件太大，在 Mac 上看").font(.system(size: 15)).foregroundStyle(palette.secondary)
              .frame(maxWidth: .infinity).padding(.top, 60)
          }
        }
        .id(file.path)
        .transition(
          reduceMotion ? .opacity : .asymmetric(insertion: .offset(x: 60).combined(with: .opacity), removal: .opacity)
        )
        .padding(.top, 112)
        .padding(.bottom, 140)
      }
      .overlay(alignment: .bottom) {
        toolbar(file, palette) { target in
          hunk = target
          withAnimation(reduceMotion ? nil : MotionToken.smooth.resolved(reduceMotion: false).animation) {
            proxy.scrollTo(target, anchor: .top)
          }
        }
      }
    }
    .background(palette.page.ignoresSafeArea())
    .overlay(alignment: .top) { topBar(file, palette) }
    .overlay(alignment: .top) {
      if copied {
        Text("已复制路径").font(.system(size: 13.5)).foregroundStyle(palette.text).padding(.horizontal, Metrics.md)
          .frame(height: 38).atriumGlass(in: Capsule()).padding(.top, 62).transition(.opacity)
      }
    }
    .hidingNavigationBar()
    .task(id: copied) {
      guard copied else { return }
      try? await clock.sleep(for: .seconds(1.9))
      if !Task.isCancelled { copied = false }
    }
  }

  /// The floating top bar: back, the file and where it is, and copy path.
  ///
  /// - Remark: See the type.
  /// - SideEffects: none
  /// - Parameters:
  ///   - file: The file.
  ///   - palette: The colours.
  /// - Returns: The bar.
  private func topBar(_ file: DiffFile, _ palette: Palette) -> some View {
    ZStack {
      VStack(spacing: 1) {
        Text(ChangeList.name(file)).font(.system(size: 15, weight: .semibold)).foregroundStyle(palette.text)
          .lineLimit(1).truncationMode(.middle)
        Text(Self.subtitle(file, place: place, count: route.files.count))
          .font(.system(size: 11.5)).monospacedDigit().foregroundStyle(palette.secondary).lineLimit(1)
      }
      .padding(.horizontal, Metrics.glassButton + Metrics.lg)
      HStack {
        GlassCircleButton(systemImage: "chevron.left", label: "返回") { dismiss() }
        Spacer()
        GlassCircleButton(systemImage: "doc.on.doc", label: "复制路径") {
          Pasteboard.copy(file.path)
          copied = true
        }
      }
      .padding(.horizontal, Metrics.md)
    }
    .frame(height: 56)
    .background(
      LinearGradient(
        stops: [.init(color: palette.page, location: 0.8), .init(color: palette.page.opacity(0), location: 1)],
        startPoint: .top, endPoint: .bottom
      )
      .padding(.bottom, -Metrics.md)
      .ignoresSafeArea(edges: .top))
  }

  /// The glass toolbar at the bottom.
  ///
  /// - Remark: The prototype's `.dtool`.
  /// - SideEffects: none
  /// - Parameters:
  ///   - file: The file.
  ///   - palette: The colours.
  ///   - scroll: Scrolls to a hunk.
  /// - Returns: The toolbar.
  private func toolbar(_ file: DiffFile, _ palette: Palette, scroll: @escaping (Int) -> Void) -> some View {
    let hunks = file.hunks.count
    return HStack(spacing: 0) {
      toolButton("chevron.up", label: "上一处", disabled: hunks == 0, palette) { scroll(max(0, hunk - 1)) }
      Text(hunks == 0 ? "0 / 0 处" : "\(min(hunk, hunks - 1) + 1) / \(hunks) 处")
        .font(.system(size: 12.5)).monospacedDigit().foregroundStyle(palette.secondary).frame(minWidth: 54)
      toolButton("chevron.down", label: "下一处", disabled: hunks == 0, palette) { scroll(min(hunks - 1, hunk + 1)) }
      Divider().frame(height: 22)
      Button {
        wrap.toggle()
      } label: {
        Text("换行").font(.system(size: 14)).foregroundStyle(wrap ? palette.tint : palette.text2)
          .padding(.horizontal, Metrics.sm).frame(height: 46)
          .background(wrap ? palette.fill : .clear, in: Capsule())
      }
      .buttonStyle(PressStyle())
      Divider().frame(height: 22)
      Button {
        withAnimation(reduceMotion ? nil : MotionToken.smooth.resolved(reduceMotion: false).animation) {
          place = (place + 1) % route.files.count
          hunk = 0
        }
      } label: {
        Text("下一个 ›").font(.system(size: 14)).foregroundStyle(palette.text2).padding(.horizontal, Metrics.sm)
          .frame(height: 46)
      }
      .buttonStyle(PressStyle())
      .disabled(route.files.count < 2)
    }
    .padding(4)
    .frame(height: 54)
    .atriumGlass(in: Capsule())
    .padding(.bottom, 30)
  }

  /// One round key of the toolbar.
  ///
  /// - Remark: 46pt.
  /// - SideEffects: none
  /// - Parameters:
  ///   - systemImage: Its symbol.
  ///   - label: What it says to VoiceOver.
  ///   - disabled: Whether it does nothing now.
  ///   - palette: The colours.
  ///   - action: What it does.
  /// - Returns: The key.
  private func toolButton(
    _ systemImage: String, label: String, disabled: Bool, _ palette: Palette, action: @escaping () -> Void
  ) -> some View {
    Button(action: action) {
      Image(systemName: systemImage).font(.system(size: 15, weight: .semibold)).foregroundStyle(palette.text2)
        .frame(width: 46, height: 46)
    }
    .buttonStyle(PressStyle())
    .disabled(disabled)
    .accessibilityLabel(label)
  }

  /// The second line of the top bar: "目录 · +a −r · i / n".
  ///
  /// - Remark: The directory is left out at the root.
  /// - SideEffects: none
  /// - Parameters:
  ///   - file: The file.
  ///   - place: Its place.
  ///   - count: How many files the route has.
  /// - Returns: The line.
  static func subtitle(_ file: DiffFile, place: Int, count: Int) -> String {
    let directory = ChangeList.directory(file)
    let parts = [directory.isEmpty ? nil : directory, "+\(file.added) −\(file.removed)", "\(place + 1) / \(count)"]
    return parts.compactMap { $0 }.joined(separator: " · ")
  }
}
