#if DEBUG
  import SwiftUI

  /// One section of the design gallery.
  ///
  /// - Remark: See `DesignGallery`.
  struct GallerySection: View {
    /// The section's name.
    let name: String
    /// Light or dark.
    @Environment(\.colorScheme) private var scheme
    /// Whether the motion sample is in its second state.
    @State private var flipped = false
    /// The accessibility preference also applies to the interactive motion samples.
    @Environment(\.atriumReduceMotion) private var reduceMotion

    /// The section's samples.
    var body: some View {
      let palette = Palette(scheme: scheme)
      switch name {
      case "colors": colors
      case "type": type(palette)
      case "glass": glass(palette)
      case "status": status(palette)
      case "cats": cats
      case "atoms": atoms(palette)
      case "rail": GalleryRail()
      case "markdown": GalleryMarkdown()
      case "diff": GalleryDiff()
      case "models":
        VStack(alignment: .leading, spacing: Metrics.md) {
          HStack(spacing: Metrics.sm) {
            ForEach(
              [
                "anthropic", "openai-codex", "github-copilot", "openrouter", "xai", "moonshotai", "deepseek", "someone",
              ],
              id: \.self
            ) { ProviderIcon(providerId: $0, size: 30) }
          }
          ThinkingBox(levels: [.low, .medium, .high, .xhigh], level: .medium) { _ in }
          ThinkingBox(levels: [.low, .medium, .high, .xhigh], level: .xhigh) { _ in }
          ThinkingBox(levels: [.off], level: .off) { _ in }
        }
      case "files":
        VStack(alignment: .leading, spacing: 6) {
          ForEach(
            ["ttl.ts", "App.tsx", "package.json", "README.md", "style.css", "Main.swift", "x.unknown"], id: \.self
          ) {
            name in
            HStack(spacing: 10) {
              FileIconView(path: name)
              Text(name).font(.system(size: 14.5))
            }
          }
        }
      case "conversation":
        VStack(alignment: .leading, spacing: Metrics.md) {
          TurnView(layout: TurnLayout(SampleTurns.finished))
          TurnView(layout: TurnLayout(SampleTurns.running))
          ErrorCard(text: "这一轮出错了", detail: "HTTP 529 overloaded", retry: {})
          ErrorCard(text: SessionControls.failureText(attempts: 3), detail: nil, retry: {})
        }
      default: EmptyView()
      }
    }

    /// Every colour token as a swatch.
    private var colors: some View {
      LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: 5), spacing: 8) {
        ForEach(Array(ColorToken.allCases.enumerated()), id: \.offset) { _, token in
          VStack(spacing: 4) {
            RoundedRectangle(cornerRadius: 8)
              .fill(Palette(scheme: scheme)(token))
              .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Palette(scheme: scheme).line, lineWidth: 0.5))
              .frame(height: 36)
            Text(String(describing: token))
              .font(.system(size: 9))
              .foregroundStyle(Palette(scheme: scheme).secondary)
              .lineLimit(1)
              .minimumScaleFactor(0.6)
          }
        }
      }
    }

    /// The type scale and the serif rule.
    ///
    /// - Remark: A Latin and a Chinese project name side by side show the fallback.
    /// - SideEffects: none
    /// - Parameter palette: The colours.
    /// - Returns: The samples.
    private func type(_ palette: Palette) -> some View {
      VStack(alignment: .leading, spacing: 10) {
        Text("Atrium").displayFont(for: "Atrium", size: 40)
        Text("weather-app").displayFont(for: "weather-app", size: 23, cjkSize: 19)
        Text("天气应用").displayFont(for: "天气应用", size: 23, cjkSize: 19)
        Text("482 916").displayFont(for: "482 916", size: 34)
        Text("回复正文 15.5pt，行高 1.5。Reply body.")
          .font(Typography.reply)
          .lineSpacing(Typography.replyLineSpacing)
        Text("会话行标题 16pt").font(Typography.rowTitle)
        Text("元信息 13pt · weather-app · main").font(Typography.meta).foregroundStyle(palette.secondary)
        Text("过程步骤 12.5pt").font(Typography.step).foregroundStyle(palette.text2)
        Text("return e.expiresAt * 1000 > Date.now();").font(Typography.code)
      }
      .foregroundStyle(palette.text)
    }

    /// Glass on a busy background, so the ring and the blur show.
    ///
    /// - Remark: The stripes stand in for content scrolling under floating controls.
    /// - SideEffects: none
    /// - Parameter palette: The colours.
    /// - Returns: The samples.
    private func glass(_ palette: Palette) -> some View {
      ZStack {
        VStack(alignment: .leading, spacing: 6) {
          ForEach(0..<9) { index in
            Text("内容在玻璃下面滚动 · content scrolls under glass \(index)")
              .font(Typography.reply)
              .foregroundStyle(index.isMultiple(of: 2) ? palette.text : palette.tint)
          }
        }
        VStack(spacing: 16) {
          HStack {
            GlassCircleButton(systemImage: "line.3.horizontal", label: "菜单", badge: true) {}
            Spacer()
            GlassCircleButton(systemImage: "plus", label: "新会话", size: Metrics.floatingAdd) {}
          }
          HStack(spacing: 8) {
            Text("排队 1").padding(.horizontal, 13).frame(height: 34).atriumGlass(in: Capsule())
            Text("子对话 2").padding(.horizontal, 13).frame(height: 34).atriumGlass(in: Capsule())
          }
          .font(.system(size: 13.5))
          .foregroundStyle(palette.text2)
          Text("发送进排队 · 长按插话")
            .foregroundStyle(palette.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 18)
            .frame(height: 52)
            .atriumGlass(in: RoundedRectangle(cornerRadius: 26))
        }
      }
    }

    /// Every status icon, the blinking cat, and the springs.
    ///
    /// - Remark: Several vortices side by side show they share one phase.
    /// - SideEffects: none
    /// - Parameter palette: The colours.
    /// - Returns: The samples.
    private func status(_ palette: Palette) -> some View {
      VStack(alignment: .leading, spacing: 14) {
        HStack(spacing: 18) {
          StatusIcon(kind: .asking)
          StatusIcon(kind: .error)
          StatusIcon(kind: .running)
          StatusIcon(kind: .unread)
          VortexIcon(size: 12)
          VortexIcon(size: 28)
        }
        HStack(spacing: 6) {
          RunningCat()
          Text("进行中").font(Typography.step).foregroundStyle(palette.text2)
          Text("1:12").font(Typography.step.monospacedDigit()).foregroundStyle(palette.secondary)
        }
        HStack(spacing: 12) {
          ForEach(MotionToken.allCases, id: \.self) { token in
            Circle()
              .fill(palette.tint)
              .frame(width: 18, height: 18)
              .offset(y: flipped && !reduceMotion ? -14 : 0)
              .opacity(flipped && reduceMotion ? 0.5 : 1)
              .motion(token, value: flipped)
          }
          Button(flipped ? "回去" : "弹一下") { flipped.toggle() }
            .buttonStyle(PressStyle())
            .foregroundStyle(palette.tint)
        }
        .frame(height: 40)
      }
    }

    /// The pixel cat in every scene, and the home empty state's paper stack.
    private var cats: some View {
      LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 16) {
        PixelCatView(scene: .tile, size: 150, seed: 1)
        PixelCatView(scene: .peek, size: 150, seed: 2)
        PixelCatView(scene: .sit, size: 150, seed: 3)
        PixelCatView(scene: .paired, size: 150, seed: 4)
        PixelCatView(scene: .asleep, size: 150)
        PaperStack()
      }
    }

    /// The connection pill in each state, tags and buttons.
    ///
    /// - Remark: See the components.
    /// - SideEffects: none
    /// - Parameter palette: The colours.
    /// - Returns: The samples.
    private func atoms(_ palette: Palette) -> some View {
      VStack(alignment: .leading, spacing: 10) {
        ConnectionPill(state: .connected, hostName: "MacBook Pro")
        ConnectionPill(state: .reconnecting, hostName: "MacBook Pro")
        ConnectionPill(state: .offline, hostName: "MacBook Pro")
        ConnectionPill(state: .relayUnreachable, hostName: "MacBook Pro")
        ConnectionPill(state: .versionMismatch, hostName: "MacBook Pro")
        HStack(spacing: 8) {
          MonoTag(text: "未提交 · ↑3", tone: .attention)
          MonoTag(text: "已合并", tone: .merged)
          MonoTag(text: "Mac 上的 Atrium › 侧栏 › 项目 +")
        }
      }
    }
  }
#endif
