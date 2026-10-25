// swift-tools-version: 6.2
import PackageDescription

/// Settings every target shares (coding-standards.md, "Swift（手机端）").
///
/// Warnings fail the build through `scripts/ios.mjs` (`-Xswiftc -warnings-as-errors`), not here:
/// Xcode builds a local package with `-suppress-warnings`, which clashes with
/// `treatAllWarnings(as: .error)`.
let shared: [SwiftSetting] = [
  .enableUpcomingFeature("NonisolatedNonsendingByDefault"),
  .enableUpcomingFeature("InferIsolatedConformances"),
]

/// The interface runs on the main actor by default; the logic modules are not isolated.
let mainActor: [SwiftSetting] = shared + [.defaultIsolation(MainActor.self)]

let package = Package(
  name: "AtriumKit",
  platforms: [.iOS(.v26), .macOS(.v26)],
  products: [
    .library(name: "AtriumUI", targets: ["AtriumUI"])
  ],
  targets: [
    .target(name: "AtriumProtocol", swiftSettings: shared),
    .target(name: "AtriumNoise", swiftSettings: shared),
    .target(name: "AtriumRemote", dependencies: ["AtriumProtocol", "AtriumNoise"], swiftSettings: shared),
    .target(name: "AtriumSync", dependencies: ["AtriumProtocol"], swiftSettings: shared),
    .target(name: "AtriumRender", dependencies: ["AtriumProtocol"], swiftSettings: shared),
    .target(
      name: "AtriumUI",
      dependencies: ["AtriumProtocol", "AtriumRemote", "AtriumSync", "AtriumRender"],
      swiftSettings: mainActor
    ),
    .testTarget(
      name: "AtriumProtocolTests",
      dependencies: ["AtriumProtocol"],
      resources: [.copy("Fixtures")],
      swiftSettings: shared
    ),
    .testTarget(name: "AtriumNoiseTests", dependencies: ["AtriumNoise"], swiftSettings: shared),
    .testTarget(name: "AtriumRemoteTests", dependencies: ["AtriumRemote"], swiftSettings: shared),
    .testTarget(name: "AtriumSyncTests", dependencies: ["AtriumSync"], swiftSettings: shared),
    .testTarget(name: "AtriumRenderTests", dependencies: ["AtriumRender"], swiftSettings: shared),
    .testTarget(name: "AtriumUITests", dependencies: ["AtriumUI"], swiftSettings: mainActor),
  ]
)
