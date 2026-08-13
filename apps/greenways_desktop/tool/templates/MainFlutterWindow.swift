import Cocoa
import FlutterMacOS

class MainFlutterWindow: NSWindow {
  override func awakeFromNib() {
    let flutterViewController = FlutterViewController()
    contentViewController = flutterViewController
    setContentSize(NSSize(width: 1080, height: 720))
    minSize = NSSize(width: 540, height: 620)
    center()
    title = "Greenways Desktop"
    titlebarAppearsTransparent = true
    isReleasedWhenClosed = false

    RegisterGeneratedPlugins(registry: flutterViewController)

    if let appDelegate = NSApp.delegate as? AppDelegate {
      appDelegate.configureDesktopShell(
        messenger: flutterViewController.engine.binaryMessenger,
        window: self
      )
    }

    super.awakeFromNib()
  }

  override func performClose(_ sender: Any?) {
    orderOut(sender)
  }
}
