// Qhint accessibility helper (macOS).
//
// Reads an app's user-interface elements through the macOS Accessibility API: menu bar, open
// menus, windows and dialogs, with each element's role, name, label, value, state and exact
// on-screen frame. Qhint uses this to find "the Table menu" or "the Columns field" in
// milliseconds, without screenshots.
//
// Protocol: one JSON object per line on stdin (requests) and stdout (responses).
//   {"id":1,"cmd":"status"}                 -> {"id":1,"ok":true,"trusted":true}
//   {"id":2,"cmd":"frontmost"}              -> {"id":2,"ok":true,"pid":123,"name":"LibreOffice"}
//   {"id":3,"cmd":"elements","pid":123}     -> {"id":3,"ok":true,"elements":[...],"truncated":false}
// Coordinates are global, in points, top-left origin of the primary display (same as Electron).

import AppKit
import ApplicationServices
import Foundation

let maxElements = 3000
let maxDepth = 40
let maxText = 160

// Roles that hold document content: never read their value (it's the user's text, not UI state).
let contentRoles: Set<String> = ["AXTextArea", "AXWebArea", "AXScrollArea", "AXStaticText"]

// Roles whose contents are document text, not controls: skip their children (big and not needed).
let skipChildrenOf: Set<String> = ["AXTextArea", "AXWebArea", "AXTable", "AXOutline", "AXList", "AXBrowser"]

let attributeNames: [String] = [
  kAXRoleAttribute, kAXSubroleAttribute, kAXTitleAttribute, kAXDescriptionAttribute,
  kAXValueAttribute, kAXPositionAttribute, kAXSizeAttribute, kAXEnabledAttribute,
  kAXFocusedAttribute, kAXIdentifierAttribute, kAXTitleUIElementAttribute, kAXChildrenAttribute,
  kAXHelpAttribute,
]

func clip(_ s: String) -> String { s.count > maxText ? String(s.prefix(maxText)) : s }

func stringValue(_ v: AnyObject?) -> String? {
  guard let v = v else { return nil }
  if let s = v as? String { return s.isEmpty ? nil : clip(s) }
  if let n = v as? NSNumber { return n.stringValue }
  return nil
}

func point(_ v: AnyObject?) -> CGPoint? {
  guard let v = v, CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
  var out = CGPoint.zero
  return AXValueGetValue(v as! AXValue, .cgPoint, &out) ? out : nil
}

func size(_ v: AnyObject?) -> CGSize? {
  guard let v = v, CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
  var out = CGSize.zero
  return AXValueGetValue(v as! AXValue, .cgSize, &out) ? out : nil
}

/// Screens in Accessibility coordinates (top-left origin of the primary screen).
func screenRects() -> [CGRect] {
  guard let primary = NSScreen.screens.first else { return [] }
  let h = primary.frame.height
  return NSScreen.screens.map { s in
    CGRect(x: s.frame.minX, y: h - s.frame.maxY, width: s.frame.width, height: s.frame.height)
  }
}

final class Walker {
  var out: [[String: Any]] = []
  var truncated = false
  let screens = screenRects()

  func visible(_ r: CGRect) -> Bool {
    r.width >= 2 && r.height >= 2 && screens.contains { $0.intersects(r) }
  }

  func walk(_ el: AXUIElement, depth: Int, window: Int) {
    if out.count >= maxElements { truncated = true; return }
    if depth > maxDepth { return }

    var values: CFArray?
    let err = AXUIElementCopyMultipleAttributeValues(el, attributeNames as CFArray, AXCopyMultipleAttributeOptions(rawValue: 0), &values)
    guard err == .success, let arr = values as? [AnyObject], arr.count == attributeNames.count else { return }
    func at(_ i: Int) -> AnyObject? {
      let v = arr[i]
      // Missing attributes come back as AXError values; treat them as absent.
      if CFGetTypeID(v) == AXValueGetTypeID(), AXValueGetType(v as! AXValue) == .axError { return nil }
      return v
    }

    let role = stringValue(at(0)) ?? ""
    let pos = point(at(5))
    let sz = size(at(6))
    let frame = (pos != nil && sz != nil) ? CGRect(origin: pos!, size: sz!) : nil

    if let f = frame, visible(f), role != "AXGroup" || stringValue(at(2)) != nil {
      var e: [String: Any] = [
        "role": role,
        "x": Double(f.minX), "y": Double(f.minY), "w": Double(f.width), "h": Double(f.height),
        "depth": depth, "window": window,
      ]
      if let v = stringValue(at(1)) { e["subrole"] = v }
      if let v = stringValue(at(2)) { e["title"] = v }
      if let v = stringValue(at(3)) { e["description"] = v }
      // Keep values only where they are UI state (checkbox ticks, short field values) or the
      // static label text next to a field; skip big text areas (document contents).
      let bigText = contentRoles.contains(role) && role != "AXStaticText" && (f.height > 60 || f.width > 600)
      if !bigText, let v = stringValue(at(4)) { e["value"] = v }
      if let v = at(7) as? Bool { e["enabled"] = v }
      if let v = at(8) as? Bool, v { e["focused"] = true }
      if let v = stringValue(at(9)) { e["identifier"] = v }
      if let v = stringValue(at(12)) { e["help"] = v }
      if let labelEl = at(10), CFGetTypeID(labelEl) == AXUIElementGetTypeID() {
        var t: CFTypeRef?
        if AXUIElementCopyAttributeValue(labelEl as! AXUIElement, kAXValueAttribute as CFString, &t) == .success,
           let s = stringValue(t) { e["label"] = s }
        else if AXUIElementCopyAttributeValue(labelEl as! AXUIElement, kAXTitleAttribute as CFString, &t) == .success,
                let s = stringValue(t) { e["label"] = s }
      }
      out.append(e)
    }

    if skipChildrenOf.contains(role) { return }
    if let kids = at(11) as? [AXUIElement] {
      for k in kids { walk(k, depth: depth + 1, window: window) }
    }
  }
}

func elements(pid: pid_t) -> [String: Any] {
  let app = AXUIElementCreateApplication(pid)
  AXUIElementSetMessagingTimeout(app, 0.3)
  let w = Walker()
  // Menu bar (and any open menu under it) first, then windows front to back.
  var bar: CFTypeRef?
  if AXUIElementCopyAttributeValue(app, kAXMenuBarAttribute as CFString, &bar) == .success, let b = bar {
    w.walk(b as! AXUIElement, depth: 0, window: -1)
  }
  var wins: CFTypeRef?
  if AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &wins) == .success,
     let list = wins as? [AXUIElement] {
    for (i, win) in list.enumerated() { w.walk(win, depth: 0, window: i) }
  }
  return ["elements": w.out, "truncated": w.truncated]
}

func respond(_ obj: [String: Any]) {
  if let data = try? JSONSerialization.data(withJSONObject: obj), let line = String(data: data, encoding: .utf8) {
    FileHandle.standardOutput.write((line + "\n").data(using: .utf8)!)
  }
}

setvbuf(stdout, nil, _IONBF, 0)
while let line = readLine() {
  guard let data = line.data(using: .utf8),
        let req = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
        let id = req["id"] as? Int, let cmd = req["cmd"] as? String else { continue }
  switch cmd {
  case "status":
    respond(["id": id, "ok": true, "trusted": AXIsProcessTrusted()])
  case "frontmost":
    let app = NSWorkspace.shared.frontmostApplication
    respond(["id": id, "ok": true, "pid": Int(app?.processIdentifier ?? 0), "name": app?.localizedName ?? ""])
  case "elements":
    guard AXIsProcessTrusted() else { respond(["id": id, "ok": false, "error": "not_trusted"]); continue }
    guard let pid = req["pid"] as? Int, pid > 0 else { respond(["id": id, "ok": false, "error": "bad_pid"]); continue }
    var r = elements(pid: pid_t(pid))
    r["id"] = id
    r["ok"] = true
    respond(r)
  default:
    respond(["id": id, "ok": false, "error": "unknown_command"])
  }
}
