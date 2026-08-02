import Darwin
import Foundation
import Security

private let service =
  "delivery-loop-github-app-transport-diagnostic-cloudflare-observability-token"
private let account = "delivery-loop-transport-diagnostic"
private let data = FileHandle.standardInput.readDataToEndOfFile()

guard data.count >= 40, data.count <= 80,
      let secret = String(data: data, encoding: .utf8),
      secret.hasPrefix("cfat_") else {
  exit(EXIT_FAILURE)
}

let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-")
guard secret.unicodeScalars.dropFirst(5).allSatisfy({ allowed.contains($0) }) else {
  exit(EXIT_FAILURE)
}

let query: [CFString: Any] = [
  kSecClass: kSecClassGenericPassword,
  kSecAttrService: service,
  kSecAttrAccount: account,
  kSecAttrAccessible: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
  kSecValueData: data,
]

guard SecItemAdd(query as CFDictionary, nil) == errSecSuccess else {
  exit(EXIT_FAILURE)
}
