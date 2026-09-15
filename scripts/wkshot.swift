// wkshot: render a URL with the system WebKit (Safari's engine) headlessly, run a JS file and
// save a PNG. Build: swiftc -O scripts/wkshot.swift -o /tmp/wkshot
// Usage: wkshot <url> <out.png> <width> <height> [js-file] [settle-ms]; WKSHOT_MEDIA=print lays
// the page out as print media. Layout only: never print through a WKWebView from a CLI
// process — its NSPrintOperation never terminates and writes an unbounded PDF.
import Cocoa
import WebKit

let a = CommandLine.arguments
guard a.count >= 5, let url = URL(string: a[1]), let w = Double(a[3]), let h = Double(a[4]) else {
    print("usage: wkshot <url> <out.png> <width> <height> [js-file] [settle-ms]"); exit(64)
}
let outPath = a[2]
let jsPath: String? = a.count > 5 && a[5] != "-" ? a[5] : nil
let settle = a.count > 6 ? (Double(a[6]) ?? 800) / 1000 : 0.8

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let rect = NSRect(x: 0, y: 0, width: w, height: h)
let window = NSWindow(contentRect: rect, styleMask: [.borderless], backing: .buffered, defer: false)
let config = WKWebViewConfiguration()
config.preferences.setValue(true, forKey: "developerExtrasEnabled")
let webView = WKWebView(frame: rect, configuration: config)
if let m = ProcessInfo.processInfo.environment["WKSHOT_MEDIA"], !m.isEmpty { webView.mediaType = m }
window.contentView = webView
window.orderBack(nil) // must be in a window for the compositor to paint snapshots

func finish(_ code: Int32) -> Never { exit(code) }

final class Delegate: NSObject, WKNavigationDelegate {
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        DispatchQueue.main.asyncAfter(deadline: .now() + settle) {
            let js = jsPath.flatMap { try? String(contentsOfFile: $0, encoding: .utf8) } ?? "'no-js'"
            webView.evaluateJavaScript(js) { result, error in
                if let error { print("JS-ERROR: \(error)") } else { print("JS-RESULT: \(result.map { "\($0)" } ?? "undefined")") }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
                    webView.takeSnapshot(with: nil) { image, error in
                        guard let image, let tiff = image.tiffRepresentation,
                              let rep = NSBitmapImageRep(data: tiff),
                              let png = rep.representation(using: .png, properties: [:]) else {
                            print("SNAPSHOT-ERROR: \(String(describing: error))"); finish(1)
                        }
                        do { try png.write(to: URL(fileURLWithPath: outPath)); print("PNG: \(outPath) \(Int(image.size.width))x\(Int(image.size.height))") }
                        catch { print("WRITE-ERROR: \(error)"); finish(1) }
                        finish(0)
                    }
                }
            }
        }
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { print("NAV-FAIL: \(error)"); finish(2) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { print("NAV-FAIL: \(error)"); finish(2) }
}
let delegate = Delegate()
webView.navigationDelegate = delegate
if url.isFileURL { webView.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent()) }
else { webView.load(URLRequest(url: url)) }
DispatchQueue.main.asyncAfter(deadline: .now() + 40) { print("TIMEOUT"); finish(3) }
app.run()
