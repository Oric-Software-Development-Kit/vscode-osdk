# SPEC — Byte-stream visualizer (`@stream` / `@params`)

Status: SCRIPT STREAM IMPLEMENTED 2026-07-15 (Opus session), user-testing pending.
Audio stream (`_SoundDataPointer`) DEFERRED by user decision (its opcodes carry flag
bits — SOUND_FLAG_END OR'd on — plus a 14-byte SET_BANK payload and REPEAT/ENDREPEAT
blocks, which need masking + block handling beyond `@params`; revisit later).

What shipped for the script stream:
- COMMAND_* -> `typedef enum {...} script_command` in scripting.h (byte-identical build).
- `@stream <E>` on a pointer symbol + `@params <tokens>` on each enum member.
  Tokens: enum-name / `byte` / `word` (16-bit LE) / `str` (inline NUL-terminated) /
  `end` (terminator or jump: stops the linear preview after this command).
- Adapter: paramsByEnumMember map (built by parseAnnotations scanning enum bodies),
  decodeStream()/decodeStreamParam(), formatAnnotated 'stream' branch (expandable ref),
  varRefs 'stream' expansion listing `+offset  COMMAND_NAME(params…)`. ANN regex adds
  `stream`. Reuses formatEnum/formatScalar/formatCharArray (no 2nd render path).
- `_gCurrentStream .dsb 2 ; @stream script_command` in bytestream.s.
- Grammar extracted from bytestream.s handlers (subagent) + scripting.h macros.
  KEY: inline stream strings are NUL(0)-terminated (macros append ,0), NOT 255.
  BITMAP reads 7 bytes (byte byte byte word word) despite the 3-arg macro comment.
  JUMP/JUMP_IF/BUBBLE marked `end` (jumps leave; JUMP_IF condition + BUBBLE repeat-count
  are variable — v1 shows the command and stops rather than risk desync). COMBINE=4 bytes.
- Harness `<scratchpad>/verify_stream.js` PASS (plants a stream, expands, checks decode).
- UNCOMMITTED as of this note (awaiting user live test).
Possible follow-ups: decode JUMP_IF operator sub-grammar; repeat-count for BUBBLE; the
inline `(stream),y` disasm annotation (SPEC "Rendering" bullet 2) not done — only the
tree view. Then the audio stream.

--- Original design below (still accurate for the mechanism) ---

Prerequisite work (words/directions enums + `@enum a|b` chains) done the same day.

## Goal

VS-style custom visualizers for project-defined byte-code streams — Encounter has two:
the game scripting language (`_gCurrentStream`, engine `_PlayStreamAsm` in bytestream.s,
opcodes `COMMAND_*` in scripting.h) and the audio player's stream. Watching a stream
pointer should show the DECODED next commands with named parameters, not raw bytes.
The mechanism must be project-agnostic: projects declare their grammar via annotations;
the extension knows nothing about any specific language.

## Design (agreed with user)

Two annotations, both scanned by the EXISTING annotation scanner (parseAnnotations —
it already reads sibling .h files and asm label lines):

1. **`@params <t1> <t2> …`** on each enum MEMBER's trailing comment describes that
   command's parameter list. Grammar lives next to the definitions — can't drift.

```c
typedef enum {
    COMMAND_SET_LOCATION_DIRECTION = 12,  // @params location_id direction_id location_id
    COMMAND_GIVE_ITEM              = 13,  // @params item_id
    COMMAND_PRINT_TEXT             = 14,  // @params str255
} script_command;
```

   Parameter-type vocabulary = what the adapter already renders (one render path):
   any enum name (1 byte, decoded by name, `a|b` chains allowed), `byte`, `word`
   (16-bit LE), `strptr` (2-byte ptr to NUL string), `str` / `str255` (INLINE
   terminated string, terminator decimal like @str), plus `bcd-be N`/`bcd-le N` if
   ever needed. No @params on a member = unknown length → decoding stops there with
   a "(unknown params)" tail rather than guessing.

2. **`@stream <E>`** on the pointer symbol (asm label or C global) opts it in:
   "16-bit pointer into a byte stream whose opcodes are enum `<E>`".

```asm
_gCurrentStream .dsb 2   ; @stream script_command
```

## Rendering

- **Watch / Variables / Symbol Browser watch section** (all via buildTypedVar — do NOT
  add a second render path): value shows `*script_command → $4A21`; expandable. Children
  = the next N decoded commands (N≈8, stop early at end-marker/unknown):
  `COMMAND_GIVE_ITEM(e_ITEM_Rope)` — each command expandable into parameters, each
  parameter rendered through formatScalar/formatAnnotated so enums/strings/chains decode
  normally. Give each child a stableRef keyed by (streamAddr, cmdOffset) for tree stability.
- **Inline disasm annotation** (resolveInstruction ')' case, generalizing the @ptr16
  field trick): on `lda (_gCurrentStream),y`, walk the grammar from the stream position
  to identify WHICH parameter of WHICH command byte Y points at:
  `(_gCurrentStream→COMMAND_SET_LOCATION_DIRECTION.param1 direction_id)=e_DIRECTION_UP`.
  v1 caveat: the pointer usually advances as the engine consumes — position = pointer
  value + Y; that's exactly what the engine reads, so no extra state needed.
- **Register tagging** (tagForLoad ')' branch): when the identified parameter type is an
  enum, tag the destination register with it — same as @ptr16 fields today.

## Implementation pointers (adapter = debug_adapter.js unless said)

- `parseAnnotations`: ANN regex currently `/@(bool|enum|bitset|ptr16|bcd(?:-[bl]e)?|strptr|str)\b\s*([\w|]+)?/`
  → add `stream` to the alternation (before `str`! alternation is first-match, and
  `strptr` before `str` for the same reason — put `strptr|stream|str`). `@params`
  needs its OWN scan: when walking enum bodies... note the CURRENT enum-def parser
  (the thing that builds enumDefs/allEnumDefs from .ctype records) does NOT see header
  comments — .ctype comes from the compiler. So @params must be captured by the
  HEADER SCAN side: extend the header scanner to notice `@params …` on lines inside a
  `typedef enum { … } name;` body and record `paramsByEnumMember: Map<'enumName.MEMBER',
  string[]>` (store by enum name + member name; values resolved via enumDefs at decode
  time). Asm-shared headers are already scanned line-by-line — reuse that pass.
- New `decodeStream(addr, enumName, maxCmds)` → `[{offset, cmdName, cmdValue, params:
  [{type, value(rendered), size}], size}]`; total size accumulation gives next offset.
  Read memory in ONE readMem chunk (e.g. 64 bytes) — per-stop cache makes this cheap.
- `formatAnnotated`: new `ann.kind === 'stream'` branch → pointer render + stableRef
  `{kind:'stream', addr:target, enumName}`; `variablesRequest` varRefs branch expands it
  (mirror the 'bitset' expansion branch structure).
- End-of-stream: stop at a command byte with no enumerator AND no @params, or after
  maxCmds. Encounter likely has explicit end commands (FLAG_* stream-end group in
  scripting.h — ask user / check engine); render those and stop after them.
- README annotation table: add `@stream <E>` + `@params` rows.

## Open questions for the user (ask before/while implementing)

1. Variable-length commands: any whose payload length depends on a parameter value
   (counts, inline blobs)? If yes → add a `len:<paramIdx>` token or similar.
2. Exact end-of-stream marker(s) for script and audio streams.
3. Audio stream: byte-opcode-based like the scripts, or packed bit fields? (Bit fields
   would need more than @params — punt v1 to scripts only if so.)

## Sequence (do in this order)

1. FIRST finish/commit the words+directions wave (see memory RESUME file — it is
   UNCOMMITTED, mid-user-testing as of 2026-07-15 evening; gWordBuffer chain confirmed
   working by the user; commit gate = user says commit).
2. Convert `COMMAND_*` (scripting.h, 52 members incl. `_COMMAND_COUNT`=51 sentinel) →
   `typedef enum {...} script_command` with the PROVEN byte-identical method (baseline
   build → convert → rebuild → sha1 diff excluding floppy_description.h; recipe in
   memory resume-encounter-enum-conversion.md). This alone makes script bytes readable.
   Also candidates in the same header: OPERATOR_* (5), SOUND_COMMAND_* (9), FLAG_* (4).
3. Add `@params` comments to scripting.h members (get parameter lists from the
   `_PlayStreamAsm` dispatcher in bytestream.s — each `_ByteStreamCommand_*` handler's
   `lda (_gCurrentStream),y` sequence + the final `lda #N` consumed-bytes count is the
   ground truth; several sites are ALREADY annotated with @enum from earlier waves).
4. Implement `@stream`/`@params` in the adapter; annotate `_gCurrentStream .dsb 2` in
   bytestream.s (check exact decl site/zero page).
5. Harness-verify (pattern: scratchpad verify_words.js — port 6511, setActiveModule
   Game first, console `w $addr val` writes now invalidate the read cache correctly).
6. Audio stream second, after the user answers Q3.

## Conventions that bind this work

- One render path (buildTypedVar) — no bespoke formatting in handlers.
- No implicit hex; terminators/values in annotations are decimal.
- Commit only after user tests; source only; per element. Encounter work on branch
  feature/debug-multimodule; do NOT touch E:\git\oricutron (other instance's lane).
- Webview changes (if any) validated as-delivered (scratchpad check_symbols_webview.js).
