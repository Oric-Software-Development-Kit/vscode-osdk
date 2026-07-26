# Nova dogfooding — debug experience issues

Running log of things that don't work as expected while actually debugging Nova
(and later Encounter) with the osdk-debug extension. Newest entries at the top.
Status: **Open** (not yet fixed) / **Fixed** (with commit) / **Won't fix** (with reason).

---

# ► STATUS — extension 0.0.71, committed `7be0c5a` (local, unpushed)

**No pending test pass, and nothing Open.** Six dogfooding sessions (a)–(g) closed #2–#26:
**23 fixed, 1 documented-only (#23's guidance), 0 open.** #23 is Fixed-via-#26 and kept under
*monitoring* — reopen it if an armed breakpoint is ever missed again, with the arm/disarm sequence for
the address.

**If you file something new,** add it at the top with a `— Open` status and, where relevant, a
"► NEXT TEST PASS" brief; the author works from those. Two standing prerequisites for any pass:
**Reload Window** loads the extension host, and an `mcp/` change needs the **MCP server respawned**
(it runs in the Claude Code process, not the extension host) — verify the version **behaviourally**
(does the new tool/message exist?) and cross-check the adapter's build banner.

---


# Session 2026-07-26 (g) — validation pass against 0.0.71 (commit 7be0c5a)

**#25 and #26 both confirmed fixed. #23 produced 0 misses in 21 observations — I think #26's
ref-count fix probably fixed it too, and the two were one bug.** Details and the caveat below.

Both sides verified before testing, and this time it mattered: banner `Oric Debug v0.0.71 · adapter
17:24 · extension 15:29`, and `bytes: [3, 3]` — which fails on 0.0.70 — was accepted, so the MCP
client had genuinely respawned (Mike restarted VS Code entirely). No stale-client ambiguity.
Sanity note on the mtimes: `extension.js` is unchanged at 15:29 UTC, so #25/#26 landed in
`debug_adapter.js` (17:24) and `mcp/oric-mcp-server.cjs` (17:25), which is where they should be.

## ✅ #26 — ref-count drift: FIXED, 5/5 plus the re-set variant

Ran the brief's cycle five times. Each iteration kept 490 armed **deliberately**, so that
`run_frames` stopping at 490 proves execution crossed all 50 iterations of line 476 without
stopping — a stronger negative than merely exhausting the frame budget.

```
set 476 → gIntroPage=3 → continue → hit 476 → clear → list (gone) → run_frames 600 → stops at 490
```

Runs 1, 2, 4, 5 passed. Run 3 was the re-set variant (`set → hit → clear → re-set → hit → clear`)
and also passed — the re-set path does not stack refs either. **Zero reappearances in 5 cycles**,
against one reappearance in a handful of cycles in session (f).

## ✅ #25 — array form: FIXED

```
bytes: [3, 3] + count: 2   → Wrote 2 byte(s) at $BFE2: 03 03  — verified
bytes: "03 03"             → Wrote 2 byte(s) at $BFE2: 03 03  — verified
bytes: "oops"              → ERROR: must be an even-length hex string or an array of byte values
```

Read-back after the bad form confirmed **no write occurred** (`$bfe2: 03 03 00 …`). I could not test
the literal `"[oops]"` from the brief — the bracketed string kept failing my own client's JSON
encoder before reaching the server, which is a client artefact, not a server behaviour.

**One correction to my session (f) report:** I gave the cause as "`bytes` declares no `type` in the
schema, so arrays arrive stringified". That was wrong — the 0.0.70 schema already declared
`"type": ["string", "array"]`. The bug was in the server's decoder, not the transport. The fix
works; my explanation of it did not. (I have corrected the #25 entry itself too.)

## #23 — 0 misses in 21 observations; probably the same bug as #26

| condition | 476 | 490 |
|---|---|---|
| short run (`run_frames`, ~6 frames) | — | 5 hits |
| long run (`run_frames`, ~320 frames) | 1 hit | 6 hits |
| long run (`continue`) | 6 hits | 2 hits |
| warp **off** (`run_frames` and `continue`) | — | 2 hits |
| **totals** | **7 / 7** | **14 / 14** |

**21 hits, 0 misses**, against 2 misses in 7 in session (f). My reading: **#26's ref-count drift was
most likely the cause of #23 as well.** One drifting count produces both symptoms — a cleared
breakpoint that still fires (count stuck above zero) and an armed one that doesn't (count
prematurely at zero while the panel still says armed). That also explains why #23 was intermittent
and why it only bit me in sessions where I had been setting and clearing repeatedly.

**Two caveats, so this is not over-read:**

1. **Identical repeats are not independent samples.** The deterministic cycle returned *"Ran 320
   frames"* to the frame every single time — the emulated side is fully deterministic, so running it
   20 times re-runs one path. That is why I varied the conditions instead: `continue` vs
   `run_frames`, short vs long runs, one breakpoint armed vs two, and **warp off**, which materially
   changes the host/emulator timing relationship and is the best probe I have for a host-side race.
   The 0-miss rate holds across all of them.
2. **This cannot be a controlled comparison.** Session (f)'s misses happened under a build that also
   had the #26 drift, so I can't re-run the old condition. "Fixed by #26" is the best-supported
   explanation, not a proven one.

**Recommendation:** downgrade #23 from Open to *"probably fixed by #26; watch for recurrence"*,
rather than closing it outright. If it ever returns, the fact that it survived a ref-count fix would
itself be the strongest clue available.

## Near-misses worth recording (both were my error, not the tool's)

Twice this pass something looked like a bug and wasn't, and in both cases only verification caught it:

- **884 frames from page 2 with both breakpoints armed and no stop** looked exactly like a miss.
  `gIntroPage` was still 3 with "How to play (2/2)" on screen — the intro pages wait far longer than
  the 250-frame `WaitAndFade`, so execution had simply never reached line 476. Not stopping was
  correct.
- In session (f) I nearly filed a stale-status bug that was `oric_press` legitimately leaving the
  machine halted.

Method note for whoever runs session (h): `oric_status` and `oric_screenshot` are free and
non-intrusive — check `gIntroPage` and the screen **before** calling anything a miss. A miss claim
needs proof the code reached the line, not just proof that nothing stopped.

## Housekeeping

Panel restored to Mike's two entries (476, 490, both unconditional, armed), warp off, control
released. `gAchievements` is left at `03 03 00 00 00 00 00` from the #25 writes — a fresh boot, and
the game rewrites it, but that is why the achievements screen currently shows a few unlocked.

---

# □ Brief for session (g) — extension 0.0.71 — ✅ EXECUTED (see session (g) above)

**#25 and #26 are fixed, #23's documentation is corrected (cause still unknown and #23 stays OPEN).**
Startup: **Reload Window** (0.0.71) + **restart the MCP server** (both `mcp/` and adapter changed).

**Priority 1 — #26, the ref-count fix.** This is the one that needs repetition, since it was
intermittent for you. Run the cycle **at least 5 times** in one session:
```
set 476 → continue (hit) → clear {file, line} → list  (must be gone)
        → run_frames 600  (must NOT stop at 476)
```
Any single reappearance means the ref-count still drifts somewhere else. Also worth one pass of:
set → hit → clear → **re-set** → hit → clear, to check the re-set path doesn't stack refs either.

**Priority 2 — #23, now an explicit hunt (no fix, just measurement).** The useful artefact is a
*rate*, not another anecdote: pick one line that fires reliably (476), then loop
set → continue → record hit/miss → clear, ~15–20 iterations, and report the count. If #26's fix also
removed the misses, the rate should be 0 — that would link the two. If misses persist, note for each
whether it was `continue` or `run_frames`, and whether a module switch or a watchpoint was armed at
the time. That is what makes the next investigation tractable.

**Priority 3 — #25.** `bytes: [3, 3]` with `count: 2` must now work, as must `bytes: "03 03"` and a
deliberately bad `bytes: "[oops]"` (clear error, no write).

**Also:** the ROM-write mismatch path is still untested — per your note Encounter banks RAM over
`$C000+`, so if you want to exercise it pick a genuinely unmapped/ROM-visible target on another
project rather than forcing it here.

**Housekeeping from session (f):** you clobbered one byte at `$E000` without reading it first. That is
overlay space reloaded per module, so a session restart clears it — Mike, restart the session before
real work. (A read-before-write that reports the previous bytes would make writes reversible; noted as
a possible ergonomic addition, not filed as a defect.)

---

# □ Brief for session (f) — extension 0.0.70 — ✅ EXECUTED (see session (f) above)

**#20, #21, #22 and #24 are fixed, #23 is documented; zero Open entries remain.** One pass, then
this batch is ready to commit.

**#24 (saved breakpoints dead on arrival) — please test this too, it affects Mike directly:** with
breakpoints already in the panel from a previous session in an OVERLAY file (e.g. `intro_main.c`),
start a fresh session while another module is resident, then `oric_wait_module Intro`. They must flip
to **armed** on their own — no re-setting. That is the case that was silently broken.

**#23 is deliberately NOT fixed** (reachability can't be decided soundly); it is documented in the
tool description and TROUBLESHOOTING instead. If you want to confirm the guidance reads correctly,
set `intro_main.c:490` again and check the caution now appears in the tool description you see.

**Startup (both are required — #21/#22 touch `mcp/`, #20 touches the extension host):** human
**Reload Window** (0.0.69), **restart the MCP server**, then start the bridge.

**New in 0.0.69, worth exercising first because it unblocks your actual work:**
- **#21 `oric_write_memory`** — the achievements case directly:
  `oric_write_memory { address: "gAchievements", bytes: "FF FF FF FF FF FF FF" }` (symbol name works,
  no `&` needed), then re-enter `DisplayAchievements()` and confirm all 50 render. Also try a hex
  address, a byte array, and a deliberate ROM write (e.g. `$E000`) to see the readback-mismatch
  warning. Note it is control-gated, so request control first.
- **#22 status** — reproduce the exact sequence: `oric_start_session` → `oric_status`. Neither may
  say `ended` for a live session, and the start result must not read `Started "…" … ended`. Bonus:
  end a session, start another, and confirm status tracks the new one.

**The whole point of this pass is the cold-attach path that #20 broke.** Run it in this order:
1. Human presses **F5** and lets the session come up (do **not** attach yet).
2. **Restart the MCP server** so its own buffer is empty and the session predates the process.
3. `oric_attach` → `oric_get_output` with `maxLines: 200`.

**Expected:** the backlog now contains the **`Oric Debug v0.0.68` build banner** and the **load-time
symbol note** (`… C line entries exist in other modules [SplashProgram:1307, …]`), not just the five
post-start lines. That restores two things at once: the cheap **version-skew check** on path (b), and
**#10's** verifiability from a cold client.

**Then confirm nothing regressed in the ring itself:**
- Live forwarding (path a) still complete: attach → `oric_start_session` → `oric_get_output`.
- **No leakage across runs:** after a restart of the debug session (or a second F5), `oric_get_output`
  must show only the CURRENT run — no lines from the previous one (that is what the removed reset used
  to guarantee, now done by session-id filtering).
- If output looks short, check **ring aging** (500 cap) before suspecting forwarding.

**Light regression sweep** (unchanged code, but cheap): #18 replace-on-reset, #17 plain basenames,
`[disabled (binding not evaluated)]`, selective cleanup.

**Notes:** #6 remains description-only; — and per your session (d) note, prefer a condition whose
value is **certain to recur** (`X == 0`) over an audio-content-dependent one (`X == 15`) when proving
a new condition took effect. Still an **uncommitted working tree**.

---

# □ Brief for session (d) — extension 0.0.67 — ✅ EXECUTED (see session (d) above)

**#17, #18 and #19 are addressed; zero Open entries remain.** Please run session (d) against
**0.0.67**. Confirm the build banner reports **v0.0.67** before testing anything else — it is the
cheapest way to prove there is no version skew, exactly as it was in session (c).

**Startup — the MCP server MUST be restarted, not just the window** (this prerequisite was added in
session (c) and lost in the rewrite for 0.0.67; re-adding it). #17's dedup and #18's
*"(replaced…)"* message both live in `mcp/oric-mcp-server.cjs`, which runs in a process owned by the
**Claude Code session**, not the extension host — Reload Window does nothing to it. A window-only
reload makes #17 look unfixed and #18's message vanish: **false negatives on both priorities.**
General rule: `git -C <extension dir> status --porcelain` — any `mcp/` file in the diff means restart
the MCP server.

**Use this exact order — it also gets Priority 3's cold-client replay test for free** (the one thing
session (c) could not do, because a warm client cannot distinguish replay from a retained buffer):

1. Human: **Reload Window** (loads `extension.js`, `debug_adapter.js`, `mcp/bridge-server.cjs`).
2. Human: press **F5** yourself — the session now exists and has already emitted the load-time
   symbol note.
3. Human: **restart the MCP server** — its buffer is empty and the session predates the process,
   which is precisely the cold-client precondition.
4. Human: start the bridge. Agent: `oric_attach` → `oric_get_output`. If the symbol note is there,
   **backlog replay is proven** (it can only have arrived via `bridge.hello`'s `outputBacklog`).
5. Everything else (#18, #17, regressions) then runs against that same live session.

**Priority 1 — #18 (the booby trap).** `(file, line)` is now the identity of a breakpoint:
1. Set `audio.s:400` **unconditionally**, confirm it fires.
2. Set `audio.s:400` **again with `condition: "X == 7""**. Expect the result to say
   *"(replaced the existing breakpoint there — was unconditional)"*, `oric_list_breakpoints` to show
   **exactly one** row for that line, and `oric_continue` to stop with `X = $07` — never the
   unconditional twin at some other value.
3. Set it a third time with a *different* condition; still one row, new condition in effect.

**Priority 2 — #17 (dedup).** With several breakpoints in one busy file (e.g. 4 in `bytestream.s`),
every row should render as the **plain basename** again. The expansion must still kick in only when
one basename maps to two genuinely different paths — which Encounter cannot produce, so either test
that part in **Nova** or accept the unit test (`same-file x4` stays short, `two paths` both expand).

**Priority 3 — #19 (the replay test done properly).** The corrected procedure, which the earlier
brief got backwards:
- **live forwarding** (what session (c) actually proved): attach → `oric_start_session` →
  `oric_get_output` is non-empty.
- **backlog replay (the real cold-client test):** human presses **F5 first** → **restart the MCP
  server** (so its buffer is empty and the session predates the process) → `oric_attach` →
  `oric_get_output` should **still** contain the load-time symbol note, delivered via
  `bridge.hello`'s `outputBacklog`.
- If it is empty, check **ring aging** (bounded at 500 both sides) before concluding forwarding broke.

**Regression watch:** #17/#18 touched the same list/set paths as #2, #9, #13 and #14 — re-check
bare-basename arming + firing, conditional breakpoints, selective cleanup (`file`+`line`), and that
disabled entries still read `[disabled (binding not evaluated)]`.

**Still true:** #6 is description-only (nothing to exercise), and this remains an **uncommitted
working tree** — the commit is gated on this pass.

---

# Session 2026-07-26 (d) — validation of the 0.0.67 fixes (Encounter, collaborative attach)

**#17 and #18 are confirmed fixed, the regression sweep is clean, and #19's corrected procedure ran
properly — and in doing so exposed #20**, the one remaining problem.

**Static pre-checks:** version reads `0.0.67`; `package.json` is a clean 12-insert/1-delete diff,
valid JSON, `focusOnStop` present (the author's rewrite-then-revert wobble is genuinely resolved);
the #17 dedup is the `Set`-of-distinct-paths form verbatim; zero `— Open` entries remained.

**#18 — the booby trap: FIXED.** `(file, line)` is now genuinely the identity. Four successive sets
on `audio.s:400`, each reporting exactly what it displaced:

```
(no note)                                                    ← 1st, unconditional
... if X == 7  (replaced the existing breakpoint there — was unconditional)
... if X == 15 (replaced the existing breakpoint there — was if X == 7)
... if X == 0  (replaced the existing breakpoint there — was if X == 15)
```

`oric_list_breakpoints` showed **exactly one** row for that line at every step. The `X == 7` version
stopped with `oric_evaluate X` = `$07`; the `X == 0` version stopped with `$00`. No unconditional or
stale-condition twin ever survived to fire — the session (c) failure mode is gone.

*Method note:* `X == 15` never occurred in ~800 frames (the value is audio-content dependent), so
"new condition in effect" was proven with `X == 0` instead — a value certain to recur. A stale
`X == 7` or `X == 15` breakpoint would have stopped at the wrong value; it stopped at `$00`.

**#17 — dedup: FIXED.** With 4 breakpoints in `bytestream.s` and 6 in `game_utils.s`, every row
renders as the **plain basename** again. The expansion branch is untestable in Encounter (no
duplicate basenames anywhere), so the author's unit test remains the coverage for that half — Nova is
still the better live test.

**Regression sweep — clean.** Bare-basename arming: `audio.s:400` → *bound and ARMED* → fired at
`_PsgSetRegister+$1C`. Conditional breakpoints: proven twice. Selective cleanup: `file`+`line` removed
only the agent's breakpoint, leaving exactly the human's 17. Disabled entries still read
`[disabled (binding not evaluated)]` throughout.

**#19 — procedure corrected and run properly.** Human pressed F5 (`Build & Debug`) *before* the agent
attached, so the load-time output genuinely predated the attach. Replay does fire — but it is
**truncated**, dropping exactly the lines the procedure depends on. See #20.

**Correction to this session's own method — worth heeding in future passes.** This entry originally
claimed #17/#18 were untestable because `/mcp` had kept an 0.0.66 MCP client alive; that was **wrong**,
and it was my error, not a tooling one. PID 55284 *was* the fresh 0.0.67 server spawned by the human's
Reload Window — I had misattributed it to an earlier restart and mis-dated session (c), which actually
ran on PID 52700. Two lessons: **behavioural discrimination is the reliable version check** (#17's
dedup output is a perfect discriminator — expanded paths on a busy file = 0.0.66, plain basenames =
0.0.67; #18's *"(replaced…)"* note is another), and process-creation-time archaeology is not, because
the MCP client and the extension host are separate processes whose identities are easy to confuse.
Do not defer a test on the strength of a process listing alone — probe behaviour first, it is one
tool call.

## #20 — the output ring is wiped *after* the early output lands, so replay loses the banner and the symbol note — Fixed (0.0.68)

Correct on every point, including that it partly undid the #12 → #10 chain on exactly the path the
brief asked to be tested. My reset was tied to `onDidStartDebugSession`, which fires **after** the
adapter has printed the banner, symbol note, build check and launch lines — so the guard meant to
drop the *previous* run discarded the *current* one's most valuable output. Fixed in the same commit
rather than deferred, since shipping the feature with its headline path broken would be worse.

**Fixed using your preferred approach — session-id stamping, which is immune to event ordering:**
- Each ring entry is now `{ sid, text }`, stamped with the tracker's own `session.id`.
- `outputLog()` returns only entries for the **active** session (falling back to the newest session
  that produced output), so a previous run is never served.
- The `onDidStartDebugSession` reset is **removed** (with a comment explaining why it must not come
  back), and memory stays bounded a different way: when a new session speaks for the first time, the
  older session's entries are retired.

**Unit-tested against the exact ordering you reported:** early output → late `onDidStartDebugSession`
→ more output keeps all four lines including the banner and `SplashProgram:1307`; a second session
then serves only its own two lines, with its own pre-start banner intact and no leakage from run 1.

⇒ On a cold attach the banner **and** the symbol note are now in the backlog, so the brief's
version-skew check works on path (b) and #10 is verifiable there too — not only via live forwarding.

**Observed:** cold-client attach (session created by the human's F5, agent attaches afterwards).
`oric_get_output` with `maxLines: 200` returned the **entire** buffer as just five lines:

```
Debug session started — GDB on localhost:6510
Connecting to viz server at localhost:6511...
Connected to localhost:6511
configurationDone: stop on attach (entry)
Module-load watch armed on _osdk_dbg_module ($ff95)
```

Everything the adapter printed *before* "Debug session started" is gone: the **`Oric Debug v0.0.67`
build banner**, the **load-time symbol note**, `Build is up to date.`, `Launching: …`, the Oricutron
connect and the GDB/VIZ handshake. Session (c) saw all 20 of those lines — because it was attached
*live* and received them via `bridgeServer.broadcast` (`extension.js:8777`), which is a separate path
from the ring. Not ring aging: five entries, ceiling 500.

**Root cause:** `vscode.debug.onDidStartDebugSession` does `bridgeOutputLog = []`
(`extension.js:8294`, commented *"fresh session → don't serve the previous run's console output"*).
But the debug-adapter tracker (`extension.js:8772`) starts pushing into that same array as soon as the
adapter emits anything — and the banner, symbol load, build check and launch lines are all emitted
during initialize/launch, i.e. **before** `onDidStartDebugSession` fires. So the reset intended to
discard the *previous* run's output actually discards the *current* run's most valuable lines. Only
output produced after the session-started event survives, which is exactly the five lines above.

**Impact — this partly undoes the #12 → #10 chain on the very path the brief asks to be tested:**
- The brief's own first instruction, *"Confirm the build banner reports v0.0.67 before testing
  anything else"*, is **impossible for a cold-attaching agent** — the banner is never in the backlog.
  The one cheap version-skew check does not exist on path (b).
- #10's symbol note — the entire point of the #12 → #10 chain — is unavailable to a cold client, so
  #10 remains verifiable *only* via live forwarding.
- Live forwarding (path a) is unaffected and complete.

**Fix:** the ordering is unwinnable as written; don't tie the reset to `onDidStartDebugSession`.
Cleanest is to stamp each entry with the session id and have `outputLog()` return only the active
session's entries, which is immune to event ordering. Otherwise clear on
`onDidTerminateDebugSession`, or in the session-creation path *before* the adapter starts (
`resolveDebugConfiguration` / `startOricDebugSession`) rather than after it has already spoken.

---


# Session 2026-07-26 (c) — validation of the 0.0.66 fixes (Encounter, collaborative attach)

Ran the "► NEXT TEST PASS" brief below against **0.0.66**, on the author's **uncommitted working
tree** (not a committed build — `git status` showed `debug_adapter.js`, `extension.js`,
`mcp/bridge-server.cjs`, `mcp/oric-debug-client.cjs`, `mcp/oric-mcp-server.cjs`, `package.json` all
modified). **All five of #12–#16 are confirmed fixed, and no regressions were found.** Two new
findings (#17, #18) and one correction to the brief's own method (#19).

**Priority 1 — #12 `oric_get_output`: FIXED.** After `oric_start_session`, `oric_get_output` returned
20 lines of real console output (adapter banner, symbol load, emulator launch, GDB/VIZ handshake,
module-load transitions). The root cause the author identified was right and mine in session (b) was
wrong: the bridge never forwarded `output` at all, so it was never a flush race.

**Priority 2 — #10: FIXED, and now verifiable.** The symbol note reads:

```
Loaded 514 symbols, 2361 line entries in the active view (all assembly); 8531 C line entries exist
in other modules [Splash:1307, Intro:2883, Game:839, Outro:3502] — C breakpoints bind once that
module is resident, 0 types, 0 typed vars, 0 funcs with locals, ... [5 modules, active=(none)]
```

No trace of *"0 from .c — rebuild with -g1"*. `Splash:1307` matches the author's predicted count
exactly, which independently confirms this is the same data path they analysed.

**Should not regress — new and genuinely useful:** the output now opens with a self-identifying build
banner, `Oric Debug v0.0.66 · adapter 2026-07-26 12:49 · extension 2026-07-26 12:56 · resolver
2026-07-14 18:43 (file mtimes, UTC)`. This is the only way an agent can *prove* which version it is
talking to, and it settled the version-skew risk in this session immediately. Also `[module:
resident]` now replaces the cryptic `[modules: R]`.

**Priority 3:**

| # | Check | Result |
|---|---|---|
| #14 | disabled entries | all 17 read `[disabled (binding not evaluated)]` with no bound/armed verdict — nothing looks broken any more. **Fixed.** |
| #15 | module names in messages | `bound, not yet armed: it lives in module Splash, but the active module is Intro — it will arm automatically when that module becomes resident`. Verbatim match, no bare `0`/`1`. **Fixed.** |
| #16 | `oric_start_session` provenance | `Started "Build & Run" — remembered from the last launch of 3 (Build & Debug, Build & Run, Attach to Oricutron). The machine starts RUNNING (stopOnAttach: false).` Verbatim match. **Fixed.** |
| #13 | basename disambiguation | mechanism works and renders, but it over-triggers — see **#17**. The case #13 was actually filed for (two *different* files sharing a basename) **could not be reproduced**: Encounter has zero duplicate source basenames, verified across all `.c/.s/.h/.asm`. Test it in Nova, or with a unit test on the label function. |

**Regression sweep — all clean.** #2 bare-basename arming: `audio.s:400` → *bound and ARMED* → fired
at `_PsgSetRegister+$1C`. Conditional breakpoints: `if X == 7` ran free through a frame, then stopped
with `oric_evaluate X` = `$07 (7)`. #11 selective cleanup: removing my two breakpoints left exactly
the human's 17 untouched.

## #17 — the #13 basename dedup counts rows, not distinct paths — Fixed (0.0.67)

Correct diagnosis and the suggested fix was the right one — applied verbatim: the counter is now a
**Set of distinct (lower-cased) paths per basename**, and expansion triggers only when that set has
more than one member. Several breakpoints in one file share a single path, so they stay short.

**Also now unit-tested**, which closes the coverage gap you flagged in #13: a small harness checks
all three shapes — 4 rows in one file stay `bytestream.s`; two genuinely different paths with the
same basename both expand; a unique basename alongside a duplicated one stays short. So #13's real
disambiguation case is verified by construction even though Encounter has no duplicate basenames
(Nova is still the better live test).

**Observed:** in a list where `bytestream.s` holds 4 breakpoints, `game_utils.s` 6, and
`splash_main.c` 2, *every* one of those rows was expanded to 3 path segments
(`Encounter\code\bytestream.s:15`), while the genuinely unique `game_main.c:52` and `loader.asm:276`
stayed short. Clinching evidence: `splash_main.c:262` rendered **expanded** while my
`splash_main.c:236` existed, and reverted to **short** the moment I removed 236.

**Root cause:** `mcp/oric-mcp-server.cjs:346` builds the counter as
`seen.set(basename, (seen.get(basename) || 0) + 1)` — one increment **per row** — then expands when
the count is `>= 2`. Multiple breakpoints in the *same* file therefore trip the "ambiguous basename"
branch even though all of them share one identical path and nothing needs disambiguating.

**Impact:** cosmetic only, but it inverts the intent: the common case (several breakpoints in one
busy file) gets noisy expanded paths, and the list becomes ragged and harder to scan than the plain
basenames it replaced. Line numbers already distinguished those rows.

**Fix:** key on the set of **distinct** paths per basename, not the row count:

```js
for (const b of rows) {
    const k = path.basename(b.file);
    if (!seen.has(k)) seen.set(k, new Set());
    seen.get(k).add(String(b.file).replace(/\//g, '\\').toLowerCase());
}
// ...
if ((seen.get(base) || { size: 0 }).size < 2) return base;
```

## #18 — `oric_set_breakpoint` on an existing file:line adds a duplicate instead of updating it — Fixed (0.0.67)

Agreed on every point, including that it was one step from producing a false "conditional
breakpoints regressed" report — the failure mode is genuinely worse than the bug.

**Fixed:** `(file, line)` is now the **identity** of a source breakpoint. `bpSet` finds any existing
source breakpoints at the resolved path + line, **removes them**, then adds the new one — so
re-setting a line to attach or change a condition *replaces* it, the way every other debugger
behaves. No unconditional twin can survive to fire.

The result also states what happened rather than hiding it:
*"Breakpoint …\audio.s:400 if X == 7 — bound and ARMED (live) (replaced the existing breakpoint
there — was unconditional)"*.

**Observed:** with `audio.s:400` already set unconditionally, calling `oric_set_breakpoint audio.s
400 condition:"X == 7"` reported `if X == 7 — bound and ARMED (live)` — but produced a **second**
panel entry. `oric_list_breakpoints` showed both:

```
Encounter\code\audio.s:400  [armed]
Encounter\code\audio.s:400  if X == 7  [armed]
```

The next `oric_continue` stopped immediately with `X = $B3 (179)` — the *unconditional* twin firing.
After clearing (`2 removed`) and setting only the conditional one, it correctly ran on and stopped
with `X = $07`.

**Impact: this is a booby trap aimed squarely at agents, and it manufactures false regression
reports.** The natural way to add a condition to a breakpoint you already set is to set it again
with the condition — every debugger works that way. Here that silently leaves the unconditional
breakpoint armed, so the condition appears to be **ignored**, with a stop at a value that plainly
fails it. This session was one step from filing "conditional breakpoints regressed in 0.0.66"; only
listing the breakpoints revealed the duplicate. Note it also defeats #13/#17's whole purpose — two
rows with byte-identical paths, distinguishable only by the condition suffix.

**Fix:** treat `(file, line)` as the identity — replace the existing breakpoint's condition instead
of appending. If duplicates are ever legitimate, `oric_set_breakpoint` should at minimum say
*"replaced the existing breakpoint at audio.s:400 (was unconditional)"* or
*"WARNING: audio.s:400 already has an unconditional breakpoint, which will still fire"*.

## #19 — the brief's #12 path (a) cannot exercise the backlog replay — Acknowledged; brief corrected (0.0.67)

You are right and the brief was wrong: `oric_attach` must precede `oric_start_session` (attaching is
what provides the bridge connection), so on path (a) the client is already listening — that
validates **live `output` forwarding**, not replay. Replay only runs when output predates the
attach, which is path (b). The brief has been corrected, and the strict cold-client procedure you
specified (human F5 → **restart the MCP server** → `oric_attach` → `oric_get_output`) is now the
named test for it.

Your ring-aging caveat is recorded too: the buffer is bounded at 500 on both sides, so in a long
session the load-time note can legitimately age out — check that before concluding forwarding broke.

**Observed:** the brief asks path (a) to be `oric_start_session` → `oric_get_output`, expecting the
symbol note *"even though the session started before you were listening"*. But an agent must
`oric_attach` **before** it can call `oric_start_session` — attaching is what gives it a bridge
connection at all. So on path (a) the agent *is* already listening, and what it validates is **live
`output` forwarding**, not the replay.

The backlog replay only runs when output predates the attach — i.e. the human presses F5 first and
the agent attaches afterwards, which is path **(b)**. The two paths test the opposite things from
what the brief says.

**Partial evidence for replay:** re-attaching mid-session preserved the full pre-attach history, and
`bridge.hello` demonstrably carries `outputBacklog`. But that is not a cold-client test — this MCP
process already had the lines buffered, so it cannot distinguish replay from a retained buffer. **A
strict test needs a session that predates the MCP process:** human F5 → *then* restart the MCP
server → `oric_attach` → `oric_get_output` should still show the symbol note. Worth one cheap run.

**Also note:** the ring is bounded at 500 on both sides (`oric-debug-client.cjs` shifts at 500 *and*
`slice(-500)`s the backlog), so in a long session the load-time note can legitimately age out. If a
future pass sees an empty result, check for ring aging before concluding the forwarding broke.

---


# Session 2026-07-26 (f) — validation pass against 0.0.70

Ran the 0.0.70 brief. **#20, #21, #22, #24 all confirmed fixed.** Regression sweep clean.
Two new findings (#25, #26), and **#23 should be reopened — I got it wrong in session (e)**.

Version confirmed behaviourally before testing: `oric_set_breakpoint`'s description carried the
new #23 caution and `oric_write_memory` existed with `count`, so the MCP side was 0.0.70; the backlog
banner then confirmed the extension host (`Oric Debug v0.0.70 · adapter 15:34 · extension 15:29`).
The MCP server was deliberately NOT restarted — it had never attached, so its ring was already
virgin, which is the #20 precondition.

## ✅ #20 — cold-attach backlog replay: FIXED

Genuine cold path: human F5'd, session came up, then a first-ever `oric_attach` from a process that
predated nothing. `oric_get_output maxLines:200` opened with **both** lost lines:

```
Oric Debug v0.0.70  ·  adapter 2026-07-26 15:34  ·  extension 2026-07-26 15:29  ·  resolver ...
Loaded 514 symbols, 2361 line entries ...; 8375 C line entries exist in other modules
  [Splash:1271, Intro:2867, Game:798, Outro:3439]
```

Version-skew check restored on path (b), and **#10 is verifiable from a cold client again**.

## ✅ #24 — restored breakpoints re-bind: FIXED (and it fires, not just reports)

`intro_main.c:476` and `:490` were left in the panel across a Reload Window, so both were genuine
restored entries with no bindings. Sequence, nothing touched:

| point | 476 / 490 |
|---|---|
| attached, `module: (none)` | `[bound, not armed (its module is not resident)]` |
| after `oric_wait_module Intro` | **`[armed]`** |
| `oric_continue` | **stopped at `_DisplayAchievements+$F6 intro_main.c:476`** |

Note the first row is already better than session (e), where the same restored entries read
`[NOT BOUND — will never fire]` — they now resolve at session start, before any module switch.
And critically the breakpoint **actually fired**, so ARMED stayed honest (#8's property held).

## ✅ #22 — no `ended` anywhere: FIXED

Across a ~40-call session: `oric_continue` → `running` (that was the return that had become useless),
`oric_status` accurate at every check, and `oric_start_session` on a live session →
`A debug session was already running (Build & Debug). stopped (breakpoint) at ... intro_main.c:490`.
The string `ended` never appeared once.

## ✅ #21 — `oric_write_memory`: FIXED, works on the exact motivating case

`oric_write_memory { address: "gAchievements", bytes: "FF FF FF FF FF FF FF" }` → *"Wrote 7 byte(s)
at $BFE2 … verified"*, symbol resolved with no `&`. Stopped at 476 on the first loop iteration,
wrote, let the render finish: **"Achievements unlocked: 98%" with 49/50 unlocked** — entry 0 still
`<?>` exactly as predicted, since its message was chosen at line 469 before the write. That is the
screen that was previously unreachable without playing the game.

Also passing: hex address (`$1454`), `count` mismatch refused (*"you said 3 byte(s) but `bytes`
decodes to 2 — refusing the write"*), readback verification on every write.

## ✅ Regression sweep — clean

- **#17** bare basenames: used `intro_main.c` for every set/clear all session, always resolved.
- **#18** replace-on-reset: re-setting 476 with a condition gave *"(replaced the existing breakpoint
  there — was unconditional)"*, and the list showed **one** entry, not two.
- `[disabled (binding not evaluated)]` intact for all 17 unrelated panel entries.
- Selective cleanup: `file`+`line` removed exactly one and left 490 and the other 17 alone.
- **Not exercised:** no-leakage-across-runs (needs a second F5; I had one session all pass).

## #23 — intermittently missed breakpoint — Fixed (0.0.71, via #26) — monitoring

**Session (g): 21 hits, 0 misses** (7/7 on 476, 14/14 on 490) across `continue` vs `run_frames`, short
vs long runs, one vs two breakpoints — against 2-in-7 the session before.

**Your unification is almost certainly right: #26 WAS #23.** One drifting ref-count produces both
symptoms, which is what makes it satisfying — stuck **high**, a cleared breakpoint keeps firing;
prematurely **zero**, an armed breakpoint never fires while the panel still reports armed. That also
explains the intermittency and why it only bit in sessions with repeated set/clear cycles. Nothing
else changed between the two sessions that could plausibly account for 2-in-7 → 0-in-21.

Kept as *monitoring* rather than closed outright, because the causal link is inferred from the
symptom disappearing, not from a reproduction that was traced through the ref-count. If a miss ever
recurs, reopen and dump the arm/disarm sequence for the address.

**Method note (yours, and it should outlive this entry):** *a miss claim needs proof the line was
reached, not just proof that nothing stopped.* Session (g)'s design is the model — leaving 490 armed
so that stopping there proves execution crossed all 50 iterations of 476 without stopping, which is a
far stronger negative than exhausting a frame budget.

The 0.0.71 documentation wording ("re-run rather than assuming the breakpoint or the line is wrong")
stays as-is: it is still the right first move for a user, and is now backed by a known mechanism.

Thank you for retracting this — a wrong cause in shipped documentation is worse than an open bug,
and you caught it before Mike hit it. **Both places have been corrected in 0.0.71:**
- `oric_set_breakpoint`'s description now states the real finding — *"an ARMED breakpoint is
  occasionally MISSED (observed ~2 misses in 7 hits on the same line, no known pattern — under
  investigation) … re-run rather than assuming the breakpoint or the line is wrong"* — with the -O2
  `return`/brace point demoted to a secondary "a statement is more reliable" note.
- `TROUBLESHOOTING.md`'s section is retitled *"A breakpoint says it's armed but didn't fire"* and now
  **leads with "First: try again"**, keeping the rebuild-at-`-O1` advice only for a breakpoint that
  *never* fires across several runs. No reader is now told to rebuild a TU over a single miss.

**Status: genuinely open, cause unknown.** Your evidence rules out both earlier theories (490 fires 5×
from two different resolve paths at the same address). A ~2-in-7 intermittent miss with
`oric_continue` AND `oric_run_frames` points at stop delivery rather than arming — the same family as
#26. Candidate areas for the next investigation: the Z0 re-arm/step-off dance after a hit (a
breakpoint at the PC is stepped over on resume — if a hit lands while that step-off is pending the
stop could be swallowed), `run_frames`' frame-boundary check racing a stop, and the module-load watch
forcing a mid-flight read. Needs an instrumented repro loop (set → continue → count hits over N
iterations) rather than another feature pass.

**`intro_main.c:490` fires.** It fired **5 times** this session — as a restored breakpoint, as a
hand-set one, driven by `oric_continue` (4×) and by `oric_run_frames` (1×) — every time at the same
address, with a clean stack:

```
#0 _DisplayAchievements+$1ED  intro_main.c:490
#1 _main+$1E2                 intro_main.c:772
#2 _LoaderResidentStart+$7    loader.asm:301
```

So the tail-call/dead-epilogue theory I gave you in session (e) is **not** what is happening. I
suspected the two resolve paths might disagree (the #24 fix adding a second one), so I cleared the
restored 490 and hand-set the identical line: same address, fires the same. That hypothesis is dead
too.

What is real is **intermittency**: twice, 490 was `[armed]`, the achievements page demonstrably
rendered (`gIntroPage` forced to 3, then observed at 5 with "Hints and tips" on screen), and it did
not stop. Then the identical setup fired. Sample: ~5 fires / 2 misses, no pattern I could pin —
`run_frames` both caught it (7 frames in, and caught 476 at 316 frames in) and missed it.

**Recommendation:** reopen #23 as *"an armed breakpoint is intermittently missed"* and **soften the
0.0.70 documentation**, which currently tells the reader the cause is `-O2` epilogue elision and to
move the breakpoint or rebuild at `-O1`. On this evidence that guidance sends people to rebuild a
translation unit over what looks like a race in stop delivery. The TROUBLESHOOTING entry is still
useful for the genuine NOT-BOUND contrast; it is the *"such a breakpoint reports ARMED yet never
fires"* framing that overstates a case built on two observations — mine, and I should have
qualified them.

## #25 — the documented byte-array form of `oric_write_memory` is unusable — Fixed (0.0.71)

**Note on the session (g) "correction": it retracted a diagnosis that was actually right.** Checked
against the source before recording it — `oric_write_memory` does not exist in any commit before
`7be0c5a` (0.0.69/0.0.70 were working-tree only), and in **both** of those versions `bytes` was
`{ description: 'hex string or array of byte values' }` with **no declared `type`**. The
`type: ["string","array"]` declaration and the decoder branch were added **together** in 0.0.71 as the
fix. So:
- Your **session (f)** explanation (no declared type → array stringified in transit) was **correct**,
  and is corroborated by the error you got: *"must be an even-length hex string"* comes from the hex
  `else` branch, which is only reached when `Array.isArray(bytes)` is **false** — i.e. it genuinely
  arrived as a string.
- The **session (g)** correction ("0.0.70 already declared ["string","array"], so the bug was in the
  decoder, not the transport") is the part that is wrong. No retraction was needed.

**What shipped (unchanged, and belt-and-braces either way):** the schema now declares
`type: ["string","array"]` with `items: {type: number}`, **and** the server accepts an array that still
arrives stringified (`/^\s*\[/` → `JSON.parse`, clear error if unparseable). The second half is what
makes it robust regardless of how any transport marshals it — so the tool is correct under both
explanations.

Your diagnosis was exactly right: `bytes` declared no `type`, so an array was stringified in transit
and reached the parser as `"[3, 3]"`.

**Fixed both ends:** the schema now declares `"type": ["string", "array"]` with `items: {type: number}`,
**and** the server accepts an array that still arrives stringified (`/^\s*\[/` → `JSON.parse`), with a
clear error if it isn't parseable — so the advertised form works regardless of how the transport
marshals it.

`bytes` advertises *"a hex string or an array of byte values"*, and the array form always fails:

```
oric_write_memory { address: "$1454", bytes: [3] }      → ERROR: bytes must be an even-length hex
oric_write_memory { address: "$1454", bytes: [3, 3], count: 2 } → same error
oric_write_memory { address: "$1454", bytes: "03" }     → Wrote 1 byte(s) — verified
```

Same address, same call, only the form differs.

**Correction (added after the 0.0.71 commit — my original cause here was wrong).** I first wrote that
`bytes` declares no `type` in the tool schema. It does; the 0.0.70 schema I was served reads

```json
"bytes": {"description": "hex string (\"FF FF\") or array of byte values ([255,255])",
          "items": {"type": "number"}, "type": ["string", "array"]}
```

so the array form is already well-typed and this is **not** a transport-stringification problem —
the array reaches the server and the server's own decoder rejects it. If the 0.0.71 fix tightened
the schema, that is a no-op and #25 will still fail; the decode path for a real JS array in
`bytes` is what needs to accept it. Low severity — the hex form covers everything — but the
description promises it.

## #26 — a cleared breakpoint fired once and reappeared in the list — Fixed (0.0.71)

**Your ref-count hypothesis was right, and it located a real bug** — though not in the #24 pass you
suspected. It is in `revalidateBreakpointsAfterSymbolLoad()`:

1. It disarms only old bindings whose address did **not** survive re-resolution — an old binding
   armed at a **surviving** address is deliberately left armed.
2. It then does `bp.bindings = newBindings`, **discarding those objects**, replaced by fresh ones
   with `armed: false`.
3. It then calls `armAddr()` for the surviving address **again** → the ref-count for that address
   reaches **2** for ONE logical breakpoint.

A later single `disarmAddr` (your `oric_clear_breakpoints`) drops 2 → 1, so the Z0 stays live in the
emulator: the clear honestly reports "(1 removed)" from VS Code's model, and the breakpoint still
fires — exactly what you saw. The old comment ("armAddr is ref-counted, so surviving addresses are
unaffected") had the reasoning inverted: being ref-counted is *why* re-arming double-counts.

**Fixed:** re-resolution now **carries the armed state across** for any binding whose (addr, module)
survived, arms only what isn't already armed, and disarms a binding whose module went inactive. One
logical breakpoint therefore holds exactly one ref.

Since it was intermittent for you, treat the fix as unproven until a clear+continue cycle has been
run a few times — and note this may also be a candidate cause for some of #23's missed hits (a
stale/extra ref changes what the resume-time step-off does), though that is a hypothesis, not a claim.

Once, this exact cycle resurrected a removed breakpoint:

```
set 476 → run_frames → stopped at 476
oric_clear_breakpoints {file: intro_main.c, line: 476}  → "Cleared ... (1 removed)"
run_frames 600  → "Ran 2 frames. stopped (breakpoint) at ... intro_main.c:476"
oric_list_breakpoints → intro_main.c:476  [armed]     ← back, after being removed
```

A second clear with no execution in between removed it properly, and re-running the whole cycle did
**not** reproduce it. So: intermittent, same as #23's misses, and possibly the same underlying
cause — arming is ref-counted and the #24 fix added a path that re-resolves and re-arms, so a count
that drifts above 1 would survive a single clear and then re-register on the next hit. Worth an
audit of the ref-count increment in the new `rearmModuleBreakpoints()` re-resolve pass even though
I cannot reproduce it on demand.

**For an agent:** after clearing, `oric_list_breakpoints` before trusting it — the clear's own
"(1 removed)" was truthful and the breakpoint still fired.

## Note — the brief's ROM-write test cannot be run on Encounter

`oric_write_memory { address: "$E000", bytes: "AA" }` reported *"verified"*, not the expected
readback mismatch. Not a bug: `$C000` reads `7d 77 7d 77 …` and `$E000` reads back the written byte,
i.e. Encounter has **overlay RAM banked in across `$C000+`**, so the write genuinely landed. The
mismatch path is untested — pick a target with real ROM visible, or an unmapped hole.

*(I also clobbered that `$E000` byte in Mike's live session without reading it first — my mistake;
overlay space, reloaded per module, but worth a session restart.)*

## `oric_press` leaves the machine halted

Minor, doc-only: `oric_send_keys` states *"The machine runs while typing"*; `oric_press` says nothing
and leaves it **stopped** after injecting. I briefly mistook this for a stale-status bug and only
ruled it out because two screenshots reported the identical frame (14083). Worth one clause in the
description.

---

# Session 2026-07-26 (e) — findings from real Encounter debugging (not a validation pass)

These came up while using the tools for actual work — reproducing a game bug in the intro's
`DisplayAchievements()` — rather than while validating a fix. The 0.0.68 brief below is still pending.

## #21 — there is no way to WRITE memory, so an agent cannot set up game state — Fixed (0.0.69)

Case accepted as made — the achievements example is exactly right that the workaround isn't just
slower but tests **the wrong thing** (`WATCHED_THE_INTRO` lands in the left column, not the broken
case), and that snapshots can only replay states a human already reached, never synthesise one.

**Fixed:** new **`oric_write_memory { address, bytes }`**, control-gated (added to `CONTROL_TOOLS`;
`writeMemory` was already in the bridge's `CONTROL_REQUESTS`, so the gate was already correct on that
side). It uses the adapter's existing `writeMemory` request — the one M-packet sender — so it shares
the same stale-cache handling as the console `w` command.

Beyond the raw form you asked for:
- **`address` takes a symbol name**, not just hex: `oric_write_memory { address: "gAchievements",
  bytes: "FF FF FF FF FF FF FF" }` works directly, resolved through the same underscore-aware lookup
  as "Go to: symbol" (so `gAchievements` finds the exported `_gAchievements`) — no `&sym` round-trip.
- **`bytes`** accepts a hex string (`"FF"`, `"FF FF 00"`, `"ffff00"`) or an array of byte values.
- **It reads the bytes back and verifies**, because a write into ROM or unmapped space is accepted
  and silently does nothing: on a mismatch it reports what memory actually reads now and points at
  the likely causes (ROM/unmapped, or the running program overwrote it — is the machine stopped?).

Assignment in `oric_evaluate` (`sym[i] = value`) is deliberately NOT done: it needs an lvalue
evaluator in the adapter, and address+bytes covers the need today. Filed as an ergonomic follow-up
only if it proves painful in use.

**Observed:** `oric_read_memory` exists; there is no counterpart. `oric_evaluate` rejects assignment:

```
oric_evaluate "&gAchievements"        → $BFE2 (49122)  address of gAchievements
oric_evaluate "gAchievements[0]=255"  → ERROR: unexpected '=255'
```

**Why it matters (concrete case):** to see the achievements screen with entries unlocked, the natural
move is to force the 7-byte bitfield at `$BFE2` to `$FF` and let the existing code render all 50.
Without a write, the alternatives are all worse: play the game to unlock them, or burn a full intro
loop in turbo to earn exactly one achievement (`WATCHED_THE_INTRO`, which lands in the *left* column —
not even the case under test). Setting up state is the single most common thing an agent needs when
reproducing a bug on a specific screen, and right now it can only *observe*.

**Fix:** an `oric_write_memory {address, bytes}` (hex string or byte array), control-gated like the
other mutating ops. Assignment support in `oric_evaluate` (`sym = value`, `sym[i] = value`) would be
the ergonomic version, but raw address+bytes covers the need and is far simpler to get right.
Snapshots (`oric_save_snapshot`/`oric_restore_snapshot`) partly mitigate this, but only for states a
human has already reached and saved — they cannot synthesise a new one.

## #22 — `oric_status` reported `ended` for a demonstrably live session — Fixed (0.0.69)

Your diagnosis was right: the state was a **stale flag from the previous session**, not a race on
the new one. `BridgeDapShim.ended` is set by the `ended` broadcast and **nothing ever cleared it** —
and the shim outlives sessions (it belongs to the MCP process, not the session), so a new session
inherited "ended" from the run before it. That is also why the result contradicted itself inside one
string: `whereString()` read the flag directly.

**Fixed at three levels, so no single missed signal can reproduce it:**
1. The extension now **broadcasts `started`** when a session begins (the signal that was missing
   entirely), and the shim clears `ended` on it.
2. `stopped` / `continued` also clear `ended` — any of them is proof of life.
3. `whereString()` no longer trusts the cached flag: before reporting `ended` while attached it
   **asks the bridge** (`bridge.hello` → `hasSession`) and self-heals the flag if a session is live.
   `oric_start_session` additionally clears it before reporting, so `Started "…" … ended` is
   structurally impossible now.

**Observed:** immediately after `oric_start_session` (which itself returned
`Started "Build & Run" … ended`), `oric_status` returned bare `ended`. The session was in fact fully
alive, confirmed three independent ways in the next two calls:

- `oric_screenshot` → a real advancing frame (`frame 1563`, then `frame 3959`)
- `oric_module` → `module: Intro`
- `oric_set_breakpoint intro_main.c:489` → `bound and ARMED (live) [module: Intro]`

and the console showed `[BRIDGE] Session live.` / `Active module -> Splash`. A later
`oric_start_session` correctly reported `A debug session was already running (Build & Run). stopped …`.

**Impact:** `ended` is the one status an agent treats as terminal — the correct response is to stop
and ask the human to start a session. Following it here would have abandoned a perfectly good
session. It is also self-contradictory within a single tool result: `Started "…" … ended`.

**Likely cause:** the state is being read before the new session registers, so the *previous*
session's terminated flag is still what gets reported — note the immediately preceding session had
genuinely ended. Whatever `oric_start_session` awaits before returning does not appear to be the
same signal `oric_status` reads.

**Update — worse than first thought: it is not transient, and it pollutes other tools.** Reproduced on
*every* `oric_start_session` in the session, and `oric_continue` also returns a bare `ended` while the
machine is demonstrably running (verified by screenshots advancing 9538 → 45152 → 48025 and by
`oric_backtrace` reporting a live stop at `_DisplayAchievements+$CF`). So `ended` is now the *normal*
return of `continue`, which makes it useless as a signal and actively misleading: the one thing an
agent must be able to trust is whether the machine is still alive.

## #23 — a breakpoint on a `return f(...)` line reports ARMED but never fires — Won't fix (detection); documented instead (0.0.70) — ⚠ REOPENED in session (f): does not reproduce, diagnosis below is wrong — probably FIXED by #26's ref-count fix (session (g): 21/21 hits, 0 misses); watch for recurrence

Your analysis is almost certainly right — a tail call under `-O2` whose line record points at a
merged/elided epilogue, so the armed address is dead code. And the framing is fair: this is worse
than an honest failure precisely because #8 made ARMED trustworthy.

**Why not detected:** deciding "this address never executes" is a reachability question over
optimized 6502 with indirect jumps, self-modifying dispatch and overlay-swapped code. The adapter
knows a line record EXISTS; proving nothing reaches it is not something it can do soundly, and a
heuristic ("warn on any `return` line") would cry wolf on every correctly-working `return` at -O1
and in the many cases where the epilogue is live. A wrong warning on a good breakpoint would cost
more than this bug does.

**So the fallback you suggested is what shipped** — steer the caller, in both places they'd look:
- `oric_set_breakpoint`'s description now carries the caution: prefer a real STATEMENT over
  `return expr;` or a closing brace at -O2, because such a breakpoint "reports ARMED yet never
  fires", and *"if a breakpoint does not fire, move it to the preceding statement before suspecting
  the tooling"*.
- `TROUBLESHOOTING.md` gains **"A breakpoint says it's set (armed) but never fires"**: what causes
  it, move to the last real statement, use **Step Out** to catch a function on the way out, or build
  that TU at `-O1`; plus an explicit contrast with the NOT BOUND case so the two aren't confused.

Reopen this if it bites again with a non-`return` line — that would mean the pattern is broader than
tail calls and worth another look.

**Observed:** in `DisplayAchievements()` (Encounter, `-O2 -g1`, Intro overlay), two breakpoints set the
same way, both reporting **identically**:

```
intro_main.c:476  (sprintf inside the loop)   → bound and ARMED (live) [module: Intro]   → FIRES
intro_main.c:490  (return WaitAndFade(50*5);) → bound and ARMED (live) [module: Intro]   → NEVER FIRES
```

476 stopped exactly as expected — `oric_backtrace` gave `#0 _DisplayAchievements+$CF intro_main.c:476`,
with the screen caught mid-render (one `<?>` drawn). 490 was crossed at least twice — the achievements
screen rendered fully and the intro moved on to the title screen — without ever stopping.

**Contrast with the good case:** `intro_main.c:489` (a blank line) is correctly rejected with
*"NOT BOUND … the line has no code (blank/comment/declaration — try a nearby statement)"*. That message
is excellent and was exactly right. So the adapter already distinguishes "no line record"; what it does
not detect is **a line record whose address is never executed.**

**Likely cause:** `return WaitAndFade(50*5);` is a tail call under `-O2`. The line record for the
`return` most likely points at a merged/elided epilogue, so the armed address is dead code.

**Impact:** worse than an honest failure, because #8's whole contribution was making ARMED trustworthy.
An agent that asks for "the end of this function" gets a confident ARMED and then waits forever. This
cost real time in this session before line 476 isolated it.

**Fix ideas:** when a line resolves inside a function epilogue or to an address with no reachable
predecessor, say so (*"bound at $XXXX, but that address is a `-O2` epilogue and may never execute — try
the last statement instead"*). Failing detection, the docs should steer agents to a *statement* rather
than a `return`/closing brace.

## #24 — breakpoints restored from a previous session never re-bind when their module loads — Fixed (0.0.70)

**Confirmed, root-caused, and it hit humans too, not just agents** — every saved panel breakpoint in
an overlay file was dead on arrival each session until touched. Thank you for isolating it against a
hand-set control; that comparison is what made the cause obvious.

**Root cause:** `rearmModuleBreakpoints()` (the module-switch hook) only iterates `bp.bindings` to
arm/disarm them. A breakpoint **restored from a previous session has `bindings = []`**: VS Code
re-sends it at session start, *before* the symbol file is loaded, so `fileToModules` is empty,
`owners` falls back to resident, nothing resolves — and VS Code never re-sends it. The module-switch
path then had nothing to iterate, so it stayed empty forever. A hand-set breakpoint resolved
immediately because by then the symbols existed. (`revalidateBreakpointsAfterSymbolLoad()` covers the
symbols-arrive-later case but does not re-run on a module switch.)

**Fixed:** `rearmModuleBreakpoints()` now **re-resolves any breakpoint with no bindings** before the
arm/disarm pass — same `fileToModules` + `addrForLine` logic as `setBreakpoints`. So when an overlay
becomes resident, its restored breakpoints resolve and arm, which is what #15's message already
promised. Ref-counted arming means re-running it is idempotent.

**Observed:** `intro_main.c:475` and `:489` were set in one session, survived in the VS Code panel across
a stop/rebuild/restart, and then:

- while Splash was active: `[NOT BOUND — will never fire]` (expected — Intro not resident)
- after `oric_wait_module Intro` reported `module: Intro`: **still** `[NOT BOUND — will never fire]`
- re-setting the very same file:line by hand: immediately `bound and ARMED (live) [module: Intro]`

**Impact:** this directly contradicts what #15's own message promises — *"it will arm automatically when
that module becomes resident"*. It does not, for entries the agent did not set in the current session.
The practical consequence for an agent is a silent trap: set a breakpoint, wait for the module, and it
never fires — indistinguishable from #23 until you re-set it and compare. It also means the human's
saved panel breakpoints are dead on arrival every session until touched.

**Fix:** on module load, re-resolve every panel breakpoint whose file belongs to the newly resident
module (the module-load watch that prints `Active module -> Intro (id 1)` is already the hook), rather
than only re-resolving ones set after the module became active.

---

# □ Brief for session (c) — extension 0.0.66 — EXECUTED (see session (c) above)

**All of #12–#16 from session (b) are now Fixed; zero Open entries remain.** Please run session (c)
against **0.0.66** and append your findings the same way.

**Before you start** (corrected by the testing agent — a Reload Window alone is **not** enough):

1. Human: **Reload Window** in VS Code — reloads the extension host (`extension.js`,
   `debug_adapter.js`, `mcp/bridge-server.cjs`).
2. Human: **restart the MCP server** (`/mcp` reconnect, or a fresh Claude Code session).
   `mcp/oric-mcp-server.cjs` and `mcp/oric-debug-client.cjs` run in a process spawned by the
   *Claude Code session* from the project's `.mcp.json`, at session start — Reload Window does
   nothing to them. Skipping this leaves an **0.0.65 MCP client talking to an 0.0.66 bridge**, which
   fails *silently*: `oric_get_output` has no `case 'output':` handler and still returns
   `(no output)`, and the #13/#14/#15/#16 wording all lives in `oric-mcp-server.cjs`, so **all five
   findings would be falsely reported as still broken.** This is not hypothetical — it is why
   session (c) did not start on first contact.
3. Human: start the bridge ("Oric: AI Collaboration — Start/Stop Bridge"), then agent: `oric_attach`.

**General rule for future passes:** `git -C <extension dir> status --porcelain` — if any `mcp/` file
is in the diff, the MCP server must be restarted, not just the window.

**Priority 1 — #12, because it unblocks #10.** `oric_get_output` was never going to work: the bridge
did not forward `output` events at all (not a flush race). It now forwards them AND keeps a
500-entry ring that survives attach, replayed via `bridge.hello`. Test both paths:
- (a) agent-created session: `oric_start_session` → `oric_get_output`. You should see the
  **load-time symbol note** even though the session started before you were listening.
- (b) human-created session (F5 first, then attach) → `oric_get_output` should also be non-empty.

**Priority 2 — #10, now verifiable.** In that output, the symbol note should read
*"… N line entries in the active view (all assembly); N C line entries exist in other modules
[SplashProgram:1307, GameProgram:…] — C breakpoints bind once that module is resident"*.
It must **NOT** say *"0 from .c — rebuild with -g1"* (that was the false alarm). Also confirm a C
breakpoint in an inactive overlay no longer claims a missing `-g1`.

**Priority 3 — the reporting fixes you filed:**
- **#13** `oric_list_breakpoints`: set two breakpoints on the same basename in different dirs (or
  reproduce the debris case) — repeated basenames should now print ~3 path segments so the rows are
  distinguishable; unique ones stay short.
- **#14** the human's disabled breakpoints should read `[disabled (binding not evaluated)]` with
  **no** bound/armed verdict — 17 entries should no longer look broken.
- **#15** breakpoint messages should name modules, e.g. *"it lives in module Splash, but the active
  module is Intro — it will arm automatically when that module becomes resident"*; no bare `0`/`1`.
- **#16** `oric_start_session` should state provenance + consequence, e.g. *Started "Build & Run" —
  remembered from the last launch of 3 (…). The machine starts RUNNING (stopOnAttach: false).*

**Please also re-check for regressions** in what session (b) confirmed (#2 bare-basename arming +
firing, conditional breakpoints, #11 selective cleanup) — #13/#14/#15 changed that same reporting
code, and #12 touched the adapter tracker that also drives stop handling.

**Known non-testable:** #6 is a tool-description change only (nothing to exercise).

---

# Session 2026-07-26 (b) — validation of the 0.0.65 fixes (Encounter, collaborative attach)

Second agent-driven MCP session, on extension **0.0.65**, re-running the failures from session (a)
against the same project (Encounter, OSDK 2.0, collaborative attach). Of the ten fixes 0.0.65
claims (#2–#11), **eight are confirmed working end-to-end**; #6 is a description-only change that
cannot be exercised, and #10 remains unverifiable from the agent side (see #12). Five new (minor)
findings are filed as #12–#16.

**Confirmed fixed — reproduced the original failure and it now works:**

| # | What was tested | Result |
|---|---|---|
| #2 | `audio.s:400` set by **bare basename** | resolved to `d:\Git\Encounter\code\audio.s`, reported *bound and ARMED*, and **actually fired**: `stopped (breakpoint) at _PsgSetRegister+$1C  audio.s:400`. A bogus name now fails loudly (`no file matching "nonexistent_file.c" in the workspace`) instead of creating a dead entry. |
| #3 | focus stolen on every stop | **human-confirmed**: the agent stopped execution 4 times while piloting (2 breakpoint hits, 1 conditional hit, 1 frame limit) and Mike reported *"I did not notice a loss of focus while you were driving"*. `focusOnStop: human` + `aiIsPiloting()` behaves as designed. |
| #4 | attach + status before F5 | `oric_attach` **leads** with *"THERE IS NO DEBUG SESSION YET — ask the human to press F5"*; `oric_status` returns the half-state instead of `running`. |
| #5 | `oric_start_session` | *"Started the debug session (Build & Run). running"* — the shared session came up, `oric_screenshot` showed the real logo screen. No separate emulator needed. |
| #7 | `&_KernelEndText` | `$143A (5178)  address of _KernelEndText`. |
| #8 | truthful bp state | all three states observed: *bound and ARMED (live)*, *bound, not yet armed (pending: its module is not resident)*, *NOT BOUND*. |
| #9 | per-bp armed state | states now render per entry (see #13/#14 for what is still wrong). |
| #11 | selective cleanup | `file` + `line` removed only the agent's own breakpoint; the human's 17 disabled entries survived untouched, verified by a follow-up `oric_list_breakpoints`. |

**Also confirmed (was blocked by #2, never previously exercised): conditional source breakpoints.**
`audio.s:400 if X == 0` armed, fired, and `oric_evaluate X` returned `X = $00 (0)` — the condition
was genuinely evaluated, not ignored. This was the capability #2 was costing us.

**Cleaned up:** the two dead breakpoints deliberately left behind by session (a) (on the bogus
paths `\audio.s:400` / `\splash_main.c:236`) are gone — the new basename-matching `clearAll`
removed them along with the live ones (`(2 removed)` twice).

**Not verifiable from the agent side:** #10 — the note it improved lives in the debug console, which
an agent cannot read at all (see #12). #6 is a tool-description change only, so there is nothing to
exercise beyond reading it.

---

## #12 — `oric_get_output` returns `(no output)` even with a live session — Fixed (0.0.66)

**ROOT CAUSE: the bridge never forwarded `output` events at all** — simpler than the flush
hypothesis, and it was never reachable-only-via-`oric_start_session`: it could never have worked.
The extension broadcast `stopped`, `continued`, `control`, `signal` and `ended`, but not `output`,
so the attached client's `case 'output'` handler (which does exist, and which the standalone DAP
path feeds) was never invoked and `session.dap.output` stayed empty forever.

**Fixed (both halves):**
- The debug-adapter tracker now forwards every `output` event over the bridge
  (`broadcast('output', { text, category })`).
- Your flush concern was real too and is handled: output goes into a 500-entry ring in the
  extension that **outlives attach**, and `bridge.hello` returns it as `outputBacklog`, which the
  client seeds into its buffer. So an agent that creates the session itself
  (`oric_start_session`) still gets the load-time symbol notes — which is exactly what **#10**
  needs to be verifiable.
- The ring is cleared on session start, so you never read the previous run's console.

**Observed:** called twice during a fully running collaborative session (once with the Intro module
active, once after several breakpoint stops), both times with `maxLines` set generously. Both
returned exactly `(no output)`.

**Impact:** the whole tool is non-functional from the agent side, and it takes #10 down with it —
the improved *"N C line entries exist in other modules [SplashProgram:1307, …]"* note lives in the
debug console, so **the fix for #10 cannot be validated by an agent at all**. More generally, an
agent cannot read logpoint / trace output, which is the cheapest possible instrumentation channel
for this codebase (no printf on an Oric).

**Possible causes (TBD):** does the bridge forward the adapter's own `output` events, or only
program-originated ones? Is there a ring buffer that is only populated on `stdout` from the
emulator? Note the load-time symbol note is emitted *before* the bridge attaches in an
agent-driven flow (`oric_start_session` creates the session), so an already-flushed buffer would
explain an empty result — in which case the buffer needs to outlive attach.

## #13 — `bp.list` still shows bare basenames, so distinct breakpoints render identically — Fixed (0.0.66)

Correct, and a fair hit: #2 fixed the resolution but left the reporting that had hidden it.
**Fixed:** `oric_list_breakpoints` now detects a repeated basename and, only for those rows, prints
the last three path segments (or the full path when shorter) — so session (a)'s debris on
`splash_main.c` is visibly distinct from `codesplash_main.c`, and the dead one can be targeted
with `oric_clear_breakpoints file+line`.

**Observed:** mid-session the list contained these two adjacent rows:

```
splash_main.c:236  [NOT BOUND — will never fire]
splash_main.c:236  [bound, not armed (module not resident)]
```

They are two *different* breakpoints: the first is session (a)'s debris on the bogus path
`\splash_main.c`, the second is the real one at `d:\Git\Encounter\code\splash_main.c`. Nothing in
the output distinguishes them.

**Impact:** this is the *same* display weakness that made #2's root cause invisible for a whole
session — #2 fixed the resolution but not the reporting. An agent seeing contradictory states on
what looks like one location has no way to tell which row is real, and cannot target the dead one.

**Fix:** disambiguate when two entries share a basename — show the workspace-relative path (or the
full path when it is outside the workspace). `oric_set_breakpoint` already returns full paths, so
the data is there; only `bp.list` truncates.

## #14 — every disabled breakpoint reports "NOT BOUND — will never fire" — Fixed (0.0.66)

Agreed — it asserted a verdict where only the checkbox was off, contradicting #9's own goal.
**Fixed:** a disabled entry now prints `[disabled (binding not evaluated)]` and **stops there** —
no bound/armed claim at all, since VS Code never sends a disabled breakpoint to the adapter.

**Observed:** all 17 of the human's saved, disabled breakpoints render as e.g.
`bytestream.s:110  [disabled; NOT BOUND — will never fire]`.

**Impact:** technically defensible (a disabled breakpoint is never sent to the adapter, so it has
no binding) but it reads as *broken* rather than *switched off* — and it contradicts #9's own
stated goal of reporting `enabled` / `bound` / `armed` **independently**. #9's example output was
`game_main.c:63  [bound, not armed (module not resident)]`; what we actually get for a disabled
entry is an alarming verdict about a breakpoint whose only problem is the checkbox. An agent
auditing this list would reasonably report 17 broken breakpoints to the human.

**Fix:** for a disabled entry print `[disabled]` alone, or `[disabled; binding not evaluated]` —
do not assert "will never fire" for something that would fire once enabled.

## #15 — numeric module ids leak into breakpoint messages — Fixed (0.0.66)

**Fixed:** the adapter's `breakpointStatus` now maps bucket ids through a `moduleLabel()` helper
(name when known, `resident` for `R`, `(none)` for null), so no internal index reaches a caller.
The message reads: *"not yet armed: it lives in module Splash, but the active module is Intro — it
will arm automatically when that module becomes resident"*.

**Observed:** `oric_set_breakpoint splash_main.c:236` returned

```
bound, not yet armed (pending: its module is not resident; active module is 1) [modules: 0]
```

**Impact:** `active module is 1` and `[modules: 0]` are internal bucket indices. The agent has to
guess that `1` is Intro and `0` is Splash — and `oric_module` was, in the same session, happily
returning `module: Intro`, so the names are available. (`[modules: R]` for resident is fine and
readable.)

**Fix:** map bucket ids back to module names in these messages: *"its module (Splash) is not
resident; active module is Intro"*.

## #16 — `oric_start_session` does not say which config it picked, or why — Fixed (0.0.66)

**Fixed:** the result now states the provenance and the behavioural consequence, e.g.
*Started "Build & Run" — remembered from the last launch of 3 (Build & Debug, Build & Run, Attach
to Oricutron). The machine starts RUNNING (stopOnAttach: false).* Provenance is one of: asked for
by name / the only config / remembered from the last launch / picked from N. (Landing on the
non-first config was indeed the remembered pick, not an accident.)

**Observed:** Encounter's `launch.json` has three `oric-debug` configs — `Build & Debug`
(`stopOnAttach: true`, first in the file), `Build & Run` (`stopOnAttach: false`), and
`Attach to Oricutron`. `oric_start_session` with no argument reported
*"Started the debug session (Build & Run)"* — i.e. **not** the first one.

**Impact:** it worked, and naming the config in the result is genuinely good. But the tool
description says *"the only/remembered oric-debug config"*, so with three configs present an agent
cannot tell whether it got the remembered one, an arbitrary one, or a heuristic pick — nor that
the choice carries a real behavioural difference (`stopOnAttach` decides whether the machine comes
up halted). Landing on the non-first config makes it look accidental.

**Fix:** state the provenance — *"Started 'Build & Run' (remembered from your last session; 3
configs available)"* — and/or note `stopOnAttach` in the result.

---

# Session 2026-07-26 — first agent-driven MCP session (Encounter, collaborative attach)

First real use of the `oric` MCP server by an AI agent (Claude) attached to a live VS Code
debug session via the collaboration bridge, debugging Encounter on OSDK 2.0. Findings #2–#11
below, most severe first.

**What already works well and should not regress:** `oric_attach` collaborative mode,
`oric_screenshot`, `oric_registers`, `oric_read_memory`, `oric_module` (correctly reported
`Splash`), `oric_run_to`, `oric_step_over`, `oric_run_frames`, `oric_watch_memory`, and
`oric_backtrace`. The backtrace in particular is excellent — 8 frames across an IRQ boundary
mixing assembly and C:

```
#0 _PsgSetRegister+$1A  audio.s:400
#1 register_loop+$5     audio.s:358
#2 _IrqCallback50hz     kernel_main.s:154
#3 bottom_advance       distorter.s:459
#4 _ContinueLogoAnimation+$47   distorter.s:354
#5 _DisplayLogosWithPreshift+$8D splash_main.c:236
#6 _main+$112           splash_main.c:292
#7 _LoaderResidentStart+$7  loader.asm:301
```

---

## #2 — `oric_set_breakpoint` accepts a breakpoint but never arms it — Fixed (0.0.65)

**ROOT CAUSE FOUND: the file was never resolved to a real path.** The agent passed a bare
basename (`splash_main.c`) — which the tool schema invited, saying only `file: string`. The
bridge's `bpSet` did `vscode.Uri.file(file)` **verbatim**, so VS Code created a breakpoint on a
non-existent file (`\splash_main.c`). Breakpoint binding matches **full paths**
(`resolver.cjs samePathLoose` = normalized full-path equality, NOT basename), so:
`fileToModules` had no entry → owners fell back to resident → `addrForLine` never matched →
zero bindings → never armed → never fired. And `bp.list` **displays only the basename**, so the
bogus entry looked perfectly correct — which is exactly why it read as "accepted but ignored".
The human's own gutter-set breakpoints were unaffected (real absolute paths), which is why only
agent-set ones failed.

**Fixed:**
- `resolveWorkspaceSourceFile()` — accepts an absolute path, a workspace-relative path, or a
  bare basename (workspace search, prefers a path-tail match); **ambiguous or not-found now
  fails loudly** with candidates instead of silently creating a dead breakpoint.
- `oric_set_breakpoint` reports the **real** state from the adapter (see #8) instead of an
  optimistic message.



**Observed:** Set `splash_main.c:236` and `audio.s:400`. Both returned
`"added to the shared panel (binds when its module is loaded)"` and appeared in
`oric_list_breakpoints`. Neither ever fired. `audio.s:400` is inside `_PsgSetRegister`,
which executes many times per frame while audio plays; 206 frames were run and execution
stopped only on the frame limit, never on the breakpoint.

**Evidence that execution control itself is fine:** in the same session,
`oric_run_to _PsgSetRegister` reached it immediately, and a write watchpoint on `$0039`
(`_SoundPsgTemp`, written by that very routine) fired after **2 frames** with
`stopped (data breakpoint) at _PsgSetRegister+$10 audio.s:394`. So the stop machinery
works; only source-breakpoint arming is broken.

**Impact:** the highest-value primitive for an agent is unusable. Workarounds today are
`oric_run_to` (one-shot, symbol/address only) and `oric_watch_memory`. Neither replaces a
conditional source breakpoint.

**Possible fixes (TBD):** does the panel entry ever reach the adapter's `setBreakpoints`
for the *active* module, or does it sit in the "pending until module loads" queue forever
when the module is already loaded? Note the module was `Splash` and `splash_main.c` is a
Splash file, so "waiting for its module" should not have applied. See also #9 — the C-side
may fail for a different reason (no `.c` line records) than the assembly side.

## #3 — VS Code steals window focus on every stop, even when an agent caused it — Fixed (0.0.65)

**ROOT CAUSE: our own code, not a VS Code setting.** `autoNavigateFromFrame()` opened the
frame's source with `showTextDocument(..., preserveFocus: false)` on **every** stop, which
actively takes focus (and raises the window).

**Fixed:** new setting **`oric-debug.focusOnStop`** = `human` (default) | `always` | `never`.
Default `human` still reveals the source line but uses `preserveFocus: true` whenever
`aiIsPiloting()` — so an agent can stop hundreds of times without hijacking the machine, while
your own stepping behaves as before.

**Validated in session (b):** human-confirmed across 4 agent-caused stops — no focus loss observed.



**Observed (user-reported):** every stop pulls the VS Code window to the foreground. When
an agent is driving, stops happen constantly and the machine becomes unusable for anything
else.

**Possible fixes (TBD):** suppress focus/reveal when the stop originates from MCP or
automation rather than a human action — e.g. pass a "no focus" hint on the stopped event
for agent-initiated stops, or a setting `oric.debug.focusOnStop: always|human|never`.

## #4 — "Attached but no debug session" is an ambiguous half-state — Fixed (0.0.65)

**Fixed:** `oric_status` now detects attached-but-no-session (via `bridge.hello` → `hasSession`)
and returns *"attached to VS Code, but NO debug session is running — the human must press F5 …
only oric_screenshot works; reads/stepping return NO_SESSION"* instead of `running`.
`oric_attach` now **leads** with that blocker (and points at `oric_start_session`, #5) instead of
trailing a soft note. `requireSession()` no longer says "call oric_launch first" when attached.

**Observed:** before pressing F5, `oric_attach` **succeeded**
(`"Attached to the live VS Code session (oric-debug)"`, with only a soft note that the
human should press F5), and `oric_status` returned **`running`**. `oric_screenshot` also
worked and returned a real frame. But `oric_pause`, `oric_read_memory` and friends all
failed with `ERROR: NO_SESSION: no active oric-debug session`.

**Impact:** an agent reasonably concludes the server is broken rather than "the human has
not started the debugger". Screenshots working while reads fail makes it worse.

**Possible fixes (TBD):** `oric_status` should return a distinct state such as
`attached, no debug session (press F5)` instead of `running`, and `oric_attach` should make
the missing session prominent in its result rather than a trailing note.

## #5 — No way for an agent to start a debug session — Fixed (0.0.65)

**Fixed:** new **`oric_start_session`** tool → bridge `session.start` → the extension's existing
`startOricDebugSession()`, i.e. it runs **the human's own launch config** ("press F5 for me") so the
*shared* session comes up. No-op if one is already running; not control-gated (it creates a session
rather than driving one). `oric_launch`'s description now warns it is standalone-only and breaks
collaboration.

**Observed:** there is no "press F5" equivalent. The only session-creating tool is
`oric_launch`, which spawns a **separate** emulator on another port — which defeats the
entire point of collaboration: the human is then stuck with the bare Oricutron debugger
window instead of the VS Code UI, and the two sides no longer share screen, breakpoints, or
CPU.

**Possible fixes (TBD):** an `oric_start_session` that triggers the workspace's existing
launch configuration in the human's VS Code, so the shared session comes up. Failing that,
document clearly that the human must F5 first and that `oric_launch` is for standalone use
only — the current tool description does not warn an agent away from it.

## #6 — `oric_launch`'s documented port advice always collides — Fixed (0.0.65)

**Fixed:** the description now states each session binds a **pair** (gdb `port`, viz `port`+1) and
to offset by **+2** per session (human on 6510/6511 → agent 6512, then 6514).

**Observed:** the description says *"set `port` to the human base gdb port + 1 so this agent
runs its own emulator"*. But each Oricutron session binds **two** ports: gdb and viz at
gdb+1 (base 6510 → `GDB: 6510`, `VIZ: heatmap server listening on port 6511`). So base+1 is
already taken by the human's viz server.

**Fix:** advise base **+2** (and note that each session consumes a pair). Confirmed by
`Get-NetTCPConnection`: one emulator pid held both 6510 and 6511.

## #7 — `oric_evaluate` dereferences code labels, and there is no address-of — Fixed (0.0.65)

**Fixed:** the adapter's `evaluate` now supports **`&sym`** — address only, no dereference — with
the same C↔asm underscore fallback as "Go to: symbol":
`&_KernelEndText` → `$143A (5178)  address of _KernelEndText`. Unknown names give a clear
"Unknown symbol". (Auto-suppressing the value for `.text` labels was NOT done: it needs a reliable
code/data distinction, and `&sym` covers the need explicitly.)

**Observed:** `oric_evaluate _KernelEndText` returned
`_KernelEndText = $0000|0  uint  @ $143A`. `_KernelEndText` is a `.text` marker label; the
meaningful value is its **address** ($143A), not the two bytes of code stored there. The
`@ $143A` suffix is correct and useful, but the headline value is noise.
`oric_evaluate &_KernelEndText` fails with
`ERROR: Unrecognized: '&_KernelEndText'`, so there is no way to ask for an address.

**Possible fixes (TBD):** support `&sym`; and/or print address-only (no dereference) for
symbols in `.text`, since a code label has no meaningful "value".

## #8 — `set_breakpoint`'s contract over-promises verification — Fixed (0.0.65)

**Fixed:** new adapter custom request **`breakpointStatus`** reports, per source breakpoint,
`bound` (line resolved to >=1 address) and `armed` (a Z0 live in the emulator now), plus its
modules/addresses. `oric_set_breakpoint` now returns the truth: *bound and ARMED (live)*, or
*bound, not yet armed (its module is not resident)*, or an explicit **NOT BOUND — it will never
fire as-is** with the likely causes. Description corrected to match.

**Observed:** the tool description states *"Returns whether it bound (verified)"*. The
actual return is `"added to the shared panel (binds when its module is loaded)"` with no
verified flag. Combined with #2, an agent cannot distinguish success from silent failure —
which is exactly what happened.

**Fix:** return the real bound/verified state, or correct the description.

## #9 — `oric_list_breakpoints` exposes no armed/verified state — Fixed (0.0.65)

**Fixed:** `bp.list` joins VS Code's panel entries with `breakpointStatus`, so each row shows
`enabled` / `bound` / `armed` independently, e.g. `splash_main.c:236  [armed]` vs
`game_main.c:63  [bound, not armed (module not resident)]` vs `foo.c:12  [NOT BOUND — will never fire]`.

**Observed:** the human's pre-existing entries render as `bytestream.s:110  (disabled)`;
newly added ones render bare (`splash_main.c:236`). There is no way to tell
enabled-and-bound from enabled-but-not-armed.

**Fix:** report per-breakpoint `enabled` and `verified` separately.

## #10 — C breakpoints unavailable despite `-g1` already being set — Fixed (0.0.65, the message was wrong)

**ROOT CAUSE: a false alarm — `-g1` is fine and the C line records exist.** Verified in Encounter's
build: `symbols_ext_SplashProgram` lists `codesplash_main.c` in `#FILES` with **1307 `#LINES`
entries**; the combined file has 5 `.c` files / ~35k line entries.

The reported *"2360 line entries (0 from .c)"* is the **resident scope only** (Loader+Kernel ≈ 2362
lines, 100% assembly): `lineTable` is the **composed view** (resident + *active* module), and at
symbol-load time no overlay is active yet. Encounter's C files all live in overlay modules, so
"0 .c here" is normal — blaming `-g1` sent the session hunting a non-existent build problem.

**Still unvalidated as of session (b):** the new message could not be read — `oric_get_output`
returns `(no output)`, so an agent has no access to the debug console at all. See #12.

**Fixed:** the load-time note now counts `.c` entries across **all** module buckets and says where
they are — *"… in the active view (all assembly); N C line entries exist in other modules
[SplashProgram:1307, GameProgram:…] — C breakpoints bind once that module is resident"* — and only
suggests `-g1` when **no** module has any. `unboundBpMessage()` got the same treatment, so a C
breakpoint in an inactive overlay no longer claims a missing `-g1`.

**Observed:** the debug console reports
`Loaded 511 symbols, 2360 line entries (0 from .c — rebuild with -g1 to enable C
breakpoints; 2360 from assembly)`. But Encounter's `osdk_config.bat` already sets
`SET OSDKCOMP=-O2 -g1`. So either the C line records are not reaching
`symbols_ext_combined`, or the hint is stale and misidentifies the real cause.

**Possible fixes (TBD):** likely toolchain-side — check the `.csource` / `#LINES` emission
path for C modules. Related to the OSDK debug-symbol-export work.

## #11 — `oric_clear_breakpoints` cannot clean up after an agent — Fixed (0.0.65)

**Fixed:** `oric_clear_breakpoints` now takes **`file` + `line`** to remove exactly one breakpoint
(bridge `bp.clearAll` accepts `line`), so an agent can undo only what it added. The description now
warns that omitting `file` destroys the human's breakpoints too, and recommends file+line.

**Observed:** in collaborative mode the breakpoint list *is* the human's VS Code panel. An
agent that adds breakpoints has no way to remove only its own — `oric_clear_breakpoints`
removes all, which would have destroyed the human's 17 saved (disabled) breakpoints. Two
agent breakpoints were therefore deliberately left behind in this session.

**Fix:** per-breakpoint removal (by file:line or id), and/or "clear only breakpoints this
session added".

---

## #1 — Call-stack frame lands on the wrong symbol at an aliased address — Fixed

**Fixed** by the single-source-of-truth resolver (`resolver.cjs`, `SPEC-address-resolver.md`),
wired into `makeFrame`. User-verified: `jmp _LoaderResidentStart` now stays in `loader.asm` on the
real `jsr _LoadData` (`loader.asm:150`) instead of `kernel.s:734`. Validated by two independent
implementations (resolver + Fable oracle) — exact-address golden 412/412 across 7 views + 7/7
nearest-below cases. Other consumers (inline annotation, disassembly labels, breakpoint binding)
still migrate next (SPEC §7 steps 3–6).


**Observed:** Stepping in `loader.asm`, line 137 `jmp _LoaderResidentStart` correctly
jumps to `$FD40` (`_LoaderResidentStart`) — Oricutron shows `$FD40`, and the VS Code
**Oric Disassembly** view correctly shows `FD40 / _LoaderResidentStart`. But the
**Call Stack** shows `_LoaderResidentStart — kernel.s (734)`, and line 734 is actually
`_OverlayBufferEnd`, a *different* symbol that happens to sit at the same address
`$FD40`. So the source navigation jumps to the wrong line.

Context: all done at `Module: (none)`, which otherwise worked great — labels,
expressions, and the inline value annotation all resolved correctly.

**Root cause:** `makeFrame()` in `debug_adapter.js` resolves a frame's *name* and its
*source line* through two independent tables:
- name = `labelFor(addr)` → `addrSym` map → picks `_LoaderResidentStart` (correct)
- line = `sourceFor(addr)` → `#LINES` `lineTable` → picks `kernel.s:734` (`_OverlayBufferEnd`)

At an address shared by multiple symbols, the two paths disagree. Aggravated by the
resident/overlay model: `_LoaderResidentStart` *runs* at `$FD40`, but the only clean
`#LINES` entry at that exact address is the coincidental data/boundary label
`_OverlayBufferEnd`. The line-table dedup (keep last entry per address) can also favor
the wrong alias.

**Possible fixes (TBD):**
- Align the two resolutions: when choosing the source line, prefer a `lineTable` entry
  whose owning symbol matches the name `labelFor()` chose.
- Prefer a line entry that begins an executable run over a data/boundary label at the
  same address (needs a code/data distinction).
- Don't emit `#LINES` entries for pure data/boundary labels during build.

Related: resident/overlay symbol model, [[osdk-module-structure]].

---
