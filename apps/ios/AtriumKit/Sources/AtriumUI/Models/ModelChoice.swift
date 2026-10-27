import AtriumProtocol
import Foundation

/// The words and rules of the model sheet, as the desktop's.
///
/// - Remark: SPEC-0005 "MP6 定的细节 · MP6c": a port of `packages/ui/src/chat/model-choice.ts` —
///   level names and hints, the thinking box's coverage, token counts, provider names and icons,
///   which providers are always on a plan — plus the phone's Fast words and the input's pill.
enum ModelChoice {
  /// One provider's models, in pi's order.
  ///
  /// - Remark: The model sheet shows one provider's at a time.
  struct Group: Equatable, Identifiable {
    /// The provider.
    let providerId: String
    /// Its models.
    let models: [CatalogModel]
    /// What tells groups apart.
    var id: String { providerId }
  }

  /// Each level's name (the desktop's `LEVEL_NAMES`).
  ///
  /// - Remark: The four common ones read 低 / 中 / 高 / 极高.
  /// - SideEffects: none
  /// - Parameter level: The level.
  /// - Returns: The name.
  static func levelName(_ level: ThinkingLevel) -> String {
    switch level {
    case .off: "关闭"
    case .minimal: "最低"
    case .low: "低"
    case .medium: "中"
    case .high: "高"
    case .xhigh: "极高"
    case .max: "最高"
    }
  }

  /// What a level suits (the desktop's `levelHint`).
  ///
  /// - Remark: A model's top level is always the slowest, whatever its name; a model that only has
  ///   `off` does not think at all.
  /// - SideEffects: none
  /// - Parameters:
  ///   - level: The level.
  ///   - levels: The model's levels.
  /// - Returns: The hint.
  static func levelHint(_ level: ThinkingLevel, levels: [ThinkingLevel]) -> String {
    if levels.count == 1, level == .off { return "这个模型不推理" }
    if levels.last == level { return "最慢最贵，留给最难的任务" }
    switch level {
    case .off: return "不推理，回答最快"
    case .minimal: return "稍作思考，适合很简单的事"
    case .low: return "想得少，适合简单、明确的小改动"
    case .medium: return "默认，兼顾速度和质量"
    case .high: return "想得更久，适合难排查的问题"
    case .xhigh: return "想得很久，适合最难的问题"
    case .max: return "最慢最贵，留给最难的任务"
    }
  }

  /// How much of the thinking box a level fills (the desktop's `coverageOf`).
  ///
  /// - Remark: `off` and a level the model does not have fill nothing; the top level fills it.
  /// - SideEffects: none
  /// - Parameters:
  ///   - level: The level, or `nil`.
  ///   - levels: The model's levels.
  /// - Returns: The coverage, 0 to 1.
  static func coverage(_ level: ThinkingLevel?, levels: [ThinkingLevel]) -> Double {
    guard let level, level != .off, let index = levels.firstIndex(of: level) else { return 0 }
    return Double(index + 1) / Double(levels.count)
  }

  /// A token count as the model rows write it: "128K", "1M", "2.5M".
  ///
  /// - Remark: One decimal at most, dropped when it is 0.
  /// - SideEffects: none
  /// - Parameter count: The count.
  /// - Returns: The words.
  static func tokens(_ count: Int) -> String {
    let trim = { (value: Double) -> String in
      let rounded = (value * 10).rounded() / 10
      return rounded == rounded.rounded() ? String(Int(rounded)) : String(rounded)
    }
    if count >= 1_000_000 { return "\(trim(Double(count) / 1_000_000))M" }
    if count >= 1_000 { return "\(trim(Double(count) / 1_000))K" }
    return String(count)
  }

  /// The providers Atrium names, and their icon files in the package's resources.
  private static let providers: [String: (name: String, logo: String)] = [
    "anthropic": ("Anthropic", "claude.png"), "claude-bridge": ("Claude 订阅", "claude.png"),
    "openai": ("OpenAI", "openai.png"), "openai-codex": ("ChatGPT 订阅", "openai.png"),
    "azure-openai-responses": ("Azure OpenAI", "openai.png"), "github-copilot": ("GitHub Copilot", "copilot.png"),
    "openrouter": ("OpenRouter", "openrouter.png"), "xai": ("xAI", "xai.png"), "moonshotai": ("Kimi", "kimi.png"),
    "moonshotai-cn": ("Kimi", "kimi.png"), "kimi-coding": ("Kimi Coding", "kimi.png"),
    "deepseek": ("DeepSeek", "deepseek.png"), "catpaw-cli": ("catpaw-cli", "catpaw.webp"),
    "sankuai-openai": ("Friday", "friday.png"),
  ]

  /// A provider's name: Atrium's for the ones it knows, pi's id otherwise.
  ///
  /// - Remark: The desktop's `providerOf`.
  /// - SideEffects: none
  /// - Parameter providerId: The provider.
  /// - Returns: The name.
  static func providerName(_ providerId: String) -> String {
    providers[providerId]?.name ?? providerId
  }

  /// A provider's icon file, for the ones with a confirmed official icon.
  ///
  /// - Remark: `nil` for others, which show their name's first letter in a plain tile.
  /// - SideEffects: none
  /// - Parameter providerId: The provider.
  /// - Returns: The file's name in `Resources/brand`.
  static func logo(_ providerId: String) -> String? {
    providers[providerId]?.logo
  }

  /// Whether a provider's models always go through a subscription plan ("套餐").
  ///
  /// - Remark: The desktop's `onPlan` for the providers that are always on one; the others depend
  ///   on a login the host does not send the phone (SPEC-0005 "MP6 定的细节 · MP6c").
  /// - SideEffects: none
  /// - Parameter providerId: The provider.
  /// - Returns: Whether it is.
  static func onPlan(_ providerId: String) -> Bool {
    ["claude-bridge", "openai-codex", "github-copilot"].contains(providerId)
  }

  /// The models by provider, in the order pi lists them.
  ///
  /// - Remark: The desktop's `groupByProvider`.
  /// - SideEffects: none
  /// - Parameter models: The catalog's models.
  /// - Returns: The groups.
  static func groups(_ models: [CatalogModel]) -> [Group] {
    var order: [String] = []
    var byProvider: [String: [CatalogModel]] = [:]
    for model in models {
      if byProvider[model.providerId] == nil { order.append(model.providerId) }
      byProvider[model.providerId, default: []].append(model)
    }
    return order.map { Group(providerId: $0, models: byProvider[$0] ?? []) }
  }

  /// What Fast does, under its switch.
  ///
  /// - Remark: SPEC-0005 "MP6 定的细节 · MP6c".
  /// - SideEffects: none
  /// - Parameters:
  ///   - speed: How many times as fast, if known.
  ///   - moreUsage: Whether it uses more of the plan.
  /// - Returns: The words.
  static func fastText(speed: Double?, moreUsage: Bool) -> String {
    guard let speed else { return moreUsage ? "更快，额度消耗增加" : "更快" }
    let times = speed == speed.rounded() ? String(Int(speed)) : String(speed)
    return "约 \(times) 倍速度" + (moreUsage ? "，额度消耗增加" : "")
  }

  /// The model pill above the input: "名字 · 档位 · ⚡".
  ///
  /// - Remark: No level when off or unknown, no ⚡ without Fast.
  /// - SideEffects: none
  /// - Parameters:
  ///   - name: The model's name.
  ///   - level: Its level.
  ///   - fast: Whether Fast is on.
  /// - Returns: The words.
  static func pill(name: String, level: ThinkingLevel?, fast: Bool) -> String {
    var parts = [name]
    if let level, level != .off { parts.append(levelName(level)) }
    if fast { parts.append("⚡") }
    return parts.joined(separator: " · ")
  }

  /// The level to keep after switching to a model with these levels.
  ///
  /// - Remark: The same one if the model has it; else "高"; else its top (the prototype's rule).
  /// - SideEffects: none
  /// - Parameters:
  ///   - level: The level before.
  ///   - levels: The new model's levels.
  /// - Returns: The level, or `nil` for a model without levels.
  static func level(after level: ThinkingLevel?, levels: [ThinkingLevel]) -> ThinkingLevel? {
    if let level, levels.contains(level) { return level }
    if levels.contains(.high) { return .high }
    return levels.last
  }
}

extension CatalogModel {
  /// What tells a model's row apart: its provider and its id.
  ///
  /// - Remark: Search lists every provider's models together, and two providers can list the same id
  ///   (the MP6 review).
  var rowId: String { "\(providerId)\u{0}\(modelId)" }
}
