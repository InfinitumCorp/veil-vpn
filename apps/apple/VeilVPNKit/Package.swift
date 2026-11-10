// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "VeilVPNKit",
    platforms: [
        .iOS(.v17),
        .macOS(.v14),
    ],
    products: [
        .library(name: "VeilVPNKit", targets: ["VeilVPNKit"]),
    ],
    dependencies: [
        .package(url: "https://github.com/apple/swift-crypto.git", from: "3.8.0"),
    ],
    targets: [
        .target(
            name: "VeilVPNKit",
            dependencies: [
                .product(name: "Crypto", package: "swift-crypto"),
            ]
        ),
        .testTarget(
            name: "VeilVPNKitTests",
            dependencies: ["VeilVPNKit"]
        ),
    ]
)
