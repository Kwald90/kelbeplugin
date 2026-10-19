import Capacitor
import UIKit

/// Fishtape's bridge view controller. It registers the plugins that live in this app target
/// (Capacitor's way for local plugins; npm plugins such as Filesystem and Share register themselves),
/// and gives the web view the app's background colour so there is no white flash at launch.
/// SceneDelegate and Main.storyboard both use this class.
class MainViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(FishtapeMeasurePlugin())
        bridge?.registerPluginInstance(FishtapeKeychainPlugin())
        bridge?.registerPluginInstance(FishtapePrintPlugin())

        // --bg in electrical-app/css/tokens.css (light #f1efea, dark #16171a)
        let background = UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? UIColor(red: 0x16 / 255.0, green: 0x17 / 255.0, blue: 0x1A / 255.0, alpha: 1)
                : UIColor(red: 0xF1 / 255.0, green: 0xEF / 255.0, blue: 0xEA / 255.0, alpha: 1)
        }
        webView?.isOpaque = false
        webView?.backgroundColor = background
        webView?.scrollView.backgroundColor = background
    }
}
