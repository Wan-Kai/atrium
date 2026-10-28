import Testing

@testable import AtriumUI

@Suite("Settings page")
struct SettingsPageTests {
  @Test("one appearance key goes round: system, light, dark, then system again")
  func appearance() {
    #expect(SettingsPage.next("system") == "light")
    #expect(SettingsPage.next("light") == "dark")
    #expect(SettingsPage.next("dark") == "system")
    #expect(SettingsPage.next("anything else") == "light")
    #expect(SettingsPage.label("system") == "跟随系统")
    #expect(SettingsPage.label("light") == "浅色")
    #expect(SettingsPage.label("dark") == "深色")
  }
}
