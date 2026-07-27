import { describe, it, expect, beforeEach } from 'vitest';
import { GuacRdpKeyboard, KeySource, type GuacRdpKeyboardSink } from './GuacRdpKeyboard';

// Server-half unit tests: feed X11 keysyms (as the client half would) and assert the exact scancode /
// Unicode stream the guest receives. This is the guacd keyboard.c state machine in isolation, so the
// terminal-critical behaviours (lazy Shift reconciliation, AltGr drop on the en-US pin, reset on
// all-released) are verified deterministically, without browser-event simulation.

// Scancodes from the ported keymap.
const SHIFT_L = 0x2a;
const SHIFT_R = 0x36;
const CTRL_L = 0x1d;
const D1 = 0x02;
const D2 = 0x03;
const D3 = 0x04;
const D4 = 0x05;
const D5 = 0x06;
const KEY_A = 0x1e;
const KEY_B = 0x30;
const KEY_C = 0x2e;
const KEY_V = 0x2f;
const SLASH = 0x35;
const META_L = 0xe05b;
const ALT_R = 0xe038;

// Keysyms.
const KS_LSHIFT = 0xffe1;
const KS_LCTRL = 0xffe3;
const KS_RALT = 0xffea;
const KS_ALTGR = 0xfe03;
const KS_META_L = 0xffe7;

type Event = { kind: 'key'; value: number; pressed: boolean } | { kind: 'uni'; value: number };

function recorder() {
    const events: Event[] = [];
    const sink: GuacRdpKeyboardSink = {
        sendScancode: (scancode, pressed) => events.push({ kind: 'key', value: scancode, pressed }),
        sendUnicode: (codepoint) => events.push({ kind: 'uni', value: codepoint }),
    };
    return { events, sink };
}

// Replay the recorded key stream and report whether Shift is held on the guest at the moment the given
// scancode is first pressed -- i.e. whether the guest resolves it as base char or shifted symbol.
function shiftDownWhenPressed(events: Event[], targetSc: number): boolean {
    let shift = 0;
    for (const e of events) {
        if (e.kind !== 'key') continue;
        if (e.value === SHIFT_L || e.value === SHIFT_R) shift += e.pressed ? 1 : -1;
        else if (e.pressed && e.value === targetSc) return shift > 0;
    }
    return false;
}

function keyEvents(events: Event[]): [number, boolean][] {
    return events.filter((e) => e.kind === 'key').map((e) => [e.value, e.pressed]);
}

describe('GuacRdpKeyboard: keysym -> scancode + lazy modifier reconciliation', () => {
    let kbd: GuacRdpKeyboard;
    let events: Event[];

    beforeEach(() => {
        const r = recorder();
        events = r.events;
        kbd = new GuacRdpKeyboard(r.sink);
    });

    function down(keysym: number) {
        kbd.updateKeysym(keysym, true, KeySource.Client);
    }
    function up(keysym: number) {
        kbd.updateKeysym(keysym, false, KeySource.Client);
    }
    function tap(keysym: number) {
        down(keysym);
        up(keysym);
    }

    it('plain digit "1" (no shift) -> Digit1 down/up, no Shift', () => {
        tap(0x31);
        expect(keyEvents(events)).toEqual([
            [D1, true],
            [D1, false],
        ]);
    });

    it('AZERTY Shift-held "12345" run: Shift released once before the first digit, NEVER re-pressed', () => {
        down(KS_LSHIFT);
        for (const ks of [0x31, 0x32, 0x33, 0x34, 0x35]) {
            tap(ks);
        }
        up(KS_LSHIFT);

        // Each digit lands with no guest Shift -> "12345", not "!@#$%".
        for (const sc of [D1, D2, D3, D4, D5]) {
            expect(shiftDownWhenPressed(events, sc)).toBe(false);
        }
        // Shift pressed exactly once (the physical press) and released exactly once (reconciled away
        // before Digit1); never toggled per digit.
        const shiftPresses = events.filter((e) => e.kind === 'key' && e.value === SHIFT_L && e.pressed).length;
        const shiftReleases = events.filter((e) => e.kind === 'key' && e.value === SHIFT_L && !e.pressed).length;
        expect(shiftPresses).toBe(1);
        expect(shiftReleases).toBe(1);
    });

    it('CONTINUOUS hold "1A" -> "1", then "A": digit drops guest Shift, capital re-presses it', () => {
        down(KS_LSHIFT);
        tap(0x31); // "1"
        tap(0x41); // "A"
        up(KS_LSHIFT);
        expect(shiftDownWhenPressed(events, D1)).toBe(false); // "1", not "!"
        expect(shiftDownWhenPressed(events, KEY_A)).toBe(true); // "A", not "a"
    });

    it('CONTINUOUS hold "A1B" -> capital, digit, capital across one Shift hold', () => {
        down(KS_LSHIFT);
        tap(0x41); // A
        tap(0x31); // 1
        tap(0x42); // B
        up(KS_LSHIFT);
        expect(shiftDownWhenPressed(events, KEY_A)).toBe(true);
        expect(shiftDownWhenPressed(events, D1)).toBe(false);
        expect(shiftDownWhenPressed(events, KEY_B)).toBe(true);
    });

    it('"@" with no physical Shift: Shift tapped around Digit2, released on all-keys-up (reset)', () => {
        down(0x40); // "@"
        up(0x40);
        expect(keyEvents(events)).toEqual([
            [SHIFT_L, true],
            [D2, true],
            [D2, false],
            [SHIFT_L, false],
        ]);
    });

    it('US "!" with Shift already held: Digit1 sent WITH Shift, no per-key toggling', () => {
        down(KS_LSHIFT);
        tap(0x21); // "!"
        expect(shiftDownWhenPressed(events, D1)).toBe(true);
        // Shift pressed once (the physical press) and NOT toggled around the key: the char already
        // needs the Shift that is held, so update_modifiers is a no-op.
        expect(events.filter((e) => e.kind === 'key' && e.value === SHIFT_L && e.pressed).length).toBe(1);
        expect(events.filter((e) => e.kind === 'key' && e.value === SHIFT_L && !e.pressed).length).toBe(0);
        up(KS_LSHIFT);
    });

    it('Ctrl+C: Ctrl held by its own keysym, "c" sent plain -> Ctrl+C', () => {
        down(KS_LCTRL);
        tap(0x63); // "c"
        up(KS_LCTRL);
        expect(keyEvents(events)).toEqual([
            [CTRL_L, true],
            [KEY_C, true],
            [KEY_C, false],
            [CTRL_L, false],
        ]);
    });

    it('Cmd+Shift+C (Meta->guest Ctrl via WASM): Meta + Shift + "C" -> Ctrl+Shift+C scancodes', () => {
        down(KS_META_L);
        down(KS_LSHIFT);
        tap(0x43); // "C"
        up(KS_LSHIFT);
        up(KS_META_L);
        // Guest sees Meta_L scancode (remapped to Left Ctrl by the WASM meta_to_ctrl), Shift, then KeyC.
        expect(shiftDownWhenPressed(events, KEY_C)).toBe(true);
        expect(events.some((e) => e.kind === 'key' && e.value === META_L && e.pressed)).toBe(true);
        expect(events.some((e) => e.kind === 'key' && e.value === KEY_C && e.pressed)).toBe(true);
    });

    it('Mac Option becomes AltGr keysym, which is UNDEFINED on en-US -> dropped, guest never sees Alt', () => {
        down(KS_ALTGR); // Option, rewritten to AltGr by the client half
        tap(0x40); // "@" (Option+key on Mac)
        up(KS_ALTGR);
        // No AltGr/Alt scancode ever reaches the guest; "@" is produced as Shift+Digit2.
        expect(events.some((e) => e.kind === 'key' && e.value === ALT_R)).toBe(false);
        expect(events.some((e) => e.kind === 'key' && e.value === D2 && e.pressed)).toBe(true);
        expect(shiftDownWhenPressed(events, D2)).toBe(true);
    });

    it('Windows AltGr (Ctrl+Alt) + "/": modifier_flags sees ALTGR, "/" clears it -> plain Slash', () => {
        down(KS_LCTRL);
        down(KS_RALT);
        events.length = 0;
        tap(0x2f); // "/"
        // "/" has clearMod SHIFT only; ALTGR is derived from Ctrl+Alt. The Slash def needs no AltGr, and
        // its cost picks the plain scancode; Slash reaches the guest.
        expect(events.some((e) => e.kind === 'key' && e.value === SLASH && e.pressed)).toBe(true);
        up(KS_RALT);
        up(KS_LCTRL);
    });

    it('accented "é" (U+00E9, not on en-US) -> ONE Unicode event on press, nothing on release', () => {
        down(0xe9);
        up(0xe9);
        expect(events).toEqual([{ kind: 'uni', value: 0xe9 }]);
    });

    it('"v" on any layout -> KeyV scancode, no Unicode', () => {
        tap(0x76);
        expect(keyEvents(events)).toEqual([
            [KEY_V, true],
            [KEY_V, false],
        ]);
        expect(events.some((e) => e.kind === 'uni')).toBe(false);
    });
});
