// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "ProvianForegroundHelper",
    platforms: [.macOS(.v11)],
    targets: [
        .executableTarget(
            name: "ProvianForegroundHelper",
            path: "Sources/ProvianForegroundHelper",
            linkerSettings: [
                .linkedFramework("AppKit")
            ]
        )
    ],
    swiftLanguageVersions: [.v5]
)
