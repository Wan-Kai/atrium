#if DEBUG
  import SwiftUI

  /// A page showing the design foundations and components one by one, for checking them by eye.
  ///
  /// - Remark: Debug builds only. The app opens it instead of the home screen when launched with
  ///   the environment variable `ATRIUM_GALLERY` set to a section's name (or `all`); the UI test
  ///   `GalleryScreenshotTests` launches it per section and keeps light and dark screenshots
  ///   (`TEST_RUNNER_ATRIUM_GALLERY_SHOTS=1 pnpm test:ios`). Sample words only, no real projects.
  public struct DesignGallery: View {
    /// The sections, in order; each name is what `ATRIUM_GALLERY` takes.
    public static let sections = [
      "colors", "type", "glass", "status", "cats", "atoms", "rail", "markdown", "diff", "conversation", "files",
      "models",
    ]

    /// The section to show alone, or every section.
    let section: String
    /// Forces a static accessibility sample without changing simulator-wide preferences.
    let forcedReduced: Bool
    /// Forces the solid-glass fallback for screenshot comparison.
    let forcedSolid: Bool

    /// Light or dark.
    @Environment(\.colorScheme) private var scheme

    /// Makes the page.
    ///
    /// - Remark: An unknown name shows every section rather than nothing.
    /// - SideEffects: none
    /// - Parameter section: A name from `sections`, or `all`.
    public init(section: String) {
      forcedReduced = section.hasSuffix("-reduced")
      forcedSolid = section.hasSuffix("-solid")
      let base = forcedReduced ? String(section.dropLast(8)) : forcedSolid ? String(section.dropLast(6)) : section
      self.section =
        (Self.sections + ["timeline-list", "timeline-stack", "timeline-control", "timeline-check", "diff-page"])
          .contains(base)
        ? base : "all"
    }

    /// The sections, scrolling.
    public var body: some View {
      content
        .environment(
          \.atriumAccessibilityReductions, AccessibilityReductions(motion: forcedReduced, transparency: forcedSolid))
    }

    /// Chooses the gallery or the standalone benchmark container.
    @ViewBuilder private var content: some View {
      #if os(iOS)
        if section == "diff-page" {
          NavigationStack { DiffPage(route: GalleryDiff.route) }
        } else if section == "timeline-check" {
          GalleryTimelineInteraction()
        } else if section.hasPrefix("timeline-") {
          GalleryTimeline(stack: section == "timeline-stack", stallControl: section == "timeline-control")
        } else {
          gallery
        }
      #else
        gallery
      #endif
    }

    /// Ordinary component sections, separate from the benchmark's own scroll container.
    @ViewBuilder private var gallery: some View {
      let palette = Palette(scheme: scheme)
      ScrollView {
        VStack(alignment: .leading, spacing: Metrics.xl) {
          ForEach(shown, id: \.self) { name in
            VStack(alignment: .leading, spacing: Metrics.md) {
              Text(name)
                .font(Typography.meta)
                .foregroundStyle(palette.secondary)
              GallerySection(name: name)
            }
          }
        }
        .padding(.horizontal, Metrics.page)
        .padding(.top, 72)
        .padding(.bottom, 120)
        .frame(maxWidth: .infinity, alignment: .leading)
      }
      .background(palette.page.ignoresSafeArea())
      .accessibilityIdentifier("gallery")
    }

    /// The sections to show.
    private var shown: [String] {
      section == "all" ? Self.sections : [section]
    }
  }
#endif
