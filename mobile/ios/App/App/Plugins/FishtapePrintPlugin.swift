import Capacitor
import UIKit

/// FishtapePrint: printing for the web app. WKWebView ignores window.print(), so
/// electrical-app/js/lib/native.js sends it here in the iOS app.
///
///     print({ jobName }) -> { completed: boolean }   resolves when the print sheet closes
///
/// Prints the live web view with its print formatter, so the page's @media print rules apply (the
/// print-only copy a screen mounts before calling print()). The iOS print sheet also lets people save
/// or share the output as a PDF.
@objc(FishtapePrintPlugin)
public class FishtapePrintPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "FishtapePrintPlugin"
    public let jsName = "FishtapePrint"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "print", returnType: CAPPluginReturnPromise)
    ]

    @objc func print(_ call: CAPPluginCall) {
        let jobName = String((call.getString("jobName") ?? "Fishtape").prefix(100))
        DispatchQueue.main.async {
            self.present(call, jobName: jobName)
        }
    }

    @MainActor
    private func present(_ call: CAPPluginCall, jobName: String) {
        guard let webView = bridge?.webView, let host = bridge?.viewController else {
            call.reject("Printing isn't ready yet. Try again.", "no_view")
            return
        }
        let info = UIPrintInfo(dictionary: nil)
        info.jobName = jobName
        info.outputType = .general
        let controller = UIPrintInteractionController.shared
        controller.printInfo = info
        controller.printFormatter = webView.viewPrintFormatter()
        controller.showsNumberOfCopies = true
        let completion: UIPrintInteractionController.CompletionHandler = { _, completed, error in
            if let error {
                call.reject("Printing failed: \(error.localizedDescription)", "print_failed")
            } else {
                call.resolve(["completed": completed])
            }
        }
        let shown: Bool
        if UIDevice.current.userInterfaceIdiom == .pad {
            let anchor = CGRect(x: host.view.bounds.midX, y: host.view.bounds.midY, width: 1, height: 1)
            shown = controller.present(from: anchor, in: host.view, animated: true, completionHandler: completion)
        } else {
            shown = controller.present(animated: true, completionHandler: completion)
        }
        if !shown {
            call.reject("The print sheet couldn't open.", "print_unavailable")
        }
    }
}
