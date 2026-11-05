// swift-tools-version: 5.9
// Provian Secure Enclave signing CLI for supported human-owned Mac devices.
// Relay policy caps this path at hardware_partial until platform attestation is verifiable;
// agent-owned devices remain software regardless of signing method.

import PackageDescription

let package = Package(
    name: "provian-se-sign",
    platforms: [
        .macOS(.v13)
    ],
    targets: [
        .executableTarget(
            name: "provian-se-sign",
            path: "Sources"
        ),
    ]
)
