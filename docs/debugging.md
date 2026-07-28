# Debugging

Time-travel, snapshots, and editing code while a session is live. Breakpoint kinds
(conditional, watchpoints, logpoints) are covered in the [feature tour](features.md).

---

## Time-Travel Debugging

The emulator keeps an in-memory **history ring** of recent machine states, so when you're stopped you can move *backwards* — and then *forwards again* toward where you were. Rewinding is **non-destructive** (a redo stack, not a consuming pop): it just moves a cursor over the recorded snapshots and reloads them, so you can freely scrub back and forth. Three toolbar buttons in *Oric Debug Controls* (and the floating debug toolbar) drive it:

- **⏪ Replay Rewind** — **Shift+F10** — load the previous snapshot (one step into the past).
- **⏩ Replay Forward** — **Shift+F12** — load the next snapshot (undo a rewind, toward the present).
- **⏭ Replay to Head** — jump straight to the most recent state. Use this to recover if you rewound too far (e.g. all the way back to program start) and want to get back to where you were in one click.

The recorded "future" is only discarded when you actually **execute forward** (step/continue) while parked in the past — that timeline has genuinely diverged, so replaying forward from that point is no longer possible. Until then, rewind and forward are fully reversible.

History is bounded to the recent past (it's a ring buffer, not a full recording), which is exactly what you want for "how did I *get* into this bad state?" — stop on the symptom, rewind to the cause, replay forward to watch it unfold again. For a durable point you can return to at any time, use a **Snapshot** instead.

---

## Snapshots

Save and restore the **entire machine state** (CPU, RAM, peripherals, and the current breakpoints) as a named snapshot, per project, under `.oric-snapshots/`.

- **Save** — **Oric: Save Snapshot** (or the snapshot button in *Oric Debug Controls*). Snapshots get a **self-describing auto-name** (you can rename them later).
- **Restore** — **Oric: Restore Snapshot**, or pick one from the **Snapshots & Automation** panel's *Snapshots* group → *Restore*. Restoring re-syncs breakpoints so the ones saved with the snapshot don't linger.
- **Restart to Most Recent** — **Oric: Restart to Most Recent Snapshot** jumps straight back to your latest restore point; combined with an **entry baseline** captured at launch, "restart the program" is near-instant (no rebuild/relaunch).
- **Rename / Delete** — from the *Snapshots* group of the **Snapshots & Automation** panel; **Oric: Delete Snapshot** / **Refresh Snapshots** are also on the palette.
- **Auto-snapshot on hit** — add **`[save]`** to a logpoint message to snapshot every time that line is reached (see [Logpoints](features.md#debug-adapter)), e.g. a save point at the start of each level.
- **Build-aware** — each snapshot records a checksum of the build it was taken against; if you rebuild, stale snapshots are flagged rather than restored into mismatched code.

Snapshots are the manual counterpart to *Time-Travel Debugging*: history is automatic-but-recent; snapshots are explicit-and-durable.

---

## Editing While Debugging

You can iterate on many things without losing your debug session. What takes effect when:

| You change… | How to apply | Session kept? |
|---|---|---|
| A `@…` comment annotation (`@enum`, `@word`, `@stream`, `@bool`, `@bcd`, …) | **Save the file** — auto-reparsed (or run **Reparse Annotations** / `reparse`) | Yes |
| Enum members, struct fields, types, new symbols (a build that leaves the binary **byte-identical**) | Rebuild, then **Reload Symbols** / `reloadsymbols` | Yes |
| Code that changes the binary, or inserting/moving source lines | Rebuild and **restart** the debug session | No — relaunch |

Reload Symbols is gated on a hash of the disk image taken at launch: if the rebuild changed the binary, it refuses (the emulator is still running the old one) and asks you to restart, so fresh symbols never silently mismatch stale code.

---

[← Documentation index](README.md) · [Extension README](../README.md)
