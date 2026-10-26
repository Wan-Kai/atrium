import AtriumUI
import Testing

@Suite("Home view")
struct HomeViewTests {
  @Test("is titled Atrium")
  func title() {
    #expect(HomeView.title == "Atrium")
  }
}
