import AtriumProtocol
import AtriumSync
import ImageIO
import SwiftUI

/// The model sheet: the provider bar, the models, the thinking box and Fast.
///
/// - Remark: The desktop's model panel in the phone's colours (design-language "手机端 · 模型 sheet",
///   SPEC-0005 "界面" 2026-10-28, rechecked against the desktop 2026-10-29): close and refresh as the
///   home's 44pt glass keys, "模型" with "从下一条消息开始生效" between; no search, as on the desktop;
///   the column of provider icons (`ProviderColumn`), a hairline, and the models of the provider
///   picked under its name, "套餐" and "N 个模型", each with its context, output and the desktop's ⚡;
///   the desktop's thinking box (`ThinkingBox`); then the Fast switch where the model has it, since
///   the input's model key carries ⚡ instead of a key of its own. Picking does not close the sheet.
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
        ProviderColumn(providers: groups.map(\.providerId), picked: picked, current: current?.providerId) {
          provider = $0
        }
        Rectangle().fill(palette.line).frame(width: 0.5).padding(.trailing, 6)
        ScrollView {
          VStack(alignment: .leading, spacing: 0) {
            let shown = groups.first { $0.providerId == picked }?.models ?? []
            HStack(alignment: .firstTextBaseline, spacing: 6) {
              Text(ModelChoice.providerName(picked ?? ""))
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(palette.text2)
              if let picked, ModelChoice.onPlan(picked) {
                Text("套餐").font(.system(size: 12)).foregroundStyle(palette.tint).padding(.leading, 2)
              }
              Text("\(shown.count) 个模型").font(.system(size: 12)).foregroundStyle(palette.secondary)
              Spacer()
            }
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
        .padding(.horizontal, Metrics.xs)
        .padding(.top, Metrics.sm)
        if let fast = currentModel.fast {
          Toggle(
            isOn: Binding(get: { state?.fast ?? false }, set: { sync.perform(.setFast($0), in: sessionId) })
          ) {
            VStack(alignment: .leading, spacing: 2) {
              HStack(spacing: 4) {
                FastBolt(size: 15, filled: state?.fast ?? false)
                  .foregroundStyle(state?.fast == true ? palette.tint : palette.secondary)
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
      GlassCircleButton(systemImage: "xmark", label: "关闭") { dismiss() }
      Spacer()
      VStack(spacing: 2) {
        Text("模型").font(.system(size: 17, weight: .semibold)).foregroundStyle(palette.text)
        Text("从下一条消息开始生效").font(.system(size: 12.5)).foregroundStyle(palette.secondary)
      }
      Spacer()
      GlassCircleButton(systemImage: "arrow.clockwise", label: "刷新") {
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
              FastBolt(size: 11).foregroundStyle(palette.tint)
                .accessibilityElement().accessibilityLabel("支持 Fast")
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
