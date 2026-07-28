# Annotations & navigation

The `@…` comment annotations that drive typed decoding, the inline cycle/operand
annotations, and hover / go-to-definition.

---

## Inline Annotations

### Cycle Annotations

When stopped at a breakpoint, cycle count annotations appear inline next to source lines that map to executed instructions.

### Instruction Operand Annotations

On each debug stop, the current source line is annotated with the resolved operand values of the instruction about to execute. This shows the effective address and memory contents without needing to check registers manually.

Examples:
- `lda #$41` → `#$41 (65)`
- `sta $80` → `(tmp1=$80)=$3F`
- `sta ($50),Y` → `(*(ptr=$50)=$A398+Y:$02)=$A39A`
- `beq label` → `→$0450 [taken]` or `→$0450 [not taken]`

All 6502 addressing modes are supported: immediate, zero page, zp+X, zp+Y, absolute, abs+X, abs+Y, (indirect,X), (indirect),Y, indirect, and relative branches (with taken/not-taken status).

---

## Type Annotations (comment-based)

Add lightweight annotations inside ordinary comments to tell the debugger how to interpret a
value. They are pure comments — `//` in C (`.h`/`.c`), `;` in assembler (`.s`) — so they never
change the built program and every compiler/assembler ignores them. They work on **C globals, C
struct fields, and assembler data labels** (`.byt`/`.dsb`); the extension scans your headers and
sources for them at session start.

| Annotation | Shows | Example |
|---|---|---|
| `@bool` | `true` / `false` (0 = false, non-zero = true) | `unsigned char music_enabled; // @bool` |
| `@enum <E>` | the enumerator name for the value | `unsigned char layout; // @enum KeyboardLayout` |
| `@enum <E1>\|<E2>` | fallback chain for union holders: the first enum that defines the value wins | `_gWordBuffer .dsb 3 ; @enum word_id\|item_id` |
| `@bitset <E>` | the set bits decoded to a list of enum names | `_gAchievements .dsb 7 ; @bitset achievement` |
| `@ptr16` | the 16-bit pointer and what it currently points to | `sourcePtr = tmp0 ; @ptr16` |
| `@ptr16 <struct>` | typed pointer: expandable pointed-to struct; `(ptr),y` disassembly names the FIELD the Y offset hits and decodes it with the field's type | `_gStreamItemPtr .dsb 2 ; @ptr16 item` |
| `@bcd` / `@bcd-be` / `@bcd-le` | packed BCD decoded to a readable number | `current_score_bcd .dsb 2 ; @bcd-be` |
| `@str [term]` | terminated string at the symbol (terminator byte in decimal, default 0) | `_Text_Title ; @str 255` |
| `@strptr [term]` | 16-bit pointer to a terminated string | `textPtr .dsb 2 ; @strptr 255` |
| `@stream <E>` | a 16-bit pointer into a byte-code stream whose opcodes are enum `<E>`; expands to the next decoded commands with typed parameters | `_gCurrentStream .dsb 2 ; @stream script_command` |
| `@params <t>…` | on an enum MEMBER: the byte-stream parameters that opcode consumes (drives `@stream`) | `COMMAND_WAIT = 6, // @params byte` |

Notes:
- `@enum` / `@bitset` name a C `enum` type (the OSDK compiler emits enum info under `-g1`, and XA
  supports `enum {}` in shared C/asm headers). `@bitset` decodes bit *P* as byte `P>>3`, bit `1<<(P&7)`.
- `@bcd-be` (default, and the plain `@bcd` alias) = most-significant byte at the lowest address;
  `@bcd-le` = least-significant first. An explicit width may follow, e.g. `@bcd-be 3` for a 3-byte value.
- `@str` / `@strptr` take the terminator as a DECIMAL byte value (no implicit hex): plain
  NUL-terminated text needs no argument; attribute-laden text where 0 is a valid byte (ink codes)
  uses its end marker, e.g. `@str 255` for `TEXT_END`. Non-printable bytes render as dots.
  Plain `*char` / `char*` variables and struct fields show their NUL-terminated string automatically.
- On a CODE line, three directives type what an indexed/indirect read fetches (handy for reads
  with no per-symbol type, e.g. inside a byte-stream handler):
  - `; @enum <E>` — the fetched byte, decoded as enum `<E>` (also tags the destination register
    when single-stepping);
  - `; @word` — the 16-bit little-endian word at the read address, plus the symbol it points to
    (e.g. a jump target: `$7875 →end_girl_following`);
  - `; @stream <E>` — that word treated as a stream pointer, showing the target's first command.
  An explicit code-line directive overrides the pointer's own `@stream`/`@ptr16` typing.
- An `@enum` on a multi-byte symbol (a `.dsb` buffer) decodes each byte separately:
  `gWordBuffer → [e_WORD_TAKE, e_ITEM_Meat, ...]`. Chains resolve per byte, so mixed
  word/item buffers show the right names as long as the enums' value ranges don't overlap.
- `@stream <E>` visualizes a byte-code stream: watching the pointer expands to the next
  commands, each shown as `COMMAND_NAME(param, param, …)` with parameters decoded by their
  `@params` types. Each `@params` token is an enum type name, `byte`, `word` (16-bit LE),
  `str` (inline NUL-terminated string), or `end` (a terminator/jump that stops the linear
  preview). A member with no `@params` (or an unknown opcode) stops the walk. `@params`
  comments must contain ONLY tokens and must match the byte layout the engine consumes,
  or the walk desyncs. Edit one and reparse (no rebuild) to see it live.
- Annotated values render consistently in the Watch/Variables views, the Symbol Browser, and inline
  in the disassembly — each shows the decoded value plus a short type token (e.g. `bool`, the enum
  name, `bcd-be`).

---

## Code Navigation

### Hover Information

Hover over a symbol name or `#define` constant in the editor to see:
- Address and size
- Current value (during debug)
- Aliases (other names at the same address)
- Source file and line where it's defined

Also works for hex addresses written as `$HHHH` in source code.

### Go to Definition

**Ctrl+Click** or **F12** on a symbol name or `#define` constant to jump to its definition in the source code.

Requires either a V2 symbol file (with source location info) or a `#define` directive in a workspace source file.

---

[← Documentation index](README.md) · [Extension README](../README.md)
