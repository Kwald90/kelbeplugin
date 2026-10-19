import ARKit
import AVFoundation
import Capacitor
import UIKit

/// FishtapeMeasure: the native AR tape behind Wire Runs > AR tape.
///
/// JS contract (docs/BUILD-PLAN.md, electrical-app/js/lib/ar-measure.js), reached through
/// `window.Capacitor.Plugins.FishtapeMeasure`:
///
///     isAvailable() -> { available: boolean }
///     measurePath({ units: 'metric' | 'imperial' })
///       -> { totalM, segments: [{ lengthM }], points: [{ x, y, z }], snapshot: 'data:image/jpeg;base64,...' }
///       rejects with message and code 'cancelled' when the user backs out.
///
/// Lengths are always metres in ARKit world space; `units` only sets the labels drawn in the AR view.
/// Registered by MainViewController.capacitorDidLoad().
@objc(FishtapeMeasurePlugin)
public class FishtapeMeasurePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "FishtapeMeasurePlugin"
    public let jsName = "FishtapeMeasure"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "measurePath", returnType: CAPPluginReturnPromise)
    ]

    static let cameraDeniedMessage =
        "Camera access is off for Fishtape. To measure with AR, turn it on in Settings > Fishtape > Camera."

    /// The AR screen while it is open, so a second measurePath call can't stack another one on top.
    private weak var activeScreen: MeasureViewController?

    @objc func isAvailable(_ call: CAPPluginCall) {
        // false in the Simulator and on devices without world tracking.
        call.resolve(["available": ARWorldTrackingConfiguration.isSupported])
    }

    @objc func measurePath(_ call: CAPPluginCall) {
        guard ARWorldTrackingConfiguration.isSupported else {
            call.reject("This iPhone or iPad does not support ARKit world tracking.", "unavailable")
            return
        }
        let units = MeasureUnits(rawValue: call.getString("units") ?? "") ?? .metric
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            DispatchQueue.main.async { self.present(call, units: units) }
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { granted in
                DispatchQueue.main.async {
                    if granted {
                        self.present(call, units: units)
                    } else {
                        self.cameraDenied(call)
                    }
                }
            }
        default: // .denied, .restricted
            DispatchQueue.main.async { self.cameraDenied(call) }
        }
    }

    @MainActor
    private func present(_ call: CAPPluginCall, units: MeasureUnits) {
        guard activeScreen == nil else {
            call.reject("AR measuring is already open.", "busy")
            return
        }
        guard let host = topViewController() else {
            call.reject("The app isn't ready to show the camera yet. Try again.", "no_view")
            return
        }
        let screen = MeasureViewController(units: units)
        screen.onFinish = { outcome in
            switch outcome {
            case .done(let result):
                call.resolve(result)
            case .cancelled:
                call.reject("cancelled", "cancelled")
            case .failed(let message, let code):
                call.reject(message, code)
            }
        }
        activeScreen = screen
        host.present(screen, animated: true)
    }

    /// Explain why AR can't start and offer a way to fix it; the JS side also shows the message.
    @MainActor
    private func cameraDenied(_ call: CAPPluginCall) {
        let message = Self.cameraDeniedMessage
        guard let host = topViewController() else {
            call.reject(message, "camera_denied")
            return
        }
        let alert = UIAlertController(
            title: "Camera access is off",
            message: "Fishtape uses the camera to measure wire runs. Turn on Camera for Fishtape in Settings, then try again.",
            preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Not now", style: .cancel) { _ in
            call.reject(message, "camera_denied")
        })
        alert.addAction(UIAlertAction(title: "Open Settings", style: .default) { _ in
            if let url = URL(string: UIApplication.openSettingsURLString) {
                UIApplication.shared.open(url)
            }
            call.reject(message, "camera_denied")
        })
        host.present(alert, animated: true)
    }

    @MainActor
    private func topViewController() -> UIViewController? {
        var top = bridge?.viewController
        while let presented = top?.presentedViewController {
            top = presented
        }
        return top
    }
}
