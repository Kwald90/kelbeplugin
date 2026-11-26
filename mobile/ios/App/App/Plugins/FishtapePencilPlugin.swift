import Capacitor
import UIKit

/// FishtapePencil: the Apple Pencil's double-tap (Apple Pencil 2, Pencil Pro) and squeeze (Pencil
/// Pro) for the drawing canvas. WKWebView gives the web app the Pencil's touches as pointer events
/// but not these two, which only reach a UIPencilInteraction. This plugin puts one on the web view
/// and forwards what it hears; electrical-app/js/canvas/gestures.js (connectPencil) runs the action
/// the person picked in the canvas's Gestures settings, or the iPad's own setting. Contract:
///
///     status() -> { available, preferredTapAction, preferredSqueezeAction?, prefersPencilOnlyDrawing }
///
/// Events (notifyListeners):
///     "doubleTap"  { preferred, x?, y? }         preferred: the iPad's setting for a double-tap
///     "squeeze"    { phase, preferred, x?, y? }  phase: began | changed | ended | cancelled
///
/// x, y are the Pencil's hover position in the web view (CSS px) when the iPad knows it (iPadOS 17.5+).
/// preferred is one of ignore, switchEraser, switchPrevious, showColorPalette, showInkAttributes,
/// showContextualPalette, runSystemShortcut. prefersPencilOnlyDrawing is iPadOS's "Only Draw with
/// Apple Pencil": the canvas then lets fingers pan instead of draw.
@objc(FishtapePencilPlugin)
public class FishtapePencilPlugin: CAPPlugin, CAPBridgedPlugin, UIPencilInteractionDelegate {
    public let identifier = "FishtapePencilPlugin"
    public let jsName = "FishtapePencil"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "status", returnType: CAPPluginReturnPromise)
    ]

    private var interaction: UIPencilInteraction?

    override public func load() {
        DispatchQueue.main.async { self.install() }
    }

    /// One UIPencilInteraction on the web view, added once it exists.
    private func install() {
        guard interaction == nil, let view = bridge?.webView else { return }
        let pencil = UIPencilInteraction()
        pencil.delegate = self
        view.addInteraction(pencil)
        interaction = pencil
    }

    @objc func status(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.install()
            var out: [String: Any] = [
                "available": self.interaction != nil,
                "preferredTapAction": Self.name(UIPencilInteraction.preferredTapAction),
                "prefersPencilOnlyDrawing": UIPencilInteraction.prefersPencilOnlyDrawing
            ]
            if #available(iOS 17.5, *) {
                out["preferredSqueezeAction"] = Self.name(UIPencilInteraction.preferredSqueezeAction)
            }
            call.resolve(out)
        }
    }

    /// The iPad's Pencil setting as a stable name. By raw value, so cases newer than the
    /// deployment target (showInkAttributes in iOS 16, the iOS 17.5 ones) need no availability check.
    static func name(_ action: UIPencilPreferredAction) -> String {
        switch action.rawValue {
        case 0: return "ignore"
        case 1: return "switchEraser"
        case 2: return "switchPrevious"
        case 3: return "showColorPalette"
        case 4: return "showInkAttributes"
        case 5: return "showContextualPalette"
        case 6: return "runSystemShortcut"
        default: return "unknown"
        }
    }

    private func position(_ pose: Any?, into data: inout [String: Any]) {
        guard #available(iOS 17.5, *) else { return }
        guard let pose = pose as? UIPencilHoverPose, let view = interaction?.view else { return }
        let p = view.convert(pose.location, to: bridge?.webView)
        data["x"] = Double(p.x)
        data["y"] = Double(p.y)
    }

    // MARK: UIPencilInteractionDelegate

    /// iPadOS 12.1 to 17.4 (17.5 and later call the method below instead).
    public func pencilInteractionDidTap(_ interaction: UIPencilInteraction) {
        notifyListeners("doubleTap", data: ["preferred": Self.name(UIPencilInteraction.preferredTapAction)])
    }

    @available(iOS 17.5, *)
    public func pencilInteraction(_ interaction: UIPencilInteraction, didReceiveTap tap: UIPencilInteraction.Tap) {
        var data: [String: Any] = ["preferred": Self.name(UIPencilInteraction.preferredTapAction)]
        position(tap.hoverPose, into: &data)
        notifyListeners("doubleTap", data: data)
    }

    @available(iOS 17.5, *)
    public func pencilInteraction(_ interaction: UIPencilInteraction, didReceiveSqueeze squeeze: UIPencilInteraction.Squeeze) {
        let phase: String
        switch squeeze.phase {
        case .began: phase = "began"
        case .changed: phase = "changed"
        case .ended: phase = "ended"
        case .cancelled: phase = "cancelled"
        @unknown default: phase = "unknown"
        }
        var data: [String: Any] = ["phase": phase, "preferred": Self.name(UIPencilInteraction.preferredSqueezeAction)]
        position(squeeze.hoverPose, into: &data)
        notifyListeners("squeeze", data: data)
    }
}
