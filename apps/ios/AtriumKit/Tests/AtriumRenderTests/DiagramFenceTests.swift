import AtriumRender
import Testing

@Suite("Diagram fence")
struct DiagramFenceTests {
  @Test("shows Mermaid and PlantUML as source, by the first word of the info string", arguments: [
    "mermaid", "Mermaid", "plantuml", "puml", "mermaid title=x",
  ])
  func diagrams(_ info: String) {
    #expect(DiagramFence.isDiagram(info))
  }

  @Test("draws everything else as code", arguments: ["swift", "", "mermaidjs", "text mermaid"])
  func code(_ info: String) {
    #expect(!DiagramFence.isDiagram(info))
  }
}
