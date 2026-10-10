import Flutter
import UIKit

@main
@objc class AppDelegate: FlutterAppDelegate, FlutterImplicitEngineDelegate {
  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  func didInitializeImplicitFlutterEngine(_ engineBridge: FlutterImplicitEngineBridge) {
    GeneratedPluginRegistrant.register(with: engineBridge.pluginRegistry)
    registerPrivacyHelpers(engineBridge.pluginRegistry)
  }
}

// MARK: - Privacy helpers (clipboard expiry and app-switcher cover)
// NOTE: written on Windows; must be compiled and tested on a Mac/iPhone.
extension AppDelegate {
  private static let coverTag = 0x7BD

  func registerPrivacyHelpers(_ registry: FlutterPluginRegistry) {
    if let messenger = registry.registrar(forPlugin: "TbdClipboard")?.messenger() {
      let channel = FlutterMethodChannel(
        name: "com.techboydeepak.tbd/clipboard", binaryMessenger: messenger)
      channel.setMethodCallHandler { call, result in
        guard call.method == "copy",
          let args = call.arguments as? [String: Any],
          let text = args["text"] as? String
        else {
          result(FlutterMethodNotImplemented)
          return
        }
        let seconds = (args["expirySeconds"] as? Int) ?? 20
        UIPasteboard.general.setItems(
          [["public.utf8-plain-text": text]],
          options: [
            .localOnly: true,
            .expirationDate: Date().addingTimeInterval(TimeInterval(seconds)),
          ])
        result(nil)
      }
    }
    NotificationCenter.default.addObserver(
      forName: UIApplication.willResignActiveNotification, object: nil, queue: .main
    ) { [weak self] _ in self?.showCover() }
    NotificationCenter.default.addObserver(
      forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main
    ) { [weak self] _ in self?.hideCover() }
  }

  private func activeWindows() -> [UIWindow] {
    UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .flatMap { $0.windows }
  }

  private func showCover() {
    for window in activeWindows() where window.viewWithTag(Self.coverTag) == nil {
      let cover = UIView(frame: window.bounds)
      cover.tag = Self.coverTag
      cover.backgroundColor = UIColor(red: 8 / 255, green: 8 / 255, blue: 8 / 255, alpha: 1)
      cover.autoresizingMask = [.flexibleWidth, .flexibleHeight]
      window.addSubview(cover)
    }
  }

  private func hideCover() {
    for window in activeWindows() {
      window.viewWithTag(Self.coverTag)?.removeFromSuperview()
    }
  }
}
