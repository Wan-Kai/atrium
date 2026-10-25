// swift-tools-version: 6.2

import PackageDescription

let package = Package(
    name: "AtriumNoiseSpike",
    platforms: [.macOS(.v26), .iOS(.v26)],
    products: [
        .library(name: "AtriumNoiseSpike", targets: ["AtriumNoiseSpike"]),
    ],
    dependencies: [
        // Reference implementation for differential tests only; never linked into a product.
        .package(url: "https://github.com/stonygrey/torann.git", exact: "0.3.1"),
    ],
    targets: [
        .target(name: "AtriumNoiseSpike"),
        .testTarget(
            name: "AtriumNoiseSpikeTests",
            dependencies: ["AtriumNoiseSpike", .product(name: "Torann", package: "torann")],
            resources: [.copy("Resources/cacophony-ik.json")]
        ),
    ],
    swiftLanguageModes: [.v6]
)
