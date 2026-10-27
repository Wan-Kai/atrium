import AtriumProtocol
import AtriumSync
import ImageIO
import SwiftUI

/// The model sheet: the provider bar, the models, the thinking box and Fast.
///
/// - Remark: The final prototype's model sheet (SPEC-0005 "MP6 定的细节 · MP6c"): "模型" with
///   "从下一条消息开始生效" and a refresh key; a search field; a 64pt bar of provider icons (the
///   current one dotted, "套餐" on those always on a plan) beside the models of the provider picked,
///   each with its context, output and ⚡; the dotted thinking box, dragged or tapped to a level, its
///   name and what it suits; Fast where the model has it. Picking does not close the sheet.
struct ModelSheet: View {
  /// The session.
  let sessionId: SessionId
  /// The connection's sync.
  let sync: SyncModel
  /// The provider whose models show.
  @State private var provider: String?
  /// What the search field holds.
  @State private var query = ""
  /// Closes the sheet.
  @Environment(\.dismiss) private var dismiss
  /// Light or dark.
  @Environment(\.colorScheme) private var scheme

  /// The sheet.
  var body: some View {
    let palette = Palette(scheme: scheme)
    let state = sync.core.sessions[sessionId]
    let catalog = sync.core.models?.models ?? []
    let current =
      state?.model.map { ModelRef(providerId: $0.providerId, modelId: $0.modelId) }
      ?? sync.core.models?.defaultModel
    let groups = ModelChoice.groups(catalog)
    let picked = provider ?? current?.providerId ?? groups.first?.providerId
    let currentModel = catalog.first { $0.providerId == current?.providerId && $0.modelId == current?.modelId }
    VStack(alignment: .leading, spacing: 0) {
      header(palette)
      HStack(spacing: Metrics.xs) {
        Image(systemName: "magnifyingglass").foregroundStyle(palette.secondary)
        TextField("搜索模型", text: $query).font(.system(size: 15))
        if !query.isEmpty {
          Button {
            query = ""
          } label: {
            Image(systemName: "xmark.circle.fill").foregroundStyle(palette.tertiary)
          }
          .buttonStyle(.plain)
          .accessibilityLabel("清除")
        }
      }
      .padding(.horizontal, Metrics.sm)
      .frame(height: 38)
      .background(palette.fill, in: RoundedRectangle(cornerRadius: 12))
      .padding(.horizontal, Metrics.md)
      .padding(.bottom, Metrics.xs)
      HStack(alignment: .top, spacing: 0) {
        ScrollView {
          VStack(spacing: 6) {
            ForEach(groups) { group in
              Button {
                provider = group.providerId
                query = ""
              } label: {
                ProviderIcon(providerId: group.providerId, size: 26)
                  .frame(width: 48, height: 48)
                  .background(
                    picked == group.providerId ? palette.fill : .clear, in: RoundedRectangle(cornerRadius: 14)
                  )
                  .overlay(alignment: .topTrailing) {
                    if current?.providerId == group.providerId {
                      Circle().fill(palette.tint).frame(width: 7, height: 7).padding(5)
                    }
                  }
                  .overlay(alignment: .bottomTrailing) {
                    if ModelChoice.onPlan(group.providerId) {
                      Text("套餐").font(.system(size: 8.5, weight: .semibold)).foregroundStyle(.white)
                        .padding(.horizontal, 2).background(palette.tint, in: RoundedRectangle(cornerRadius: 4))
                    }
                  }
              }
              .buttonStyle(PressStyle())
              .accessibilityLabel(ModelChoice.providerName(group.providerId))
            }
          }
        }
        .frame(width: 64)
        .opacity(query.isEmpty ? 1 : 0.5)
        ScrollView {
          VStack(alignment: .leading, spacing: 0) {
            let shown =
              query.isEmpty
              ? (groups.first { $0.providerId == picked }?.models ?? [])
              : catalog.filter { $0.name.localizedCaseInsensitiveContains(query) || $0.modelId.contains(query) }
            HStack {
              Text(query.isEmpty ? ModelChoice.providerName(picked ?? "") : "搜索结果")
                .font(.system(size: 13, weight: .semibold))
              if query.isEmpty, let picked, ModelChoice.onPlan(picked) {
                Text("套餐").font(.system(size: 12)).foregroundStyle(palette.tint)
              }
              Spacer()
              Text("\(shown.count) 个模型").font(.system(size: 12)).foregroundStyle(palette.secondary)
            }
            .foregroundStyle(palette.text)
            .padding(.horizontal, Metrics.sm)
            .frame(height: 36)
            if shown.isEmpty {
              Text(catalog.isEmpty ? "正在读取模型…" : "没有匹配的模型").font(.system(size: 14)).foregroundStyle(palette.secondary)
                .padding(Metrics.sm)
            }
            ForEach(shown, id: \.modelId) { model in
              modelRow(
                model, current: model.providerId == current?.providerId && model.modelId == current?.modelId,
                palette: palette)
            }
          }
        }
      }
      .frame(height: 306)
      .padding(.horizontal, Metrics.xs)
      if let currentModel {
        ThinkingBox(levels: currentModel.thinkingLevels, level: state?.model?.thinkingLevel) {
          sync.perform(.setThinkingLevel($0), in: sessionId)
        }
        .padding(.horizontal, Metrics.md)
        .padding(.top, Metrics.sm)
        if let fast = currentModel.fast {
          Toggle(
            isOn: Binding(get: { state?.fast ?? false }, set: { sync.perform(.setFast($0), in: sessionId) })
          ) {
            VStack(alignment: .leading, spacing: 2) {
              Text("⚡ Fast").font(.system(size: 16))
              Text(ModelChoice.fastText(speed: fast.speed, moreUsage: fast.moreUsage)).font(.system(size: 13))
                .foregroundStyle(palette.secondary)
            }
          }
          .tint(palette.ok)
          .padding(.horizontal, Metrics.md)
          .padding(.top, Metrics.sm)
        }
      }
      Spacer(minLength: 0)
    }
    .background(palette.surface)
    .presentationDetents([.large])
    .presentationDragIndicator(.visible)
    .task { sync.listModels(workspaceId: workspaceId, refresh: false) }
  }

  /// The session's workspace, whose models are listed; `nil` for a chat.
  private var workspaceId: WorkspaceId? {
    guard let summary = sync.core.index.sessions.first(where: { $0.sessionId == sessionId }),
      sync.core.index.workspaces.contains(where: { $0.id == summary.containerId })
    else { return nil }
    return summary.containerId
  }

  /// The sheet's header: close, the title, and refresh.
  ///
  /// - Remark: Refreshing asks pi to list the models again.
  /// - SideEffects: none
  /// - Parameter palette: The colours.
  /// - Returns: The header.
  private func header(_ palette: Palette) -> some View {
    HStack(alignment: .top) {
      GlassCircleButton(systemImage: "xmark", label: "关闭", size: 36) { dismiss() }
      Spacer()
      VStack(spacing: 2) {
        Text("模型").font(.system(size: 17, weight: .semibold)).foregroundStyle(palette.text)
        Text("从下一条消息开始生效").font(.system(size: 12.5)).foregroundStyle(palette.secondary)
      }
      Spacer()
      GlassCircleButton(systemImage: "arrow.clockwise", label: "刷新", size: 36) {
        sync.listModels(workspaceId: workspaceId, refresh: true)
      }
    }
    .padding(Metrics.md)
  }

  /// One model: its name with ⚡, what it takes, and a check when it is the session's.
  ///
  /// - Remark: Picking it keeps the level if the model has it, else "高", else its top.
  /// - SideEffects: none
  /// - Parameters:
  ///   - model: The model.
  ///   - current: Whether it is the session's.
  ///   - palette: The colours.
  /// - Returns: The row.
  private func modelRow(_ model: CatalogModel, current: Bool, palette: Palette) -> some View {
    Button {
      guard !current else { return }
      sync.perform(.setModel(ModelRef(providerId: model.providerId, modelId: model.modelId)), in: sessionId)
      let before = sync.core.sessions[sessionId]?.model?.thinkingLevel
      if let level = ModelChoice.level(after: before, levels: model.thinkingLevels), level != before {
        sync.perform(.setThinkingLevel(level), in: sessionId)
      }
      if model.fast == nil, sync.core.sessions[sessionId]?.fast == true { sync.perform(.setFast(false), in: sessionId) }
    } label: {
      HStack {
        VStack(alignment: .leading, spacing: 2) {
          HStack(spacing: 4) {
            Text(model.name).font(.system(size: 15.5, weight: .medium)).foregroundStyle(palette.text)
            if model.fast != nil { Text("⚡").font(.system(size: 12)).foregroundStyle(palette.tint) }
          }
          Text(
            [
              ModelChoice.tokens(model.contextWindow), ModelChoice.tokens(model.maxOutput),
              model.supportsImage ? "图片" : nil,
            ]
            .compactMap { $0 }.joined(separator: " · ")
          )
          .font(.system(size: 12)).foregroundStyle(palette.secondary)
        }
        Spacer()
        if current {
          Image(systemName: "checkmark").font(.system(size: 14, weight: .semibold)).foregroundStyle(palette.text)
        }
      }
      .padding(.horizontal, Metrics.sm)
      .frame(minHeight: 54)
      .background(current ? palette.fill : .clear, in: RoundedRectangle(cornerRadius: 14))
      .contentShape(RoundedRectangle(cornerRadius: 14))
    }
    .buttonStyle(PressStyle(scale: 0.98))
    .padding(.horizontal, 6)
  }
}

/// A provider's official icon, or its name's first letter in a plain tile when Atrium has none.
///
/// - Remark: The icons are the desktop's, drawn once as PNG (`scripts/ios-brand-icons.mjs`).
struct ProviderIcon: View {
  /// The provider.
  let providerId: String
  /// The width and height.
  var size: CGFloat = 26
  /// Light or dark.
  @Environment(\.colorScheme) private var scheme

  /// The icon.
  var body: some View {
    let palette = Palette(scheme: scheme)
    Group {
      if let picture = ModelChoice.logo(providerId).flatMap(Self.picture) {
        Image(decorative: picture, scale: 1).resizable().scaledToFit().padding(size * 0.12)
      } else {
        Text(String(ModelChoice.providerName(providerId).prefix(1)).uppercased())
          .font(.system(size: size * 0.5, weight: .semibold)).foregroundStyle(palette.text2)
      }
    }
    .frame(width: size, height: size)
    .background(Color.white, in: RoundedRectangle(cornerRadius: size * 0.27))
    .overlay(RoundedRectangle(cornerRadius: size * 0.27).strokeBorder(palette.glassRing, lineWidth: 0.5))
  }

  /// An icon file of the package's resources, decoded.
  ///
  /// - Remark: PNG or WebP, by ImageIO.
  /// - SideEffects: Reads a file.
  /// - Parameter file: The file's name in `brand`.
  /// - Returns: The picture.
  static func picture(_ file: String) -> CGImage? {
    guard let url = Bundle.module.url(forResource: file, withExtension: nil, subdirectory: "brand"),
      let source = CGImageSourceCreateWithURL(url as CFURL, nil)
    else { return nil }
    return CGImageSourceCreateImageAtIndex(source, 0, nil)
  }
}

/// The dotted thinking box: dots filling from the left up to the level, its name and what it suits.
///
/// - Remark: The prototype's `efbox`: 3pt rounded dots 5pt apart, ink up to the level's share; at the
///   top level the brand gradient. A tap or a drag picks the level under the finger. A model with one
///   level cannot be changed.
struct ThinkingBox: View {
  /// The model's levels.
  let levels: [ThinkingLevel]
  /// The session's level.
  let level: ThinkingLevel?
  /// Picks a level.
  let pick: (ThinkingLevel) -> Void
  /// Light or dark.
  @Environment(\.colorScheme) private var scheme

  /// The box.
  var body: some View {
    let palette = Palette(scheme: scheme)
    let coverage = ModelChoice.coverage(level, levels: levels)
    let top = level != nil && level == levels.last && levels.count > 1
    VStack(alignment: .leading, spacing: 6) {
      HStack {
        Text("推理强度").font(.system(size: 13.5)).foregroundStyle(palette.secondary)
        Spacer()
        if levels.count <= 1 { Text("这个模型不支持").font(.system(size: 12.5)).foregroundStyle(palette.tertiary) }
      }
      ZStack(alignment: .topLeading) {
        Canvas { context, size in
          let columns = Int(size.width / 5)
          let rows = Int(size.height / 5)
          for column in 0..<columns {
            let lit = Double(column) / Double(max(1, columns)) < coverage
            for row in 0..<rows {
              let rect = CGRect(x: Double(column) * 5 + 1, y: Double(row) * 5 + 1, width: 3, height: 3)
              let color: Color =
                lit
                ? (top ? Self.brand(Double(column) / Double(columns)) : palette.ink).opacity(
                  0.4 + Self.noise(column, row) * 0.5)
                : palette.ink.opacity(0.04)
              context.fill(Path(roundedRect: rect, cornerRadius: 0.8), with: .color(color))
            }
          }
        }
        HStack {
          Text(level.map(ModelChoice.levelName) ?? "—").font(.system(size: 14, weight: .semibold))
            .foregroundStyle(top ? Color(red: 0.30, green: 0.45, blue: 0.91) : palette.text)
          Spacer()
          if let level, let index = levels.firstIndex(of: level) {
            Text("\(index + 1) / \(levels.count)").font(.system(size: 12.5)).monospacedDigit().foregroundStyle(
              palette.secondary)
          }
        }
        .padding(.horizontal, 10)
        .padding(.top, 4)
      }
      .frame(height: 44)
      .clipShape(RoundedRectangle(cornerRadius: 12))
      .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(palette.tertiary, lineWidth: 0.75))
      .shadow(color: top ? Color(red: 0.37, green: 0.52, blue: 1).opacity(0.55) : .clear, radius: 9)
      .opacity(levels.count <= 1 ? 0.55 : 1)
      .overlay {
        GeometryReader { proxy in
          Color.clear.contentShape(Rectangle())
            .gesture(
              DragGesture(minimumDistance: 0).onChanged { drag in pickAt(drag.location.x / proxy.size.width) },
              including: levels.count > 1 ? .all : .none)
        }
      }
      if let level {
        Text(ModelChoice.levelHint(level, levels: levels)).font(.system(size: 13)).foregroundStyle(palette.secondary)
      }
    }
  }

  /// Picks the level under a point along the box.
  ///
  /// - Remark: The box is split evenly by the levels; a level the session already has is not sent
  ///   again.
  /// - SideEffects: May pick a level.
  /// - Parameter fraction: Where along the box, 0 to 1.
  private func pickAt(_ fraction: CGFloat) {
    guard levels.count > 1 else { return }
    let index = min(levels.count - 1, max(0, Int(fraction * CGFloat(levels.count))))
    if levels[index] != level { pick(levels[index]) }
  }

  /// A dot's shade, from two fixed waves so the box looks woven, not flat.
  ///
  /// - Remark: The same for a column and row every time.
  /// - SideEffects: none
  /// - Parameters:
  ///   - column: The dot's column.
  ///   - row: The dot's row.
  /// - Returns: 0 to 1.
  static func noise(_ column: Int, _ row: Int) -> Double {
    (sin(Double(column) * 0.7 + Double(row) * 1.3) * 0.5 + sin(Double(column) * 0.23 - Double(row) * 0.9) * 0.5) * 0.5
      + 0.5
  }

  /// The brand gradient at a point: blue, to cyan, to peach.
  ///
  /// - Remark: The prototype's `#5e84ff → #78d6d6 → #ffaa78`.
  /// - SideEffects: none
  /// - Parameter position: Where along it, 0 to 1.
  /// - Returns: The colour.
  static func brand(_ position: Double) -> Color {
    let stops: [(Double, Double, Double)] = [(0.37, 0.52, 1), (0.47, 0.84, 0.84), (1, 0.67, 0.47)]
    let scaled = min(1.999, max(0, position * 2))
    let index = Int(scaled)
    let t = scaled - Double(index)
    let (a, b) = (stops[index], stops[index + 1])
    return Color(red: a.0 + (b.0 - a.0) * t, green: a.1 + (b.1 - a.1) * t, blue: a.2 + (b.2 - a.2) * t)
  }
}
