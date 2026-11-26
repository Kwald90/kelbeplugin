import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = MainViewController()
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
        // Launched by "Open in Fishtape" / Share: keep the documents for the Files import.
        FishtapeIncomingFiles.shared.receive(connectionOptions.urlContexts.map { $0.url })
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        // Documents shared while the app is running go to the Files import (FishtapeIncomingFilesPlugin);
        // other URLs keep going to Capacitor as before.
        FishtapeIncomingFiles.shared.receive(URLContexts.map { $0.url })
        let others = URLContexts.filter { !$0.url.isFileURL }
        if !others.isEmpty { SceneDelegateProxy.shared.scene(scene, openURLContexts: others) }
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
