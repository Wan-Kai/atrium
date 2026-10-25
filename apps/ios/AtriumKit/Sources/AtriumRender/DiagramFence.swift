/// Tells which code blocks the first version shows as their source instead of drawing them.
///
/// - Remark: Mermaid and PlantUML are shown as text with "在 Mac 上查看" (SPEC-0005 "渲染");
///   drawing them would need a web view or a port of the desktop's workers.
public enum DiagramFence {
  /// Tells whether a fenced code block's info string names a diagram language.
  ///
  /// - Remark: Only the first word of the info string is the language, as in CommonMark.
  /// - SideEffects: none
  /// - Parameter info: The text after the opening fence.
  /// - Returns: Whether it is Mermaid or PlantUML.
  public static func isDiagram(_ info: String) -> Bool {
    let language = info.split(separator: " ", maxSplits: 1).first.map { $0.lowercased() } ?? ""
    return ["mermaid", "plantuml", "puml"].contains(language)
  }
}
