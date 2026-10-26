import Foundation
import JavaScriptCore

/// What a stretch of highlighted code is, for picking its colour.
///
/// - Remark: highlight.js has some forty class names; the phone colours a handful (design-language
///   keeps code quiet), so they fold into these. The colours are AtriumUI's.
public enum CodeScope: Equatable, Sendable {
  /// Keywords, tags.
  case keyword
  /// Strings, regular expressions.
  case string
  /// Numbers, literals, built-ins, symbols.
  case constant
  /// Comments, doc tags, meta lines.
  case comment
  /// Function and class names, types.
  case title
  /// Properties, attributes, keys.
  case property
  /// An added line in a diff block.
  case addition
  /// A deleted line in a diff block.
  case deletion
}

/// A run of code with one scope, or none.
///
/// - Remark: Sendable values cross the worker boundary without retaining JavaScript objects.
public struct CodeToken: Equatable, Sendable {
  /// The code, unescaped.
  public let text: String
  /// What it is; `nil` is plain.
  public let scope: CodeScope?

  /// Makes a token.
  ///
  /// - Remark: Public so tests and views can build them.
  /// - SideEffects: none
  /// - Parameters:
  ///   - text: The code.
  ///   - scope: What it is.
  public init(_ text: String, _ scope: CodeScope?) {
    self.text = text
    self.scope = scope
  }
}

/// Highlights code with highlight.js 11.11.1 running in JavaScriptCore, off the main thread.
///
/// - Remark: Chosen over tree-sitter, HighlightSwift and HighlighterSwift (see AtriumRender's
///   section in design-language "手机端" and the comparison in the final report): it covers every
///   language the replies use in one 127 KB file with no SwiftPM dependency, the colours are ours
///   because the HTML it returns is read here by class name instead of through a theme or the
///   `NSAttributedString` HTML importer (which must not run off the main thread), and an actor
///   keeps the 30–70 ms a long block takes off the main thread. Only a named language is used;
///   unknown names and errors give `nil`, and the block shows plain. The script is loaded on first
///   use and kept.
public actor CodeHighlighter {
  /// The one highlighter; its context is costly to load.
  public static let shared = CodeHighlighter()

  /// The JavaScript context with highlight.js loaded, once loaded.
  private var context: JSContext?
  /// Whether loading failed, so it is not retried on every block.
  private var unavailable = false

  /// Highlights code in a language.
  ///
  /// - Remark: `ignoreIllegals` keeps streaming code highlighted. Over 128 KiB stays plain to bound
  ///   a non-interruptible JavaScript invocation; source is never truncated.
  /// - SideEffects: Loads highlight.js into a JavaScript context on first use.
  /// - Parameters:
  ///   - code: The code.
  ///   - language: The fence's language name, as highlight.js knows it or an alias ("ts", "sh").
  /// - Returns: The tokens, or `nil` when the language is unknown or highlighting failed.
  public func highlight(_ code: String, language: String) -> [CodeToken]? {
    guard !Task.isCancelled, code.utf8.count <= 128 * 1024 else { return nil }
    guard let context = loaded(),
      let hljs = context.objectForKeyedSubscript("hljs"),
      hljs.invokeMethod("getLanguage", withArguments: [language])?.isObject == true,
      let result = hljs.invokeMethod(
        "highlight", withArguments: [code, ["language": language, "ignoreIllegals": true]]),
      context.exception == nil,
      let html = result.objectForKeyedSubscript("value")?.toString()
    else {
      context?.exception = nil
      return nil
    }
    guard !Task.isCancelled else { return nil }
    return Self.tokens(fromHTML: html)
  }

  /// The context, loading highlight.js the first time.
  ///
  /// - Remark: See the type.
  /// - SideEffects: Reads the bundled script and evaluates it.
  /// - Returns: The context, or `nil` when the script cannot be loaded.
  private func loaded() -> JSContext? {
    if let context { return context }
    guard !unavailable,
      let url = Bundle.module.url(forResource: "highlight.min", withExtension: "js"),
      let script = try? String(contentsOf: url, encoding: .utf8),
      let fresh = JSContext()
    else {
      unavailable = true
      return nil
    }
    fresh.evaluateScript(script)
    guard fresh.exception == nil, fresh.objectForKeyedSubscript("hljs")?.isObject == true else {
      unavailable = true
      return nil
    }
    context = fresh
    return fresh
  }

  /// Reads highlight.js's HTML into tokens.
  ///
  /// - Remark: The HTML is only `<span class="hljs-…">`, `</span>` and escaped text (`&amp;`,
  ///   `&lt;`, `&gt;`, `&quot;`, `&#x27;`). Spans nest; a run takes the scope of the innermost span
  ///   that maps to one, so `${x}` inside a template string stays a string's colour unless it is
  ///   something itself. Adjacent runs of the same scope merge.
  /// - SideEffects: none
  /// - Parameter html: What `hljs.highlight(…).value` returned.
  /// - Returns: The tokens, in order, their texts adding up to the code.
  public static func tokens(fromHTML html: String) -> [CodeToken] {
    var tokens: [CodeToken] = []
    var stack: [CodeScope?] = []
    var text = ""
    /// Ends the current run of text.
    ///
    /// - Remark: Merges into the previous token when the scope is the same.
    /// - SideEffects: Appends to `tokens`, empties `text`.
    func flush() {
      guard !text.isEmpty else { return }
      let scope = stack.last { $0 != nil } ?? nil
      if let last = tokens.last, last.scope == scope {
        tokens[tokens.count - 1] = CodeToken(last.text + text, scope)
      } else {
        tokens.append(CodeToken(text, scope))
      }
      text = ""
    }
    var rest = Substring(html)
    while let next = rest.firstIndex(where: { $0 == "<" || $0 == "&" }) {
      text += rest[..<next]
      rest = rest[next...]
      if rest.hasPrefix("</span>") {
        flush()
        _ = stack.popLast()
        rest = rest.dropFirst(7)
      } else if rest.hasPrefix("<span class=\""), let close = rest.firstIndex(of: ">") {
        flush()
        let classes = rest[rest.index(rest.startIndex, offsetBy: 13)..<close].dropLast()
        stack.append(scope(of: String(classes)))
        rest = rest[rest.index(after: close)...]
      } else if let entity = entities.first(where: { rest.hasPrefix($0.key) }) {
        text += entity.value
        rest = rest.dropFirst(entity.key.count)
      } else {
        text.append(rest.removeFirst())
      }
    }
    text += rest
    flush()
    return tokens
  }

  /// The entities highlight.js writes, and what they stand for.
  private static let entities: [String: String] = [
    "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"", "&#x27;": "'",
  ]

  /// The scope of a span's classes, such as "hljs-title function_".
  ///
  /// - Remark: Classes that change nothing visible (params, variables, punctuation, subst) are
  ///   `nil`, so the text takes its surroundings' colour.
  /// - SideEffects: none
  /// - Parameter classes: The span's class attribute.
  /// - Returns: The scope.
  static func scope(of classes: String) -> CodeScope? {
    let name = classes.split(separator: " ").first.map { String($0.dropFirst(5)) } ?? ""
    switch name {
    case "keyword", "tag", "selector-tag", "section", "name": return .keyword
    case "string", "regexp", "char", "template-tag", "link": return .string
    case "number", "literal", "built_in", "symbol", "bullet", "selector-id", "selector-class": return .constant
    case "comment", "doctag", "meta", "quote": return .comment
    case "title", "type", "class", "function": return .title
    case "attr", "attribute", "property", "selector-attr", "selector-pseudo", "template-variable": return .property
    case "addition": return .addition
    case "deletion": return .deletion
    default: return nil
    }
  }
}
