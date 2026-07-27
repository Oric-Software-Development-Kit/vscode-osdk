# OSDK Debugging — Getting Started & Troubleshooting

New here? Start with **Getting Started** below. Already set up and something's not
working? Jump to **Troubleshooting**.

---

# Getting Started

Debugging an Oric program needs three pieces: the **OSDK toolchain**, this
**extension** (you have it), and a **project set up** with the VS Code files.

### 1. Install the OSDK
Download the OSDK and unzip it somewhere permanent (e.g. `C:\OSDK`).
- Home page & downloads: <https://osdk.org>
- Source & releases: <https://github.com/Oric-Software-Development-Kit>

The OSDK folder should contain `bin\`, `lib\`, `Oricutron\`, and — in recent
versions — a `version.txt`. This extension requires a recent OSDK (see the version
in any "OSDK too old" message).

### 2. Point `%OSDK%` at it
Set the `OSDK` environment variable to that folder, then **restart VS Code** so it
picks up the change (VS Code reads the environment at launch).
- Windows: *Settings → System → About → Advanced system settings → Environment
  Variables*, add a variable `OSDK` = the OSDK folder path.
- Verify from a terminal: `echo %OSDK%` should print the path.

### 3. Open your project (or a sample)
Open your OSDK project folder in VS Code. To try a sample first, open one under
`%OSDK%\sample\c\` (for example `paint`).

### 4. Create the VS Code files
A fresh OSDK project ships **without** `.vscode` files, so there's nothing to run
yet. Create them:

> **Run & Debug panel → “Set Up Oric Debugging”**, or
> **Command Palette → “Oric: Set Up Project for Debugging”**

This writes `.vscode/launch.json`, `.vscode/tasks.json` and `.vscode/settings.json`
(it never overwrites an existing file without asking). Review `launch.json` and
adjust anything that differs for your project — build command, symbol file, emulator
machine, GDB port.

### 5. Build & debug
Press **F5**. The project builds, Oricutron launches, and you can set breakpoints,
step through C and assembly, inspect registers/memory, and use the Oric debug panels.

That's the happy path. If something along the way didn't work, read on.

---

# Troubleshooting

## "Your OSDK is too old" / "OSDK incompatible" (red status-bar item)

This extension requires a recent OSDK. It reads the version from a `version.txt`
file at the root of your OSDK (`%OSDK%\version.txt`, `major.minor`, e.g. `2.0`).

**Why you might see it:**
- Your OSDK predates the version system (no `version.txt`) → treated as too old.
- Your `version.txt` reports a version older than the extension requires.

**How to fix:**
1. Update your OSDK to the required version or newer (see *Getting Started → 1*).
2. Make sure `OSDK` points at that OSDK (see *Getting Started → 2*).
3. **Restart VS Code** after changing the environment variable.

While the OSDK is incompatible, the Oric debug panels are hidden and debugging is
blocked on purpose — the required toolchain features aren't present. The **Oric
Documentation** panel stays available so you can reach this page.

## "The OSDK environment variable is not set"

The `OSDK` variable tells the extension (and the build scripts) where the SDK lives.
Set it and restart VS Code — see *Getting Started → 2*.

## Pressing F5 does nothing / "no oric-debug configuration found"

Your project has no `.vscode` files yet — run **“Oric: Set Up Project for
Debugging”** (*Getting Started → 4*), then press **F5**.

## Breakpoints in C source don't bind / "no C source-line info"

The OSDK C compiler only emits source-line and local-variable debug info when asked. In
your `osdk_config.bat`:

```bat
SET OSDKDEBUG=-g1
```

`-g1` is **new in OSDK 2.0** (there was no C debug info before it), and it lives in its own
`OSDKDEBUG` variable rather than `OSDKCOMP` — so a project setting its own optimization flags
cannot silently drop the debug info. Set `OSDKDEBUG` and leave `OSDKCOMP` alone. This
extension requires OSDK 2.0 or newer, so `OSDKDEBUG` is always the right place.

Optimization level still matters for *quality*: `-O2`/`-O3` reorder and register-allocate
aggressively, so some lines/locals have no stable home — `-O1` keeps them closest to the
source. Rebuild after changing either. (Assembly `.s` breakpoints work regardless.)

## A breakpoint says it's armed but didn't fire

**First: try again.** There is a known issue where an armed breakpoint is *occasionally* missed —
the same breakpoint on the same line fires most times and is skipped now and then (no pattern
identified yet; under investigation). A miss on one run does not mean the breakpoint or the line
is wrong, so re-run before changing anything.

If it *never* fires across several runs, the line itself is the suspect:
- At `-O2`, a `return expr;` or a closing brace may map into merged/elided code. Move the
  breakpoint to the **last real statement** before it (an assignment, a call) — a statement is
  always the more reliable target.
- To catch a function on the way out, use **Step Out** from inside it.
- Building that translation unit at `-O1` keeps line records closer to the source.

(A breakpoint reporting **NOT BOUND** is a different case entirely — a blank line, comment,
declaration, or a `.c` file built without `-g1`; the message says which.)

## The build fails in the terminal

- OSDK builds are Windows batch scripts. If the integrated terminal is PowerShell and
  a `.bat` misbehaves, set the default profile to **Command Prompt**
  (the Set Up Project command merges this into your workspace `settings.json` for you).
- Run `osdk_build.bat` directly in a terminal to see the full error.
- A too-old OSDK is rejected up front by `osdk_build.bat` (it needs the version-check
  helper `%OSDK%\bin\checkversion.bat`, added in newer OSDKs).

## Wrong labels / disassembly doesn't match the code

Usually a **stale machine-state snapshot** restored across a rebuild (old code, new
symbols). Reboot the program fresh instead of restoring an old snapshot. The extension
also warns ("⚠ Symbols may not match the loaded binary…") when the live opcode at the
PC disagrees with the mapped source line.

## Where do the symbols come from?

The build emits an extended symbol file under `build/` (`symbols_ext`, or
`symbols_ext_combined` for multi-module projects). `launch.json`'s `symbolFile` points
at it. If symbols look missing, confirm that file exists after a build and that
`symbolFile` matches its path.

---

Still stuck? See the **Extension manual** in the *Oric Documentation* panel, or ask on
the [Defence Force forum](https://forum.defence-force.org).
