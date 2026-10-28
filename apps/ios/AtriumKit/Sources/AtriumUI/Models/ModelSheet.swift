import AtriumProtocol
import AtriumSync
import ImageIO
import SwiftUI

/// The model sheet: the provider bar, the models, the thinking box and Fast.
///
/// - Remark: The desktop's model panel in the phone's colours (design-language "手机端 · 模型 sheet",
///   SPEC-0005 "界面" 2026-10-28): "模型" with "从下一条消息开始生效" and a refresh key; no search,
///   as on the desktop; a bar of provider icons (48×44, the current one dotted, "套餐" on those always
///   on a plan), a hairline, and the models of the provider picked, each with its context, output and
///   ⚡; the deep beige dotted thinking box, dragged or tapped to a level; then the Fast switch where
///   the model has it, since the input's model key carries ⚡ instead of a key of its own. Picking does
///   not close the sheet.
struct ModelSheet: View {
  /// The session.
  let sessionId: SessionId
  /// The connection's sync.
  let sync: SyncModel
  /// The provider whose models show.
  @State private var provider: String?
  /// Closes the sheet.
  @Environment(\.dismiss) private var dismiss
  /// Light or dark.
  @Environment(\.colorScheme) private var scheme

  /// The sheet.
  var body: some View {
    let palette = Palette(scheme: scheme)
    let state = sync.core.sessions[sessionId]
    let listed = sync.core.modelsWorkspace == workspaceId ? sync.core.models : nil
    let catalog = listed?.models ?? []
    let current =
      state?.model.map { ModelRef(providerId: $0.providerId, modelId: $0.modelId) }
      ?? listed?.defaultModel
    let groups = ModelChoice.groups(catalog)
    let picked = provider ?? current?.providerId ?? groups.first?.providerId
    let currentModel = catalog.first { $0.providerId == current?.providerId && $0.modelId == current?.modelId }
    VStack(alignment: .leading, spacing: 0) {
      header(palette)
      HStack(alignment: .top, spacing: 0) {
        ScrollView {
          // Room for a "套餐" badge hanging under an icon.
          VStack(spacing: 14) {
            ForEach(groups) { group in
              Button {
                provider = group.providerId
              } label: {
                ProviderIcon(providerId: group.providerId, size: 24)
                  .frame(width: 48, height: 44)
                  .background(
                    picked == group.providerId ? palette.surface : .clear, in: RoundedRectangle(cornerRadius: 12)
                  )
                  .overlay(alignment: .topTrailing) {
                    if current?.providerId == group.providerId {
                      Circle().fill(palette.tint).frame(width: 6, height: 6)
                        .background(Circle().fill(palette.note).padding(-1.5))
                        .padding(.top, 6).padding(.trailing, 7)
                    }
                  }
                  .overlay(alignment: .bottomTrailing) {
                    if ModelChoice.onPlan(group.providerId) {
                      Text("套餐").font(.system(size: 8.5, weight: .bold)).foregroundStyle(palette.tint)
                        .padding(.horizontal, 2).background(palette.note, in: RoundedRectangle(cornerRadius: 3))
                        .padding(.trailing, 1).padding(.bottom, 2)
                    }
                  }
              }
              .buttonStyle(PressStyle())
              .accessibilityLabel(ModelChoice.providerName(group.providerId))
            }
          }
        }
        .frame(width: 60)
        Rectangle().fill(palette.line).frame(width: 0.5).padding(.trailing, 6)
        ScrollView {
          VStack(alignment: .leading, spacing: 0) {
            let shown = groups.first { $0.providerId == picked }?.models ?? []
            HStack {
              Text(ModelChoice.providerName(picked ?? ""))
                .font(.system(size: 13, weight: .medium))
              if let picked, ModelChoice.onPlan(picked) {
                Text("套餐").font(.system(size: 12)).foregroundStyle(palette.tint)
              }
              Spacer()
              Text("\(shown.count) 个模型").font(.system(size: 12)).foregroundStyle(palette.secondary)
            }
            .foregroundStyle(palette.text)
            .padding(.horizontal, Metrics.sm)
            .frame(height: 36)
            if shown.isEmpty {
              Text(catalog.isEmpty ? "正在读取模型…" : "这个服务商没有可用的模型").font(.system(size: 14)).foregroundStyle(
                palette.secondary
              )
              .padding(Metrics.sm)
            }
            ForEach(shown, id: \.rowId) { model in
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
              HStack(spacing: 4) {
                Image(systemName: "bolt.fill").font(.system(size: 12)).foregroundStyle(palette.tint)
                Text("Fast").font(.system(size: 15))
              }
              Text(ModelChoice.fastText(speed: fast.speed, moreUsage: fast.moreUsage) + " · 下一次请求起生效")
                .font(.system(size: 12))
                .foregroundStyle(palette.secondary)
            }
          }
          .tint(palette.tint)
          .padding(.horizontal, Metrics.md)
          .padding(.top, Metrics.sm)
        }
      }
      Spacer(minLength: 0)
    }
    .background(palette.note)
    .presentationDetents([.large])
    .presentationDragIndicator(.visible)
    .task(id: sync.core.synced) { sync.listModels(workspaceId: workspaceId, refresh: false) }
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
            if model.fast != nil {
              Image(systemName: "bolt.fill").font(.system(size: 11)).foregroundStyle(palette.tint)
                .accessibilityLabel("支持 Fast")
            }
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
/// - Remark: The prototype's `efbox`: 3pt rounded dots 5pt apart, deep beige up to the level's share
///   (the paper redesign; the desktop's ink and its top-level gradient are the desktop theme's). A tap
///   or a drag picks the level under the finger. A model with one level cannot be changed.
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
        Text(levels.count > 1 ? "推理强度 · 按住左右拖动" : "推理强度").font(.system(size: 12)).foregroundStyle(palette.secondary)
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
                ? palette.tint.opacity(0.4 + Self.noise(column, row) * 0.5)
                : palette.text.opacity(0.06)
              context.fill(Path(roundedRect: rect, cornerRadius: 0.8), with: .color(color))
            }
          }
        }
        HStack {
          Text(level.map(ModelChoice.levelName) ?? "—").font(.system(size: 14, weight: .semibold))
            .foregroundStyle(top ? palette.tint : palette.text)
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
}
