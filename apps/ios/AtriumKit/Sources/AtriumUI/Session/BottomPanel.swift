import SwiftUI

/// Closes the bottom panel a view sits in; `nil` outside one.
///
/// - Remark: A panel is an overlay, not a presentation, so `dismiss` does not reach it.
struct ClosePanelKey: EnvironmentKey {
  static let defaultValue: (() -> Void)? = nil
}

extension EnvironmentValues {
  /// Closes the bottom panel this view sits in, if any.
  var closePanel: (() -> Void)? {
    get { self[ClosePanelKey.self] }
    set { self[ClosePanelKey.self] = newValue }
  }
}

extension PageSheet {
  /// Whether the sheet shows as a full-width bottom panel rather than a system sheet.
  ///
  /// - Remark: design-language "子对话 sheet、排队 sheet" (2026-10-29): on iOS 26 a system sheet
  ///   below its large detent floats inset from the screen's sides, and nothing in UIKit or SwiftUI
  ///   attaches it to the edges, so these two are drawn as `BottomPanel`.
  var isPanel: Bool {
    switch self {
    case .queue, .children: true
    case .question, .interaction, .model: false
    }
  }
}

extension View {
  /// Shows a full-width panel from the bottom while `item` is set.
  ///
  /// - Remark: See `BottomPanel`.
  /// - SideEffects: none
  /// - Parameters:
  ///   - item: What the panel shows; set to `nil` when it closes.
  ///   - content: The panel's content for an item.
  /// - Returns: The view with the panel over it.
  func bottomPanel<Item: Identifiable, Content: View>(
    item: Binding<Item?>, @ViewBuilder content: @escaping (Item) -> Content
  ) -> some View {
    overlay {
      BottomPanel(item: item, content: content)
    }
  }
}

/// A panel pushed up from the bottom over a dimmed page, spanning the whole width.
///
/// - Remark: Stands in for a medium-detent sheet (see `PageSheet.isPanel`): `--surface` paper with
///   top corners of 24pt and a grabber, at most 62% of the screen tall; tapping the dimmed page or
///   dragging the panel down closes it. Slides with the smooth spring; with Reduce Motion it fades.
struct BottomPanel<Item: Identifiable, Content: View>: View {
  /// What the panel shows.
  @Binding var item: Item?
  /// The panel's content for an item.
  let content: (Item) -> Content
  /// How far the panel is dragged down, in points.
  @State private var drag: CGFloat = 0
  /// Light or dark.
  @Environment(\.colorScheme) private var scheme
  /// Whether Reduce Motion is on.
  @Environment(\.atriumReduceMotion) private var reduceMotion

  /// The dim and the panel.
  var body: some View {
    let palette = Palette(scheme: scheme)
    let motion = MotionToken.smooth.resolved(reduceMotion: reduceMotion).animation
    GeometryReader { proxy in
      ZStack(alignment: .bottom) {
        if item != nil {
          Color.black.opacity(scheme == .dark ? 0.45 : 0.22)
            .ignoresSafeArea()
            .onTapGesture { close() }
            .transition(.opacity)
            .accessibilityHidden(true)
        }
        if let shown = item {
          VStack(spacing: 0) {
            Capsule().fill(palette.tertiary).frame(width: 36, height: 5).padding(.top, 6).padding(.bottom, 2)
            content(shown)
              .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
          }
          .padding(.bottom, proxy.safeAreaInsets.bottom)
          .frame(maxWidth: .infinity)
          .frame(height: (proxy.size.height + proxy.safeAreaInsets.bottom) * 0.62)
          .background(
            palette.surface,
            in: UnevenRoundedRectangle(topLeadingRadius: 24, topTrailingRadius: 24, style: .continuous)
          )
          .offset(y: max(0, drag))
          .gesture(
            DragGesture()
              .onChanged { drag = $0.translation.height }
              .onEnded { value in
                if value.translation.height > 110 || value.predictedEndTranslation.height > 260 {
                  close()
                } else {
                  withAnimation(motion) { drag = 0 }
                }
              }
          )
          .environment(\.closePanel) { close() }
          .transition(reduceMotion ? .opacity : .move(edge: .bottom))
          .accessibilityAddTraits(.isModal)
          .accessibilityAction(.escape) { close() }
        }
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
      .ignoresSafeArea(edges: .bottom)
      .animation(motion, value: item?.id)
    }
  }

  /// Closes the panel.
  ///
  /// - Remark: The drag resets once it is gone, so the next panel starts in place.
  /// - SideEffects: Clears `item`, which removes the panel with its animation.
  private func close() {
    withAnimation(MotionToken.smooth.resolved(reduceMotion: reduceMotion).animation) { item = nil }
    drag = 0
  }
}

#if DEBUG
  /// The child or queue panel open over a sample page, for the gallery.
  ///
  /// - Remark: Shown the way the conversation page shows them, so the width shows as on the phone.
  struct GalleryPanel: View {
    /// Whether to show the queue rather than the children.
    let queue: Bool
    /// The panel shown; starts open.
    @State private var sheet: PageSheet?
    /// The sample sync.
    @State private var sync = GallerySync.model()
    /// Light or dark.
    @Environment(\.colorScheme) private var scheme

    /// The page and the panel.
    var body: some View {
      Palette(scheme: scheme).page.ignoresSafeArea()
        .bottomPanel(item: $sheet) { shown in
          switch shown {
          case .queue: QueueSheet(sessionId: GallerySync.openSession, sync: sync)
          default: ChildrenSheet(children: Array(sync.core.index.sessions.prefix(3))) { _ in }
          }
        }
        .onAppear { sheet = queue ? .queue : .children(Array(sync.core.index.sessions.prefix(3))) }
    }
  }
#endif
