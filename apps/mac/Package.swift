// swift-tools-version: 6.0
import PackageDescription
let package = Package(name: "CallScribe", platforms: [.macOS("26.0")], products: [.executable(name: "CallScribe", targets: ["CallScribe"])], targets: [.executableTarget(name: "CallScribe"), .testTarget(name: "CallScribeTests", dependencies: ["CallScribe"])], swiftLanguageModes: [.v5])
