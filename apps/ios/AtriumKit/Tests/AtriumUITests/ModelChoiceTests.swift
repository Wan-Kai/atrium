import AtriumProtocol
import Foundation
import Testing

@testable import AtriumUI

/// A catalog model.
///
/// - Remark: Decoded as the host sends it.
/// - SideEffects: none
/// - Parameters:
///   - provider: Its provider.
///   - id: Its id.
///   - levels: Its thinking levels.
///   - fast: Its Fast, as JSON.
/// - Returns: The model.
/// - Throws: When the JSON does not decode.
func catalogModel(_ provider: String, _ id: String, levels: [String] = ["off"], fast: String = "null") throws
  -> CatalogModel
{
  let levelList = levels.map { "\"\($0)\"" }.joined(separator: ",")
  let json = """
    {"providerId":"\(provider)","modelId":"\(id)","name":"\(id.capitalized)","contextWindow":400000,\
    "maxOutput":128000,"supportsImage":true,"thinkingLevels":[\(levelList)],"fast":\(fast)}
    """
  return try JSONDecoder().decode(CatalogModel.self, from: Data(json.utf8))
}

@Suite("Model choice")
struct ModelChoiceTests {
  @Test("names every level as the desktop does, and the top one as the slowest")
  func levels() {
    #expect(ThinkingLevel.allCases.map(ModelChoice.levelName) == ["关闭", "最低", "低", "中", "高", "极高", "最高"])
    #expect(ModelChoice.levelHint(.high, levels: [.low, .medium, .high]) == "最慢最贵，留给最难的任务")
    #expect(ModelChoice.levelHint(.medium, levels: [.low, .medium, .high]) == "默认，兼顾速度和质量")
    #expect(ModelChoice.levelHint(.off, levels: [.off]) == "这个模型不推理")
  }

  @Test("fills the dots up to the level, none when off or unknown")
  func coverage() {
    #expect(ModelChoice.coverage(.medium, levels: [.low, .medium, .high, .xhigh]) == 0.5)
    #expect(ModelChoice.coverage(.off, levels: [.off, .low]) == 0)
    #expect(ModelChoice.coverage(.max, levels: [.low]) == 0)
  }

  @Test("writes token counts as 128K and 1M")
  func tokens() {
    #expect(ModelChoice.tokens(128_000) == "128K")
    #expect(ModelChoice.tokens(1_000_000) == "1M")
    #expect(ModelChoice.tokens(2_500_000) == "2.5M")
    #expect(ModelChoice.tokens(900) == "900")
  }

  @Test("names providers it knows, tags the ones always on a plan, and keeps pi's order in groups")
  func providers() throws {
    #expect(ModelChoice.providerName("openai-codex") == "ChatGPT 订阅")
    #expect(ModelChoice.providerName("opencode-go") == "OpenCode Go")
    #expect(ModelChoice.providerName("someone") == "someone")
    #expect(ModelChoice.onPlan("claude-bridge"))
    #expect(ModelChoice.onPlan("opencode-go"))
    #expect(!ModelChoice.onPlan("openai"))
    #expect(!ModelChoice.onPlan("opencode"))
    #expect(ModelChoice.logo("openai") == "openai.png")
    #expect(ModelChoice.logo("opencode") == "opencode.png")
    #expect(ModelChoice.logo("opencode-go") == "opencode.png")
    #expect(ModelChoice.logo("someone") == nil)
    let groups = ModelChoice.groups([
      try catalogModel("openai", "sol"), try catalogModel("anthropic", "opus"), try catalogModel("openai", "luna"),
    ])
    #expect(groups.map(\.providerId) == ["openai", "anthropic"])
    #expect(groups[0].models.map(\.modelId) == ["sol", "luna"])
  }

  @Test("says what Fast does, and what the input's pill shows")
  func fastAndPill() {
    #expect(ModelChoice.fastText(speed: 2, moreUsage: true) == "约 2 倍速度，额度消耗增加")
    #expect(ModelChoice.fastText(speed: 1.5, moreUsage: false) == "约 1.5 倍速度")
    #expect(ModelChoice.fastText(speed: nil, moreUsage: false) == "更快")
    #expect(ModelChoice.fastText(speed: nil, moreUsage: true) == "更快，额度消耗增加")
    #expect(ModelChoice.pill(name: "Sol", level: .high, fast: true) == "Sol · 高 · ⚡")
    #expect(ModelChoice.pill(name: "Sol", level: .off, fast: false) == "Sol")
    #expect(ModelChoice.pill(name: "Sol", level: nil, fast: false) == "Sol")
  }

  @Test("tells apart rows of the same model id from two providers")
  func rowIds() throws {
    let a = try catalogModel("openai", "gpt")
    let b = try catalogModel("openai-codex", "gpt")
    #expect(a.rowId != b.rowId)
    #expect(a.rowId == (try catalogModel("openai", "gpt")).rowId)
  }

  @Test("keeps the level a new model also has, else high, else its top")
  func levelAfterSwitch() {
    #expect(ModelChoice.level(after: .medium, levels: [.low, .medium]) == .medium)
    #expect(ModelChoice.level(after: .xhigh, levels: [.low, .medium, .high]) == .high)
    #expect(ModelChoice.level(after: .minimal, levels: [.low, .high, .max]) == .high)
    #expect(ModelChoice.level(after: .xhigh, levels: [.off, .low]) == .low)
    #expect(ModelChoice.level(after: nil, levels: []) == nil)
  }
}
