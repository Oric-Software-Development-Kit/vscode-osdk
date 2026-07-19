'use strict';
/*
 * oric-keys — the SINGLE (JS) source of truth for Oric key-injection ids.
 *
 * These portable ids are the uplink contract with the emulator: viz_map_key() in
 * viz_stream.c decodes them (0x20–0x7e pass through as ASCII/SDLK; 0x80+ are named
 * specials → SDLK_*). Every JS producer of key events imports THIS table instead of
 * hardcoding numbers:
 *   - the automation runner (mcp/playthrough-core.cjs) — press()/type(),
 *   - the Oric Screen View webview — the extension injects KEYS into the page,
 * so a key id is defined in exactly one JS place. The only other copy is viz_map_key on
 * the far side of the socket (a different binary — it can't literally share this), so it
 * is the protocol contract: keep the two in sync. (RSHIFT/RCTRL/FUNCT etc. aren't in the
 * uplink yet — add them to viz_map_key AND here together if a game needs them.)
 */
const KEYS = {
    UP: 0x80, DOWN: 0x81, LEFT: 0x82, RIGHT: 0x83, RETURN: 0x84, ENTER: 0x84,
    ESC: 0x85, ESCAPE: 0x85, SPACE: 0x86, BACKSPACE: 0x87, DEL: 0x87,
    SHIFT: 0x88, LSHIFT: 0x88, CTRL: 0x89, LCTRL: 0x89, TAB: 0x8b,
};

// name / single char / number → portable id, or null if unknown (each caller decides
// whether null is an error). The leading 'KEY_' and case are ignored, so 'KEY_RETURN',
// 'RETURN' and 'Enter' all resolve. A single printable char is its ASCII code; a
// '$hex'/'0x..'/decimal string parses.
function keyId(k) {
    if (typeof k === 'number') return k & 0xff;
    const raw = String(k);
    // A single character is its ASCII code — checked BEFORE trimming so ' ' (space, 0x20)
    // and other printable keys survive (trimming a space would leave an empty string).
    // Map A-Z to a-z: the uplink keys on the PHYSICAL Oric key (SDL letter keysyms are
    // lowercase), and the game lowercases text input itself — so 'TAKE BAG' types fine.
    if (raw.length === 1) {
        let c = raw.charCodeAt(0);
        if (c >= 0x41 && c <= 0x5a) c += 0x20;
        return c >= 0x20 && c < 0x7f ? c : null;
    }
    const s = raw.trim();
    if (/^(\$|0x)/i.test(s)) return parseInt(s.replace(/^\$/, '').replace(/^0x/i, ''), 16) & 0xff;
    if (/^\d+$/.test(s)) return parseInt(s, 10) & 0xff;
    const norm = s.replace(/^KEY_/i, '').toUpperCase();
    return norm in KEYS ? KEYS[norm] : null;
}

module.exports = { KEYS, keyId };
