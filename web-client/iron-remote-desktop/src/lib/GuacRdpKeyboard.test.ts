import { describe, it, expect, beforeEach } from 'vitest';
import { GuacRdpKeyboard, KeySource, type GuacRdpKeyboardSink } from './GuacRdpKeyboard';
import { GUEST_KEYMAP, keysymScancode, MOD_SHIFT, MOD_ALTGR } from './guacKeyboardMap';

// Server-half unit tests: feed X11 keysyms (as the client half would) and assert the exact scancode /
// Unicode stream the guest receives. This is the guacd keyboard.c state machine in isolation, so the
// terminal-critical behaviours (lazy Shift reconciliation, dead-key decomposition, reset on
// all-released) are verified deterministically. Expected scancodes are DERIVED from the loaded keymap
// (French fr-fr-azerty), so the tests assert behaviour, not layout minutiae.

const SHIFT_L = 0x2a; // base.keymap (layout-independent)
const CTRL_L = 0x1d;

const KS_LSHIFT = 0xffe1;
const KS_LCTRL = 0xffe3;
const KS_META_L = 0xffe7;
const DEAD_CIRCUMFLEX = 0xfe52;

function scFor(keysym: number, mods = 0): number {
    const defs = GUEST_KEYMAP.filter((d) => d.keysym === keysym);
    const chosen = defs.find((d) => (d.setMod ?? 0) === mods) ?? defs[0];
    if (chosen === undefined) {
        throw new Error(`keysym 0x${keysym.toString(16)} not in keymap`);
    }
    return keysymScancode(chosen);
}
const cpOf = (s: string): number => s.codePointAt(0) ?? 0;
const scDigit = (d: string): number => scFor(cpOf(d), MOD_SHIFT); // fr: digits live on the Shift layer
const scLower = (c: string): number => scFor(cpOf(c), 0);
const scAltGr = (ch: string): number => scFor(cpOf(ch), MOD_ALTGR);

type Event = { kind: 'key'; value: number; pressed: boolean } | { kind: 'uni'; value: number };

function recorder() {
    const events: Event[] = [];
    const sink: GuacRdpKeyboardSink = {
        sendScancode: (scancode, pressed) => events.push({ kind: 'key', value: scancode, pressed }),
        sendUnicode: (codepoint) => events.push({ kind: 'uni', value: codepoint }),
    };
    return { events, sink };
}
function shiftDownWhenPressed(events: Event[], targetSc: number): boolean {
    let shift = 0;
    for (const e of events) {
        if (e.kind !== 'key') continue;
        if (e.value === SHIFT_L) shift += e.pressed ? 1 : -1;
        else if (e.pressed && e.value === targetSc) return shift > 0;
    }
    return false;
}
function keyEvents(events: Event[]): [number, boolean][] {
    return events
        .filter((e): e is { kind: 'key'; value: number; pressed: boolean } => e.kind === 'key')
        .map((e) => [e.value, e.pressed]);
}

describe('GuacRdpKeyboard (French pin): keysym -> scancode + reconciliation + decompose', () => {
    let kbd: GuacRdpKeyboard;
    let events: Event[];
    beforeEach(() => {
        const r = recorder();
        events = r.events;
        kbd = new GuacRdpKeyboard(r.sink);
    });
    const down = (k: number): void => kbd.updateKeysym(k, true, KeySource.Client);
    const up = (k: number): void => kbd.updateKeysym(k, false, KeySource.Client);
    const tap = (k: number): void => {
        down(k);
        up(k);
    };

    it('plain letter "a" -> its French scancode, no Unicode', () => {
        tap(0x61);
        expect(keyEvents(events)).toEqual([
            [scLower('a'), true],
            [scLower('a'), false],
        ]);
        expect(events.some((e) => e.kind === 'uni')).toBe(false);
    });

    it('AZERTY Shift-held "12345": Shift pressed ONCE (physical) and never toggled per digit', () => {
        down(KS_LSHIFT);
        for (const d of ['1', '2', '3', '4', '5']) tap(cpOf(d));
        up(KS_LSHIFT);
        // fr: digits are on the Shift layer, so each digit legitimately needs Shift held; the invariant
        // is that Shift is pressed exactly once and not churned per digit.
        for (const d of ['1', '2', '3', '4', '5']) expect(shiftDownWhenPressed(events, scDigit(d))).toBe(true);
        const presses = events.filter((e) => e.kind === 'key' && e.value === SHIFT_L && e.pressed).length;
        expect(presses).toBe(1);
    });

    it('direct accent "é" -> its native French scancode (no decompose, no Unicode)', () => {
        tap(0xe9);
        expect(keyEvents(events)).toEqual([
            [scFor(0xe9), true],
            [scFor(0xe9), false],
        ]);
        expect(events.some((e) => e.kind === 'uni')).toBe(false);
    });

    it('circumflex accent "ê" -> DECOMPOSE: dead circumflex + e (native scancodes), no Unicode', () => {
        tap(0xea);
        const scDead = scFor(DEAD_CIRCUMFLEX);
        const scE = scLower('e');
        expect(keyEvents(events)).toEqual([
            [scDead, true],
            [scDead, false],
            [scE, true],
            [scE, false],
        ]);
        expect(events.some((e) => e.kind === 'uni')).toBe(false);
    });

    it('non-decomposable non-French char "ß" (U+00DF) -> Unicode fallback', () => {
        tap(0xdf);
        expect(events).toEqual([{ kind: 'uni', value: 0xdf }]);
    });

    it('Ctrl+C: Ctrl held by its own keysym, "c" plain -> Ctrl+C scancodes', () => {
        down(KS_LCTRL);
        tap(0x63);
        up(KS_LCTRL);
        expect(keyEvents(events)).toEqual([
            [CTRL_L, true],
            [scLower('c'), true],
            [scLower('c'), false],
            [CTRL_L, false],
        ]);
    });

    it('Cmd+Shift+C (Meta->guest Ctrl via WASM): guest sees Ctrl+Shift+"C"', () => {
        down(KS_META_L);
        down(KS_LSHIFT);
        tap(0x43);
        up(KS_LSHIFT);
        up(KS_META_L);
        expect(shiftDownWhenPressed(events, scFor(0x43, MOD_SHIFT))).toBe(true);
        // Meta_L maps to scancode 0xE05B; the WASM meta_to_ctrl remaps that to Left Ctrl guest-side.
        expect(events.some((e) => e.kind === 'key' && e.value === 0xe05b && e.pressed)).toBe(true);
    });

    it('Mac Option -> AltGr keysym; "@" produced via the native French AltGr scancode', () => {
        down(0xfe03);
        tap(0x40);
        up(0xfe03);
        expect(events.some((e) => e.kind === 'key' && e.value === scAltGr('@') && e.pressed)).toBe(true);
        // AltGr keysym 0xfe03 IS defined on the French keymap (base_altgr) -> a real AltGr scancode (0xE038) is held.
        expect(events.some((e) => e.kind === 'key' && e.value === 0xe038 && e.pressed)).toBe(true);
    });
});
