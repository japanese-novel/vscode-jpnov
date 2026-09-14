// wkprint: print a URL to PDF through the in-process legacy WebView, whose WebCore pagination
// matches Safari's. Build: swiftc -O -suppress-warnings scripts/wkprint.swift -o /tmp/wkprint
// Usage: WKL_W=700 WKL_H=500 perl -e 'alarm 300; exec @ARGV' /tmp/wkprint <url> <out.pdf> 842 595 0 0 0 0
// Constraints: always under a hard time cap, then `pkill -x wkprint`; keep the view narrower
// than 1.25 × the paper width; pass zero margins to mirror Safari applying @page{margin:0}.
import Cocoa
import WebKit
setbuf(stdout, nil)
let a = CommandLine.arguments
if a.count < 5 { print("usage: wklegacyprint <url> <out.pdf> <paperW-pt> <paperH-pt> [mL mT mR mB]"); exit(64) }
let url = URL(string: a[1])!
let pw = Double(a[3]) ?? 842
let ph = Double(a[4]) ?? 595
let outPath = a[2]
let margins: [Double]? = a.count >= 9 ? [Double(a[5])!, Double(a[6])!, Double(a[7])!, Double(a[8])!] : nil
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let vw = Double(ProcessInfo.processInfo.environment["WKL_W"] ?? "") ?? 1200
let vh = Double(ProcessInfo.processInfo.environment["WKL_H"] ?? "") ?? 900
let rect = NSRect(x: 0, y: 0, width: vw, height: vh)
let window = NSWindow(contentRect: rect, styleMask: [.borderless], backing: .buffered, defer: false)
let webView = WebView(frame: rect)
window.contentView = webView
window.orderBack(nil)
final class Delegate: NSObject, WebFrameLoadDelegate {
    @objc func webView(_ sender: WebView!, didFinishLoadFor frame: WebFrame!) {
        guard frame === sender.mainFrame else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
            let info = NSPrintInfo(dictionary: [:])
            info.jobDisposition = .save
            info.dictionary()[NSPrintInfo.AttributeKey.jobSavingURL] = URL(fileURLWithPath: outPath)
            info.orientation = pw > ph ? .landscape : .portrait
            info.paperSize = NSSize(width: pw, height: ph)
            if let m = margins { info.leftMargin = m[0]; info.topMargin = m[1]; info.rightMargin = m[2]; info.bottomMargin = m[3] }
            print("paper: \(info.paperSize) margins L\(info.leftMargin) T\(info.topMargin) R\(info.rightMargin) B\(info.bottomMargin) imageable: \(info.imageablePageBounds)")
            guard let op = sender.mainFrame.frameView.printOperation(with: info) else { print("no print operation"); exit(1) }
            op.showsPrintPanel = false
            op.showsProgressPanel = false
            let ok = op.run()
            print("run: \(ok)")
            exit(ok ? 0 : 1)
        }
    }
}
let delegate = Delegate()
webView.frameLoadDelegate = delegate
webView.mainFrame.load(URLRequest(url: url))
DispatchQueue.main.asyncAfter(deadline: .now() + 50) { print("TIMEOUT"); exit(3) }
app.run()
