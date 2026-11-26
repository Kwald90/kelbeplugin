import Capacitor
import Foundation
import UniformTypeIdentifiers

/// "Open in Fishtape" / Share → Fishtape: documents handed to the app by Mail, Messages, Files, Photos
/// or any other app arrive as file URLs at the scene (SceneDelegate) because Info.plist registers
/// CFBundleDocumentTypes. FishtapeIncomingFiles keeps a private copy of each one until the web app takes
/// it; electrical-app/js/lib/files-share.js then opens the Files import sheet and the AI files them.
///
///     takePending() -> { files: [{ name, mimeType, size, data? (base64), error? }] }
///     event "filesReceived" {}     more files arrived while the app was open
///
/// Copies live in the app's tmp/Incoming folder (never backed up, cleared by iOS under pressure) and
/// are deleted as soon as they are handed over. LSSupportsOpeningDocumentsInPlace is on, so the
/// original may be another app's file: it is read under security-scoped access and never changed.
/// Files over the per-file limit are reported without data so the web app can say why.
final class FishtapeIncomingFiles {
    static let shared = FishtapeIncomingFiles()
    static let didReceive = Notification.Name("FishtapeIncomingFilesDidReceive")
    /// Matches the server's default FILES_MAX_MB (70 MB).
    static let maxBytes = 70 * 1024 * 1024
    /// At most this many waiting at once; older ones are dropped first.
    static let maxPending = 50

    private let queue = DispatchQueue(label: "com.fishtapehq.incoming-files")
    private var pending: [URL] = []

    private var folder: URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("Incoming", isDirectory: true)
    }

    /// Copy the files behind these URLs into the app and tell the web app. Non-file URLs are ignored.
    func receive(_ urls: [URL]) {
        let files = urls.filter { $0.isFileURL }
        guard !files.isEmpty else { return }
        queue.async {
            for url in files {
                if let copy = self.copyIn(url) { self.pending.append(copy) }
            }
            while self.pending.count > Self.maxPending {
                try? FileManager.default.removeItem(at: self.pending.removeFirst())
            }
            DispatchQueue.main.async {
                NotificationCenter.default.post(name: Self.didReceive, object: nil)
            }
        }
    }

    private func copyIn(_ url: URL) -> URL? {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let fm = FileManager.default
        do {
            let dir = folder.appendingPathComponent(UUID().uuidString, isDirectory: true)
            try fm.createDirectory(at: dir, withIntermediateDirectories: true)
            let name = url.lastPathComponent.isEmpty ? "Shared file" : url.lastPathComponent
            let dest = dir.appendingPathComponent(name)
            // Coordinated read: the file may belong to a file provider (iCloud Drive, another app).
            var coordError: NSError?
            var copyError: Error?
            NSFileCoordinator().coordinate(readingItemAt: url, options: .withoutChanges, error: &coordError) { readURL in
                do { try fm.copyItem(at: readURL, to: dest) } catch { copyError = error }
            }
            if let e = coordError ?? (copyError as NSError?) { throw e }
            // Mail drops "Open in" copies in Documents/Inbox; remove ours so they don't pile up there.
            if url.path.contains("/Documents/Inbox/") { try? fm.removeItem(at: url) }
            return dest
        } catch {
            NSLog("FishtapeIncomingFiles: could not copy a shared file: %@", error.localizedDescription)
            return nil
        }
    }

    /// Hand over everything waiting (and forget it). Runs off the main thread.
    func take() -> [[String: Any]] {
        queue.sync {
            let urls = pending
            pending.removeAll()
            return urls.map { url -> [String: Any] in
                defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
                let name = url.lastPathComponent
                let type = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
                let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
                var item: [String: Any] = ["name": name, "mimeType": type, "size": size]
                if size > Self.maxBytes {
                    item["error"] = "too large (over 70 MB)"
                } else if let data = try? Data(contentsOf: url) {
                    item["data"] = data.base64EncodedString()
                } else {
                    item["error"] = "unreadable"
                }
                return item
            }
        }
    }
}

@objc(FishtapeIncomingFilesPlugin)
public class FishtapeIncomingFilesPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "FishtapeIncomingFilesPlugin"
    public let jsName = "FishtapeIncomingFiles"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "takePending", returnType: CAPPluginReturnPromise)
    ]

    private var observer: NSObjectProtocol?

    override public func load() {
        observer = NotificationCenter.default.addObserver(forName: FishtapeIncomingFiles.didReceive, object: nil, queue: .main) { [weak self] _ in
            self?.notifyListeners("filesReceived", data: [:], retainUntilConsumed: true)
        }
    }

    deinit {
        if let observer { NotificationCenter.default.removeObserver(observer) }
    }

    @objc func takePending(_ call: CAPPluginCall) {
        DispatchQueue.global(qos: .userInitiated).async {
            call.resolve(["files": FishtapeIncomingFiles.shared.take()])
        }
    }
}
