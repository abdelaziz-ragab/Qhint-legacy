# Desktop manual tests

## Phase 1: overlay accuracy

Run `pnpm dev:desktop`, then either click **Debug: capture + draw rings** in the Qhint window or
use the tray menu. On every display you should see:

- a **dashed blue rectangle tracing the display's edges** (just inside them)
- an **amber ring around the centre half** of the display, with a white card next to it (not on it)
- a **small dashed box near the top-left corner**

A dialog summarises the run and **Open report** shows the captures with the same boxes drawn on
them. The report is written to the app data folder under `debug-captures/` and never uploaded.

### What to check

| #   | Check             | Pass when                                                            |
| --- | ----------------- | -------------------------------------------------------------------- |
| 1   | Edge rectangle    | Traces all four edges of every display, no gap or overflow           |
| 2   | Centre ring       | Centred; corners at 25% / 75% of the display width and height        |
| 3   | Card              | Fully on screen, beside the ring, never covering it                  |
| 4   | Report boxes      | Boxes in the "before" image match where the rings appeared on screen |
| 5   | Capture exclusion | "with guard" reads `clean` for every display                         |
| 6   | Overlay bounds    | Summary says "bounds match every display"                            |
| 7   | Click-through     | You can click and type in apps under the rings                       |
| 8   | Full screen       | Rings stay visible over a full-screen app (macOS: full-screen space) |
| 9   | Display change    | Change scaling or unplug a monitor, then rerun: still correct        |
| 10  | Hotkey            | Mac `⌃⇧Space`, Windows `Ctrl+Alt+Space` toggles the Qhint window     |

"without hiding" tells us whether the OS alone keeps our windows out of captures. Expected:
`clean` on Windows 10 2004+ / 11; may read `VISIBLE` on recent macOS (the guard handles it).

### Matrix

| OS         | Displays            | Scaling                                | Result |
| ---------- | ------------------- | -------------------------------------- | ------ |
| macOS      | built-in            | default (Retina)                       |        |
| macOS      | built-in + external | mixed                                  |        |
| Windows 11 | 1                   | 100%                                   |        |
| Windows 11 | 1                   | 150%                                   |        |
| Windows 11 | 2                   | 100% + 150% (mixed)                    |        |
| Windows 11 | 2                   | secondary left of primary (negative x) |        |

Windows VM tips: in Parallels/UTM, add a second display in the VM settings. Over RDP to the GCP
VM, use `mstsc /multimon` (or "Use all my monitors") to get two displays, and change scaling in
Settings → System → Display. On a Mac-hosted VM, macOS may intercept `Ctrl+Alt(Option)+Space`;
use the tray menu or the button instead.

### macOS permission

The first capture asks for **Screen Recording** permission. In development the permission is
attributed to the app that launched Qhint (e.g. Terminal), so grant it to your terminal and
restart it.
