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
    public static let sections = ["colors", "type", "glass", "status", "cats", "atoms", "rail"]

    /// The section to show alone, or every section.
    let section: String

    /// Light or dark.
    @Environment(\.colorScheme) private var scheme

    /// Makes the page.
    ///
    /// - Remark: An unknown name shows every section rather than nothing.
    /// - SideEffects: none
    /// - Parameter section: A name from `sections`, or `all`.
    public init(section: String) {
      self.section = Self.sections.contains(section) ? section : "all"
    }

    /// The sections, scrolling.
    public var body: some View {
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
