/*
See LICENSE folder for this sample’s licensing information.

Abstract:
The window scene delegate; configures the split view controller once the scene connects.
*/

import UIKit

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    // MARK: - Properties

    var window: UIWindow?

    /** The detailViewManager is responsible for maintaining the UISplitViewController delegation
        and for managing the detail view controller of the split view.
    */
    var detailViewManager = DetailViewManager()

    // MARK: - UIWindowSceneDelegate

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let splitViewController = window?.rootViewController as? UISplitViewController else { return }
        splitViewController.preferredDisplayMode = .allVisible
        splitViewController.delegate = detailViewManager
        detailViewManager.splitViewController = splitViewController

        // Set the master view controller table view with translucent background.
        splitViewController.primaryBackgroundStyle = .sidebar
    }
}
