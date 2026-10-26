import SwiftUI

/// Entry point of the MP0 test app.
///
/// - Side effects: Creates the model, which reads the keychain.
@main
struct AtriumSpikeApp: App {
    @State private var model = SpikeModel()

    var body: some Scene {
        WindowGroup {
            ContentView(model: model)
        }
    }
}
