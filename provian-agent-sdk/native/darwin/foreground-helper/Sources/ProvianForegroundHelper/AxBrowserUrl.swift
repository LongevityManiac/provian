import Foundation
import AppKit
import ApplicationServices

/// Per-browser AX-based URL extraction for the five launch browsers.
///
/// AX query paths for browser URL fields are brittle and vendor-specific.
/// This module encodes the current known-good paths as of 2026-04; each
/// browser's extractor documents the assumption being relied on. If a
/// browser restructures its AX tree, the extractor falls back to a
/// plausibility-based match that looks for any AXTextField whose value
/// resembles a URL.
///
/// Known limitation for 4.3: tab switches within the same browser app
/// are NOT detected. URL extraction happens on foreground_changed (app
/// activation) only. If a user switches tabs inside Chrome from Claude
/// to ChatGPT without switching away from Chrome, the state machine
/// will see both as one session. A follow-up sub-step can add tab-change
/// detection via AXObserver on AXTitleChangedNotification if needed.
///
/// Relies on the helper process having Accessibility trust. If the AX
/// calls fail due to missing trust, extract() returns nil and the plugin
/// emits foreground_changed with browser_url: null.
enum AxBrowserUrl {

    /// Bundle IDs that trigger a URL extraction attempt.
    static let supportedBundleIds: Set<String> = [
        "com.apple.Safari",
        "com.google.Chrome",
        "com.microsoft.Edge",
        "com.microsoft.edgemac",
        "org.mozilla.firefox",
        "company.thebrowser.Browser"
    ]

    static func isBrowser(bundleId: String?) -> Bool {
        guard let bid = bundleId else { return false }
        return supportedBundleIds.contains(bid)
    }

    /// Extract URL from the frontmost window of the given running app.
    /// Returns nil when: the app is not a supported browser, the helper
    /// lacks Accessibility trust, the browser exposes no focused window,
    /// or the URL field cannot be located / its value is not a plausible
    /// URL.
    static func extract(for app: NSRunningApplication) -> String? {
        let pid = app.processIdentifier
        guard pid > 0 else { return nil }
        guard let bundleId = app.bundleIdentifier else { return nil }

        let appRef = AXUIElementCreateApplication(pid)

        var focusedWindowValue: AnyObject?
        let windowErr = AXUIElementCopyAttributeValue(
            appRef, kAXFocusedWindowAttribute as CFString, &focusedWindowValue
        )
        guard windowErr == .success, let rawWindow = focusedWindowValue else { return nil }
        let window = rawWindow as! AXUIElement

        let raw: String?
        switch bundleId {
        case "com.apple.Safari":
            raw = extractSafari(from: window)
        case "com.google.Chrome",
             "com.microsoft.Edge", "com.microsoft.edgemac",
             "company.thebrowser.Browser":
            raw = extractChromium(from: window)
        case "org.mozilla.firefox":
            raw = extractFirefox(from: window)
        default:
            raw = nil
        }

        return raw.flatMap(normalize)
    }

    // MARK: - Per-browser extractors

    /// Safari's URL field is an AXTextField under the window's toolbar.
    /// In modern Safari (17+) the AXIdentifier contains "ADDRESS" or
    /// "URL"; older versions may not set an identifier at all. Fallback
    /// is the first AXTextField whose value looks like a URL.
    private static func extractSafari(from window: AXUIElement) -> String? {
        let fields = allTextFields(in: window)
        for field in fields {
            if let id = attrString(field, kAXIdentifierAttribute as String),
               id.uppercased().contains("ADDRESS") || id.uppercased().contains("URL") {
                if let v = attrString(field, kAXValueAttribute as String) { return v }
            }
        }
        return fields.firstMatching(where: { v in isPlausibleUrl(v) })
    }

    /// Chromium-family (Chrome, Edge, Arc, Brave) expose the omnibox as
    /// an AXTextField with AXDescription containing "Address" (localized
    /// versions vary). AXIdentifier is not reliable across versions.
    /// Fallback is the first AXTextField whose value looks like a URL.
    private static func extractChromium(from window: AXUIElement) -> String? {
        let fields = allTextFields(in: window)
        for field in fields {
            if let desc = attrString(field, kAXDescriptionAttribute as String) {
                let lowered = desc.lowercased()
                if lowered.contains("address") || lowered.contains("url") || lowered.contains("omnibox") {
                    if let v = attrString(field, kAXValueAttribute as String) { return v }
                }
            }
        }
        return fields.firstMatching(where: { v in isPlausibleUrl(v) })
    }

    /// Firefox exposes the URL bar with AXIdentifier "urlbar-input" on
    /// current versions. No plausibility fallback: Firefox often has
    /// other AXTextField elements (search bar, find-in-page, etc.) whose
    /// values could look URL-ish, so we require the identifier.
    private static func extractFirefox(from window: AXUIElement) -> String? {
        let fields = allTextFields(in: window)
        for field in fields {
            if let id = attrString(field, kAXIdentifierAttribute as String),
               id.lowercased().contains("urlbar") {
                return attrString(field, kAXValueAttribute as String)
            }
        }
        return nil
    }

    // MARK: - AX tree walk

    private static func allTextFields(
        in element: AXUIElement,
        depth: Int = 0,
        maxDepth: Int = 12
    ) -> [AXUIElement] {
        guard depth < maxDepth else { return [] }
        var result: [AXUIElement] = []

        if let role = attrString(element, kAXRoleAttribute as String), role == "AXTextField" {
            result.append(element)
        }

        if let children = attrChildren(element) {
            for child in children {
                result.append(
                    contentsOf: allTextFields(in: child, depth: depth + 1, maxDepth: maxDepth)
                )
            }
        }
        return result
    }

    private static func attrString(_ element: AXUIElement, _ attr: String) -> String? {
        var value: AnyObject?
        let err = AXUIElementCopyAttributeValue(element, attr as CFString, &value)
        guard err == .success else { return nil }
        return value as? String
    }

    private static func attrChildren(_ element: AXUIElement) -> [AXUIElement]? {
        var value: AnyObject?
        let err = AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &value)
        guard err == .success else { return nil }
        return value as? [AXUIElement]
    }

    // MARK: - URL plausibility and normalization

    /// A string looks like a URL for our purposes if it: is non-empty
    /// after trimming, has no spaces, contains at least one dot, is at
    /// least 4 chars long. Deliberately permissive since Chromium's
    /// omnibox often shows a display form without the scheme
    /// ("claude.ai/chat/xyz") and we want to match it.
    static func isPlausibleUrl(_ raw: String) -> Bool {
        let trimmed = raw.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty { return false }
        if trimmed.contains(" ") { return false }
        if !trimmed.contains(".") { return false }
        if trimmed.count < 4 { return false }
        return true
    }

    /// Normalize a raw URL field value. Trim whitespace, reject if
    /// implausible, prepend "https://" if no scheme present so the TS
    /// bridge's `new URL(...)` parser accepts it.
    static func normalize(_ raw: String) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespaces)
        guard isPlausibleUrl(trimmed) else { return nil }
        if trimmed.hasPrefix("http://") || trimmed.hasPrefix("https://") {
            return trimmed
        }
        return "https://" + trimmed
    }
}

private extension Array where Element == AXUIElement {
    /// Returns the AXValue of the first text field matching a predicate.
    func firstMatching(where pred: (String) -> Bool) -> String? {
        for field in self {
            var value: AnyObject?
            let err = AXUIElementCopyAttributeValue(field, kAXValueAttribute as CFString, &value)
            guard err == .success, let str = value as? String else { continue }
            if pred(str) {
                return str
            }
        }
        return nil
    }
}
