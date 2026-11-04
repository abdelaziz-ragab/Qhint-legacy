// Qhint accessibility helper (Windows).
//
// Reads an app's user-interface elements through Windows UI Automation: menu bar, open menus,
// windows and dialogs, with each element's role, name, label, value, state and on-screen frame.
// Same line protocol as the macOS helper (one JSON object per line on stdin / stdout):
//   {"id":1,"cmd":"status"}              -> {"id":1,"ok":true,"trusted":true}
//   {"id":2,"cmd":"frontmost"}           -> {"id":2,"ok":true,"pid":123,"name":"soffice.bin"}
//   {"id":3,"cmd":"elements","pid":123}  -> {"id":3,"ok":true,"elements":[...],"truncated":false,"units":"physical"}
// Frames are in physical screen pixels (the process is per-monitor DPI aware); Qhint converts
// them to Electron's DIP coordinates.
//
// Built with the C# compiler that ships with Windows (.NET Framework 4), no SDK needed.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Windows.Automation;

static class QhintAX
{
    const int MaxElements = 3000;
    const int MaxDepth = 40;
    const int MaxText = 160;

    // Containers of document content, not controls: don't read inside them (big and not needed).
    static readonly HashSet<string> SkipChildrenOf = new HashSet<string> {
        "Document", "List", "Tree", "Table", "DataGrid",
    };
    // Controls that never contain other controls we need: don't ask for their children
    // (each ask is a round trip to the app).
    static readonly HashSet<string> Leaves = new HashSet<string> {
        "Button", "CheckBox", "RadioButton", "Text", "Image", "Hyperlink", "Edit", "Separator",
        "ProgressBar", "Slider", "MenuItem", "MenuBarItem", "ScrollBar", "Thumb", "HeaderItem",
        "ListItem", "TreeItem", "DataItem", "ComboBox", "Spinner", "SplitButton", "TabItem",
    };
    // Roles whose value is the user's content: never read it.
    static readonly HashSet<string> ContentRoles = new HashSet<string> { "Document" };

    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    static readonly IntPtr PerMonitorAwareV2 = new IntPtr(-4);

    static readonly CacheRequest Cache = BuildCache();

    static CacheRequest BuildCache()
    {
        var cr = new CacheRequest();
        cr.TreeScope = TreeScope.Element | TreeScope.Children;
        cr.AutomationElementMode = AutomationElementMode.Full;
        foreach (var p in new AutomationProperty[] {
            AutomationElement.ControlTypeProperty, AutomationElement.NameProperty,
            AutomationElement.HelpTextProperty, AutomationElement.AutomationIdProperty,
            AutomationElement.BoundingRectangleProperty, AutomationElement.IsEnabledProperty,
            AutomationElement.HasKeyboardFocusProperty, AutomationElement.IsOffscreenProperty,
            AutomationElement.LabeledByProperty, AutomationElement.IsTogglePatternAvailableProperty,
            AutomationElement.IsValuePatternAvailableProperty, TogglePattern.ToggleStateProperty,
            ValuePattern.ValueProperty,
        }) cr.Add(p);
        return cr;
    }

    sealed class Walker
    {
        public readonly List<string> Out = new List<string>();
        public bool Truncated;

        // `c` already carries its cached properties (it came from its parent's children request).
        public void Walk(AutomationElement c, int depth, int window, string parentRole)
        {
            if (Out.Count >= MaxElements) { Truncated = true; return; }
            if (depth > MaxDepth) return;

            string role = RoleOf(c);
            // Menu bar items are MenuItems whose parent is the MenuBar (macOS calls them MenuBarItem).
            if (role == "MenuItem" && parentRole == "MenuBar") role = "MenuBarItem";

            var r = (System.Windows.Rect)Get(c, AutomationElement.BoundingRectangleProperty, System.Windows.Rect.Empty);
            bool offscreen = (bool)Get(c, AutomationElement.IsOffscreenProperty, false);
            string name = Clip(Get(c, AutomationElement.NameProperty, "") as string);

            if (!offscreen && !r.IsEmpty && r.Width >= 2 && r.Height >= 2 && (role != "Group" && role != "Pane" || name != null))
            {
                var sb = new StringBuilder("{");
                Str(sb, "role", role);
                if (name != null) Str(sb, "title", name);
                Str(sb, "description", Clip(Get(c, AutomationElement.HelpTextProperty, "") as string));
                Str(sb, "identifier", Clip(Get(c, AutomationElement.AutomationIdProperty, "") as string));
                var labelEl = Get(c, AutomationElement.LabeledByProperty, null) as AutomationElement;
                if (labelEl != null) { try { Str(sb, "label", Clip(labelEl.Current.Name)); } catch { } }
                string value = null;
                if ((bool)Get(c, AutomationElement.IsTogglePatternAvailableProperty, false))
                {
                    var t = Get(c, TogglePattern.ToggleStateProperty, null);
                    if (t is ToggleState) value = (ToggleState)t == ToggleState.On ? "1" : "0";
                }
                else if (!ContentRoles.Contains(role) && (bool)Get(c, AutomationElement.IsValuePatternAvailableProperty, false))
                {
                    value = Clip(Get(c, ValuePattern.ValueProperty, "") as string);
                }
                Str(sb, "value", value);
                Bool(sb, "enabled", (bool)Get(c, AutomationElement.IsEnabledProperty, true));
                if ((bool)Get(c, AutomationElement.HasKeyboardFocusProperty, false)) Bool(sb, "focused", true);
                Num(sb, "x", r.X); Num(sb, "y", r.Y); Num(sb, "w", r.Width); Num(sb, "h", r.Height);
                Num(sb, "depth", depth); Num(sb, "window", window);
                sb.Length--; // trailing comma
                sb.Append('}');
                Out.Add(sb.ToString());
            }

            if (SkipChildrenOf.Contains(role) || Leaves.Contains(role)) return;
            AutomationElementCollection kids;
            try { kids = c.GetUpdatedCache(Cache).CachedChildren; } catch { return; }
            foreach (AutomationElement k in kids) Walk(k, depth + 1, window, role);
        }
    }

    static object Get(AutomationElement c, AutomationProperty p, object fallback)
    {
        try
        {
            var v = c.GetCachedPropertyValue(p, true);
            return v == null || v == AutomationElement.NotSupported ? fallback : v;
        }
        catch { return fallback; }
    }

    static string RoleOf(AutomationElement c)
    {
        var ct = Get(c, AutomationElement.ControlTypeProperty, null) as ControlType;
        if (ct == null) return "Unknown";
        var n = ct.ProgrammaticName; // "ControlType.Button"
        int dot = n.LastIndexOf('.');
        return dot >= 0 ? n.Substring(dot + 1) : n;
    }

    static string Elements(int pid)
    {
        var w = new Walker();
        var windows = AutomationElement.RootElement.FindAll(
            TreeScope.Children, new PropertyCondition(AutomationElement.ProcessIdProperty, pid));
        // Top-level windows come front to back. Open menus are their own top-level windows.
        int index = 0;
        foreach (AutomationElement top in windows)
        {
            ControlType ct;
            try { ct = top.Current.ControlType; } catch { continue; }
            bool menu = ct == ControlType.Menu;
            AutomationElement cached;
            try { cached = top.GetUpdatedCache(Cache); } catch { continue; }
            w.Walk(cached, 0, menu ? -1 : index, "");
            if (!menu) index++;
        }
        return "\"elements\":[" + string.Join(",", w.Out) + "],\"truncated\":" + (w.Truncated ? "true" : "false") + ",\"units\":\"physical\"";
    }

    static string Frontmost()
    {
        uint pid;
        GetWindowThreadProcessId(GetForegroundWindow(), out pid);
        string name = "";
        try { name = Process.GetProcessById((int)pid).ProcessName; } catch { }
        var sb = new StringBuilder();
        Num(sb, "pid", pid);
        Str(sb, "name", name);
        sb.Length--;
        return sb.ToString();
    }

    // ------------------------------------------------------------------ tiny JSON helpers

    static string Clip(string s)
    {
        if (string.IsNullOrEmpty(s)) return null;
        return s.Length > MaxText ? s.Substring(0, MaxText) : s;
    }

    static void Str(StringBuilder sb, string key, string v)
    {
        if (v == null) return;
        sb.Append('"').Append(key).Append("\":\"");
        foreach (char ch in v)
        {
            switch (ch)
            {
                case '"': sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default:
                    if (ch < 0x20) sb.Append("\\u").Append(((int)ch).ToString("x4"));
                    else sb.Append(ch);
                    break;
            }
        }
        sb.Append("\",");
    }

    static void Num(StringBuilder sb, string key, double v)
    {
        if (double.IsNaN(v) || double.IsInfinity(v)) v = 0;
        sb.Append('"').Append(key).Append("\":").Append(v.ToString("0.##", CultureInfo.InvariantCulture)).Append(',');
    }

    static void Bool(StringBuilder sb, string key, bool v)
    {
        sb.Append('"').Append(key).Append("\":").Append(v ? "true" : "false").Append(',');
    }

    static readonly Regex IdRx = new Regex("\"id\"\\s*:\\s*(\\d+)");
    static readonly Regex CmdRx = new Regex("\"cmd\"\\s*:\\s*\"([a-z]+)\"");
    static readonly Regex PidRx = new Regex("\"pid\"\\s*:\\s*(\\d+)");

    [STAThread]
    static void Main()
    {
        try { SetProcessDpiAwarenessContext(PerMonitorAwareV2); } catch { }
        Console.OutputEncoding = new UTF8Encoding(false);
        var stdout = Console.Out;
        string line;
        while ((line = Console.In.ReadLine()) != null)
        {
            var id = IdRx.Match(line);
            var cmd = CmdRx.Match(line);
            if (!id.Success || !cmd.Success) continue;
            string head = "{\"id\":" + id.Groups[1].Value + ",";
            string body;
            try
            {
                switch (cmd.Groups[1].Value)
                {
                    case "status": body = "\"ok\":true,\"trusted\":true"; break;
                    case "frontmost": body = "\"ok\":true," + Frontmost(); break;
                    case "elements":
                        var pid = PidRx.Match(line);
                        int p;
                        body = pid.Success && int.TryParse(pid.Groups[1].Value, out p) && p > 0
                            ? "\"ok\":true," + Elements(p)
                            : "\"ok\":false,\"error\":\"bad_pid\"";
                        break;
                    default: body = "\"ok\":false,\"error\":\"unknown_command\""; break;
                }
            }
            catch (Exception)
            {
                body = "\"ok\":false,\"error\":\"failed\"";
            }
            stdout.WriteLine(head + body + "}");
            stdout.Flush();
        }
    }
}
