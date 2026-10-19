import Capacitor
import Foundation
import Security

/// FishtapeKeychain: the web app's small secrets in the iOS Keychain instead of web storage.
/// Used by electrical-app/js/lib/native.js and js/session.js for the API session token ("session")
/// and the shared-iPad device token ("device"). No other keys are accepted.
///
///     get({ key })         -> { value?: string }   (no value when nothing is saved)
///     set({ key, value })  -> {}
///     remove({ key })      -> {}
///
/// Items are this-device-only (not in iCloud Keychain or backups restored to another device) and
/// readable after the first unlock. Keychain items outlive the app, so the first launch after an
/// install clears anything an earlier install left behind.
@objc(FishtapeKeychainPlugin)
public class FishtapeKeychainPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "FishtapeKeychainPlugin"
    public let jsName = "FishtapeKeychain"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "get", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "set", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise)
    ]

    private static let service = "com.fishtapehq.app.auth"
    private static let allowedKeys: Set<String> = ["session", "device"]
    private static let maxValueBytes = 4096

    override public func load() {
        clearAfterReinstall()
    }

    @objc func get(_ call: CAPPluginCall) {
        guard let key = allowedKey(call) else { return }
        var query = Self.query(for: key)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        switch status {
        case errSecSuccess:
            if let data = item as? Data, let value = String(data: data, encoding: .utf8) {
                call.resolve(["value": value])
            } else {
                call.resolve()
            }
        case errSecItemNotFound:
            call.resolve()
        default:
            call.reject("Couldn't read from the Keychain (\(status)).", "keychain_error")
        }
    }

    @objc func set(_ call: CAPPluginCall) {
        guard let key = allowedKey(call) else { return }
        guard let value = call.getString("value"), !value.isEmpty, value.utf8.count <= Self.maxValueBytes else {
            call.reject("Nothing to save, or the value is too long.", "bad_value")
            return
        }
        let query = Self.query(for: key)
        let attributes: [String: Any] = [
            kSecValueData as String: Data(value.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        ]
        var status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            status = SecItemAdd(query.merging(attributes) { $1 } as CFDictionary, nil)
        }
        if status == errSecSuccess {
            call.resolve()
        } else {
            call.reject("Couldn't save to the Keychain (\(status)).", "keychain_error")
        }
    }

    @objc func remove(_ call: CAPPluginCall) {
        guard let key = allowedKey(call) else { return }
        let status = SecItemDelete(Self.query(for: key) as CFDictionary)
        if status == errSecSuccess || status == errSecItemNotFound {
            call.resolve()
        } else {
            call.reject("Couldn't remove from the Keychain (\(status)).", "keychain_error")
        }
    }

    private func allowedKey(_ call: CAPPluginCall) -> String? {
        guard let key = call.getString("key"), Self.allowedKeys.contains(key) else {
            call.reject("Unknown Keychain key.", "bad_key")
            return nil
        }
        return key
    }

    private static func query(for key: String? = nil) -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service
        ]
        if let key {
            query[kSecAttrAccount as String] = key
        }
        return query
    }

    /// The app's own files go when it is deleted; Keychain items don't. A marker file in Application
    /// Support tells a fresh install from a normal launch.
    private func clearAfterReinstall() {
        let files = FileManager.default
        guard let folder = files.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else { return }
        let marker = folder.appendingPathComponent("fishtape-keychain-in-use")
        if files.fileExists(atPath: marker.path) { return }
        SecItemDelete(Self.query() as CFDictionary)
        try? files.createDirectory(at: folder, withIntermediateDirectories: true)
        files.createFile(atPath: marker.path, contents: Data())
    }
}
