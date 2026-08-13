import Cocoa
import FlutterMacOS

@main
class AppDelegate: FlutterAppDelegate {
  private var desktopChannel: FlutterMethodChannel?
  private weak var desktopWindow: NSWindow?
  private var statusItem: NSStatusItem?
  private var connectionState = "disconnected"
  private var connectionBusy = false
  private var identityConfigured = false

  func configureDesktopShell(
    messenger: FlutterBinaryMessenger,
    window: NSWindow
  ) {
    desktopWindow = window
    let channel = FlutterMethodChannel(
      name: "ai.greenways.desktop/window",
      binaryMessenger: messenger
    )
    channel.setMethodCallHandler { [weak self] call, result in
      DispatchQueue.main.async {
        self?.handleDesktopCall(call, result: result)
      }
    }
    desktopChannel = channel
    installStatusItemIfNeeded()
    rebuildStatusMenu()
  }

  private func handleDesktopCall(
    _ call: FlutterMethodCall,
    result: @escaping FlutterResult
  ) {
    switch call.method {
    case "configure", "setConnectionState":
      guard let arguments = call.arguments as? [String: Any],
            let state = arguments["state"] as? String,
            let busy = arguments["busy"] as? Bool,
            let identity = arguments["identityConfigured"] as? Bool,
            Self.allowedStates.contains(state) else {
        result(
          FlutterError(
            code: "invalid-shell-state",
            message: "Greenways Desktop supplied an invalid window state.",
            details: nil
          )
        )
        return
      }
      connectionState = state
      connectionBusy = busy
      identityConfigured = identity
      rebuildStatusMenu()
      result(nil)
    case "showWindow":
      showDesktopWindow()
      result(nil)
    case "quit":
      result(nil)
      NSApp.terminate(self)
    default:
      result(FlutterMethodNotImplemented)
    }
  }

  private func installStatusItemIfNeeded() {
    guard statusItem == nil else { return }
    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    if let button = item.button {
      button.image = NSImage(
        systemSymbolName: "leaf.circle.fill",
        accessibilityDescription: "Greenways Desktop"
      )
      button.image?.isTemplate = true
      button.toolTip = "Greenways Desktop"
    }
    statusItem = item
  }

  private func rebuildStatusMenu() {
    guard let item = statusItem else { return }
    let connectionLabel = Self.label(
      for: connectionState,
      identityConfigured: identityConfigured
    )
    item.button?.toolTip = "Greenways Desktop — \(connectionLabel)"

    let menu = NSMenu()
    menu.addItem(menuItem("Open Greenways Desktop", action: #selector(openDesktop)))

    let status = NSMenuItem(
      title: connectionLabel,
      action: nil,
      keyEquivalent: ""
    )
    status.isEnabled = false
    menu.addItem(status)
    menu.addItem(.separator())

    let connected = connectionState == "connected"
    let connecting = connectionState == "connecting"
    let primary = menuItem(
      connected ? "Refresh connection" : "Connect to greenwaysd",
      action: connected ? #selector(refreshConnection) : #selector(connectToDaemon)
    )
    primary.isEnabled = !connectionBusy && !connecting
    menu.addItem(primary)

    let disconnect = menuItem("Disconnect", action: #selector(disconnectFromDaemon))
    disconnect.isEnabled = connected && !connectionBusy
    menu.addItem(disconnect)
    menu.addItem(.separator())
    menu.addItem(menuItem("Quit Greenways Desktop", action: #selector(quitDesktop)))
    item.menu = menu
  }

  private func menuItem(_ title: String, action: Selector) -> NSMenuItem {
    let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
    item.target = self
    return item
  }

  private func showDesktopWindow() {
    guard let window = desktopWindow else { return }
    window.makeKeyAndOrderFront(self)
    NSApp.activate(ignoringOtherApps: true)
  }

  private func invokeDart(_ method: String) {
    desktopChannel?.invokeMethod(method, arguments: nil)
  }

  @objc private func openDesktop() {
    showDesktopWindow()
  }

  @objc private func connectToDaemon() {
    invokeDart("connect")
  }

  @objc private func refreshConnection() {
    invokeDart("refresh")
  }

  @objc private func disconnectFromDaemon() {
    invokeDart("disconnect")
  }

  @objc private func quitDesktop() {
    guard let channel = desktopChannel else {
      NSApp.terminate(self)
      return
    }
    channel.invokeMethod("quit", arguments: nil) { _ in
      NSApp.terminate(self)
    }
  }

  override func applicationShouldTerminateAfterLastWindowClosed(
    _ sender: NSApplication
  ) -> Bool {
    false
  }

  override func applicationShouldHandleReopen(
    _ sender: NSApplication,
    hasVisibleWindows flag: Bool
  ) -> Bool {
    if !flag {
      showDesktopWindow()
    }
    return true
  }

  override func applicationSupportsSecureRestorableState(
    _ app: NSApplication
  ) -> Bool {
    true
  }

  private static let allowedStates: Set<String> = [
    "connecting",
    "connected",
    "daemon-unavailable",
    "credential-unavailable",
    "authentication-rejected",
    "session-expired",
    "protocol-mismatch",
    "desktop-bridge-unavailable",
    "disconnected",
  ]

  private static func label(
    for state: String,
    identityConfigured: Bool
  ) -> String {
    switch state {
    case "connecting": return "Connecting"
    case "connected" where !identityConfigured:
      return "Connected · Identity setup required"
    case "connected": return "Connected"
    case "daemon-unavailable": return "Daemon unavailable"
    case "credential-unavailable": return "Setup required"
    case "authentication-rejected": return "Authentication rejected"
    case "session-expired": return "Session expired"
    case "protocol-mismatch": return "Upgrade required"
    case "desktop-bridge-unavailable": return "Companion unavailable"
    default: return "Disconnected"
    }
  }
}
