using System.Windows.Automation;

namespace Provian.ForegroundHelper;

/// <summary>
/// Reads the focused browser tab URL via UI Automation, the Windows
/// counterpart of the macOS AxBrowserUrl (Accessibility API). This is what
/// lets browser-based provider usage (claude.ai, chatgpt.com, gemini, grok,
/// perplexity in a tab) be matched by the catalog's browser_url_patterns,
/// exactly as on macOS.
///
/// No content is read - only the address-bar value of the focused window.
/// The TS layer treats the URL purely as a provider/session-boundary signal;
/// it is never persisted in the PE (the PE carries provider + fingerprint,
/// not the URL). See CAPTURE_ARCHITECTURE.md on content-free capture.
///
/// Best-effort: any failure returns null and the foreground match falls back
/// to process-name matching (which only catches native desktop apps).
/// </summary>
internal static class BrowserUrl
{
    // Process basenames (no .exe) for browsers whose address bar we read.
    private static readonly HashSet<string> BrowserProcessNames = new(StringComparer.OrdinalIgnoreCase)
    {
        "chrome",
        "msedge",
        "firefox",
        "brave",
        "opera",
        "vivaldi",
        "arc",
    };

    public static bool IsBrowser(string? processName)
        => processName is not null && BrowserProcessNames.Contains(processName);

    /// <summary>
    /// Extract the address-bar URL from the given top-level window handle.
    /// Returns null when the window is not a browser, UI Automation is
    /// unavailable, or no address-bar element is found.
    /// </summary>
    public static string? Extract(IntPtr hwnd)
    {
        if (hwnd == IntPtr.Zero) return null;

        try
        {
            AutomationElement? root = AutomationElement.FromHandle(hwnd);
            if (root is null) return null;

            // Chromium (Chrome/Edge/Brave/Opera/Vivaldi/Arc) and Firefox all
            // expose the address bar as an Edit control. Find the first Edit
            // descendant and read its ValuePattern. We scope the search to
            // Edit controls so we do not walk the entire (huge) document tree.
            var editCondition = new PropertyCondition(
                AutomationElement.ControlTypeProperty, ControlType.Edit);

            // TreeScope.Descendants can be slow on a full page; the address bar
            // is shallow (toolbar), so FindFirst returns quickly in practice.
            AutomationElement? edit = root.FindFirst(TreeScope.Descendants, editCondition);
            if (edit is null) return null;

            if (edit.TryGetCurrentPattern(ValuePattern.Pattern, out object? patternObj)
                && patternObj is ValuePattern valuePattern)
            {
                string raw = valuePattern.Current.Value;
                return Normalize(raw);
            }

            // Some Firefox builds expose the URL via the Name property of the
            // address bar element rather than a ValuePattern.
            string? name = edit.Current.Name;
            return Normalize(name);
        }
        catch
        {
            // UI Automation can throw ElementNotAvailableException and friends
            // when the window is mid-transition. Treat all as "no URL".
            return null;
        }
    }

    /// <summary>
    /// Address bars often omit the scheme ("claude.ai/chat/..."). The TS
    /// matcher parses with new URL(), which requires a scheme. Prepend https://
    /// when the value looks like a bare host/path and contains no scheme.
    /// </summary>
    private static string? Normalize(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        string v = value.Trim();

        if (v.Contains("://", StringComparison.Ordinal))
        {
            // Only forward http(s) URLs; ignore about:, chrome:, edge:, file:, etc.
            if (v.StartsWith("http://", StringComparison.OrdinalIgnoreCase)
                || v.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
            {
                return v;
            }
            return null;
        }

        // Bare value: reject obvious non-URLs (search terms with spaces).
        if (v.Contains(' ')) return null;
        if (!v.Contains('.')) return null; // needs at least a dotted host

        return "https://" + v;
    }
}
