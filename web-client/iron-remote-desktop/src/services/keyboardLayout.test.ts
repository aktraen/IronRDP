import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RemoteDesktopService } from './remote-desktop.service';
import type { RemoteDesktopModule } from '../interfaces/RemoteDesktopModule';
import type { Session } from '../interfaces/Session';
import { scanCode } from '../lib/scancodes';

/**
 * Keyboard model: Guacamole's "always right" approach, ported to IronRDP.
 *
 * The RDP session is pinned to en-US-QWERTY (keyboard_layout 0x0409 in the WASM connector), so the
 * guest interprets every scancode as en-US. sendKeyboard keys on the CHARACTER the user meant
 * (KeyboardEvent.key, already resolved through the client's own layout) and sends the en-US scancode +
 * Shift that PRODUCES that character (usKeymap.ts), juggling modifiers guacd-style: clear interfering
 * ones, set exactly the Shift the character needs, restore. Because it keys on the resulting character,
 * it is correct for every client layout (US/AZERTY/BEPO/QWERTZ) and, unlike a Unicode-keysym injection,
 * correct in terminals (a real scancode the guest resolves natively, never re-shifted).
 *
 * These tests replace the earlier per-layout scancode hacks (physical-code shortcuts, digit-scancode,
 * Unicode-with-Shift-release) which were layout-specific and broke on non-US clients.
 */

const KEY_V = scanCode('KeyV');
const KEY_C = scanCode('KeyC');
const KEY_A = scanCode('KeyA');
const KEY_T = scanCode('KeyT');
const DIGIT1 = scanCode('Digit1');
const DIGIT2 = scanCode('Digit2');
const DIGIT3 = scanCode('Digit3');
const SLASH = scanCode('Slash');
const SHIFT_L = scanCode('ShiftLeft');
const SHIFT_R = scanCode('ShiftRight');
const CTRL_L = scanCode('ControlLeft');
const CTRL_R = scanCode('ControlRight');
const ALT_L = scanCode('AltLeft');
const ALT_R = scanCode('AltRight');
const ARROW_LEFT = scanCode('ArrowLeft');

class MockInputTransaction {
    addEvent = vi.fn();
}

function createMockModule(): RemoteDesktopModule {
    return {
        SessionBuilder: class {} as unknown as RemoteDesktopModule['SessionBuilder'],
        DesktopSize: class {} as unknown as RemoteDesktopModule['DesktopSize'],
        InputTransaction: MockInputTransaction as unknown as RemoteDesktopModule['InputTransaction'],
        ClipboardData: class {} as unknown as RemoteDesktopModule['ClipboardData'],
        DeviceEvent: {
            mouseButtonPressed: vi.fn(),
            mouseButtonReleased: vi.fn(),
            mouseMove: vi.fn(),
            wheelRotations: vi.fn(),
            keyPressed: vi.fn((sc: number) => ({ type: 'keyPressed', sc })),
            keyReleased: vi.fn((sc: number) => ({ type: 'keyReleased', sc })),
            unicodePressed: vi.fn((ch: string) => ({ type: 'unicodePressed', ch })),
            unicodeReleased: vi.fn((ch: string) => ({ type: 'unicodeReleased', ch })),
        },
    };
}

function createMockSession(): Session {
    return {
        run: vi.fn().mockResolvedValue({ reason: () => 'test' }),
        desktopSize: vi.fn().mockReturnValue({ width: 1920, height: 1080 }),
        applyInputs: vi.fn(),
        releaseAllInputs: vi.fn(),
        synchronizeLockKeys: vi.fn(),
        shutdown: vi.fn(),
        onClipboardPaste: vi.fn(),
        resize: vi.fn(),
        supportsUnicodeKeyboardShortcuts: vi.fn().mockReturnValue(false),
        invokeExtension: vi.fn(),
    } as unknown as Session;
}

function pressedWith(mod: RemoteDesktopModule, sc: number): boolean {
    return (mod.DeviceEvent.keyPressed as ReturnType<typeof vi.fn>).mock.calls.some(([s]) => s === sc);
}
function releasedWith(mod: RemoteDesktopModule, sc: number): boolean {
    return (mod.DeviceEvent.keyReleased as ReturnType<typeof vi.fn>).mock.calls.some(([s]) => s === sc);
}

describe('US-keymap character production (Guacamole model)', () => {
    let service: RemoteDesktopService;
    let mod: RemoteDesktopModule;

    beforeEach(() => {
        vi.clearAllMocks();
        mod = createMockModule();
        service = new RemoteDesktopService(mod);
        service.session = createMockSession();
        service.setKeyboardUnicodeMode(true);
    });

    function key(code: string, k: string, mods: Partial<KeyboardEventInit> = {}) {
        service.sendKeyboardEvent(new KeyboardEvent('keydown', { code, key: k, ...mods }));
    }
    function seedShift(side: 'ShiftLeft' | 'ShiftRight' = 'ShiftLeft') {
        service.sendKeyboardEvent(new KeyboardEvent('keydown', { code: side, key: 'Shift', shiftKey: true }));
        vi.clearAllMocks();
    }

    it('sanity: distinct scancodes resolve', () => {
        expect(KEY_V).toBe(0x2f);
        expect(DIGIT1).toBe(0x02);
        expect(SHIFT_L).toBe(0x2a);
    });

    it('plain letter "v" sends the KeyV scancode (no Unicode)', () => {
        key('KeyV', 'v');
        expect(mod.DeviceEvent.keyPressed).toHaveBeenCalledWith(KEY_V);
        expect(mod.DeviceEvent.unicodePressed).not.toHaveBeenCalled();
    });

    it('BEPO: the physical H key that TYPES "v" still sends KeyV (keys on the character, not position)', () => {
        key('KeyH', 'v');
        expect(mod.DeviceEvent.keyPressed).toHaveBeenCalledWith(KEY_V);
        expect(pressedWith(mod, scanCode('KeyH'))).toBe(false);
    });

    it('plain digit "1" (US client, no Shift) sends Digit1, no Shift toggling', () => {
        key('Digit1', '1');
        expect(mod.DeviceEvent.keyPressed).toHaveBeenCalledWith(DIGIT1);
        expect(mod.DeviceEvent.unicodePressed).not.toHaveBeenCalled();
        expect(releasedWith(mod, SHIFT_L)).toBe(false);
    });

    it('BEPO/AZERTY Shift+digit -> "1": Shift released BEFORE the digit and NOT re-pressed (terminal-safe; the reported bug)', () => {
        seedShift();
        key('Digit1', '1', { shiftKey: true });

        // The character is "1" (US: Digit1, NO shift), but Shift is physically held to reach it on
        // BEPO/AZERTY. Release the held Shift so the guest resolves Digit1 -> "1", then LEAVE Shift
        // released. Re-pressing it in the same batch bracketed the digit with a phantom Shift release +
        // Shift re-press; a terminal that honours the live modifier stream (CSI-u / modifyOtherKeys /
        // the kitty keyboard protocol) then reports spurious Shift toggles around every digit -- so
        // digits "don't come out right" in the terminal even though GUI toolkits tolerate it. Guacamole's
        // model: never restore a modifier around a key; reconcile it lazily on the next key.
        expect(mod.DeviceEvent.keyReleased).toHaveBeenCalledWith(SHIFT_L);
        expect(mod.DeviceEvent.keyPressed).toHaveBeenCalledWith(DIGIT1);
        expect(pressedWith(mod, SHIFT_L)).toBe(false); // NOT re-pressed -> no phantom Shift toggle
        expect(mod.DeviceEvent.unicodePressed).not.toHaveBeenCalled();

        // Order: release Shift BEFORE tapping Digit1 (so the guest sees Digit1 with no Shift).
        const kp = mod.DeviceEvent.keyPressed as ReturnType<typeof vi.fn>;
        const relOrder = (mod.DeviceEvent.keyReleased as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
        const digitIdx = kp.mock.calls.findIndex(([sc]) => sc === DIGIT1);
        expect(relOrder).toBeLessThan(kp.mock.invocationCallOrder[digitIdx]);
    });

    it('CONTINUOUS Shift-hold across the number row (1..0) never re-presses Shift -> no shifted-symbol corruption', () => {
        // The reported bug's real shape: an AZERTY/BEPO typist holds Shift ONCE and taps the whole number
        // row (digits live on the Shift layer), with NO Shift keyup between digits. The old else-branch
        // re-pressed Shift after EVERY digit, so between consecutive digits the guest held Shift down again
        // -- a terminal (Alacritty/winit) that reads the live modifier when the next Digit scancode lands
        // then rendered the US SHIFTED SYMBOL (1->!, 2->@, ...). With the lazy-state fix the held Shift is
        // released once, BEFORE the first digit, and never re-pressed: across the entire run Shift is only
        // ever released, so no digit is ever adjacent to a Shift-down state and the symbols cannot appear.
        seedShift();
        const row = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'] as const;
        for (const d of row) {
            key('Digit' + (d === '0' ? '0' : d), d, { shiftKey: true });
        }
        for (const d of row) {
            expect(mod.DeviceEvent.keyPressed).toHaveBeenCalledWith(scanCode('Digit' + (d === '0' ? '0' : d)));
        }
        // The invariant that kills the corruption: Shift is NEVER pressed by the character path.
        expect(pressedWith(mod, SHIFT_L)).toBe(false);
        expect(pressedWith(mod, SHIFT_R)).toBe(false);
        expect(mod.DeviceEvent.unicodePressed).not.toHaveBeenCalled();
    });

    it('US "!" (Shift held, char NEEDS shift): Digit1 sent WITH Shift, no toggling', () => {
        seedShift();
        key('Digit1', '!', { shiftKey: true });
        expect(mod.DeviceEvent.keyPressed).toHaveBeenCalledWith(DIGIT1);
        // Shift is already what the char needs, so it is never released around the key.
        expect(releasedWith(mod, SHIFT_L)).toBe(false);
        expect(mod.DeviceEvent.unicodePressed).not.toHaveBeenCalled();
    });

    it('char needs Shift but none held -> ShiftLeft tapped around the key ("@" with no physical Shift)', () => {
        key('Digit2', '@');
        expect(mod.DeviceEvent.keyPressed).toHaveBeenCalledWith(SHIFT_L);
        expect(mod.DeviceEvent.keyPressed).toHaveBeenCalledWith(DIGIT2);
        expect(mod.DeviceEvent.keyReleased).toHaveBeenCalledWith(SHIFT_L);
        // Shift is pressed BEFORE and released AFTER the digit.
        const kp = mod.DeviceEvent.keyPressed as ReturnType<typeof vi.fn>;
        const kr = mod.DeviceEvent.keyReleased as ReturnType<typeof vi.fn>;
        const shiftDownIdx = kp.mock.calls.findIndex(([sc]) => sc === SHIFT_L);
        const digitDownIdx = kp.mock.calls.findIndex(([sc]) => sc === DIGIT2);
        const shiftUpIdx = kr.mock.calls.findIndex(([sc]) => sc === SHIFT_L);
        expect(kp.mock.invocationCallOrder[shiftDownIdx]).toBeLessThan(kp.mock.invocationCallOrder[digitDownIdx]);
        expect(kp.mock.invocationCallOrder[digitDownIdx]).toBeLessThan(kr.mock.invocationCallOrder[shiftUpIdx]);
    });

    it('uppercase "A" (Shift held): KeyA sent with Shift, no toggling', () => {
        seedShift();
        key('KeyA', 'A', { shiftKey: true });
        expect(mod.DeviceEvent.keyPressed).toHaveBeenCalledWith(KEY_A);
        expect(releasedWith(mod, SHIFT_L)).toBe(false);
    });

    it('printable char is atomic on keydown; keyup sends nothing', () => {
        service.sendKeyboardEvent(new KeyboardEvent('keyup', { code: 'KeyV', key: 'v' }));
        expect(mod.DeviceEvent.keyPressed).not.toHaveBeenCalled();
        expect(mod.DeviceEvent.keyReleased).not.toHaveBeenCalled();
        expect(mod.DeviceEvent.unicodePressed).not.toHaveBeenCalled();
    });
});

describe('modifiers and command shortcuts (kept universal)', () => {
    let service: RemoteDesktopService;
    let mod: RemoteDesktopModule;

    beforeEach(() => {
        vi.clearAllMocks();
        mod = createMockModule();
        service = new RemoteDesktopService(mod);
        service.session = createMockSession();
        service.setKeyboardUnicodeMode(true);
    });
    function key(code: string, k: string, mods: Partial<KeyboardEventInit> = {}) {
        service.sendKeyboardEvent(new KeyboardEvent('keydown', { code, key: k, ...mods }));
    }

    it('Ctrl+C on any layout -> KeyC (Ctrl is held by its own event, never stripped)', () => {
        key('KeyC', 'c', { ctrlKey: true });
        expect(mod.DeviceEvent.keyPressed).toHaveBeenCalledWith(KEY_C);
        expect(releasedWith(mod, CTRL_L)).toBe(false);
        expect(releasedWith(mod, CTRL_R)).toBe(false);
    });

    it('BEPO: Ctrl + (physical J that types "c") still pastes-family -> KeyC (character-keyed)', () => {
        key('KeyJ', 'c', { ctrlKey: true });
        expect(mod.DeviceEvent.keyPressed).toHaveBeenCalledWith(KEY_C);
    });

    it('Ctrl+Shift+V (terminal paste) -> KeyV with Shift kept', () => {
        key('KeyV', 'V', { ctrlKey: true, shiftKey: true });
        expect(mod.DeviceEvent.keyPressed).toHaveBeenCalledWith(KEY_V);
        expect(releasedWith(mod, SHIFT_L)).toBe(false);
    });

    it('the Shift modifier key itself is forwarded as a scancode and tracked', () => {
        key('ShiftLeft', 'Shift', { shiftKey: true });
        expect(mod.DeviceEvent.keyPressed).toHaveBeenCalledWith(SHIFT_L);
        expect(service.modifierKeyPressed).toContain('ShiftLeft');
    });

    it('non-printable navigation key (ArrowLeft) forwards its physical scancode', () => {
        key('ArrowLeft', 'ArrowLeft', { shiftKey: true });
        expect(mod.DeviceEvent.keyPressed).toHaveBeenCalledWith(ARROW_LEFT);
        expect(mod.DeviceEvent.unicodePressed).not.toHaveBeenCalled();
    });

    it('Ctrl+Alt+<letter> stays a command chord (letters never AltGr) -> KeyT, modifiers kept', () => {
        key('KeyT', 't', { ctrlKey: true, altKey: true });
        expect(mod.DeviceEvent.keyPressed).toHaveBeenCalledWith(KEY_T);
        expect(releasedWith(mod, CTRL_L)).toBe(false);
        expect(releasedWith(mod, ALT_L)).toBe(false);
    });
});

describe('AltGr-composed characters (BEPO/AZERTY / { } | @ # ...)', () => {
    let service: RemoteDesktopService;
    let mod: RemoteDesktopModule;

    beforeEach(() => {
        vi.clearAllMocks();
        mod = createMockModule();
        service = new RemoteDesktopService(mod);
        service.session = createMockSession();
        service.setKeyboardUnicodeMode(true);
    });
    function down(code: string, k: string, mods: Partial<KeyboardEventInit> = {}) {
        service.sendKeyboardEvent(new KeyboardEvent('keydown', { code, key: k, ...mods }));
    }
    // Windows AltGr = a synthetic LeftControl keydown + a RightAlt keydown. Seeding these populates the
    // modifier mirror the way the real event stream does, so the strip releases the ACTUAL held sides.
    function seedWinAltGr() {
        down('ControlLeft', 'Control', { ctrlKey: true });
        down('AltRight', 'Alt', { ctrlKey: true, altKey: true });
        vi.clearAllMocks();
    }

    it('Windows AltGr + "/" -> Slash scancode; strips ONLY the held sides (CTRL_L, ALT_R) and restores them; CTRL_R/ALT_L never touched (B1)', () => {
        seedWinAltGr();
        down('Digit3', '/', { ctrlKey: true, altKey: true });
        expect(mod.DeviceEvent.keyPressed).toHaveBeenCalledWith(SLASH);
        expect(mod.DeviceEvent.keyReleased).toHaveBeenCalledWith(CTRL_L);
        expect(mod.DeviceEvent.keyReleased).toHaveBeenCalledWith(ALT_R);
        expect(mod.DeviceEvent.keyPressed).toHaveBeenCalledWith(CTRL_L); // restored
        expect(mod.DeviceEvent.keyPressed).toHaveBeenCalledWith(ALT_R); // restored
        // The un-held sides must NEVER be released OR pressed (re-pressing them strands them down).
        expect(releasedWith(mod, CTRL_R)).toBe(false);
        expect(pressedWith(mod, CTRL_R)).toBe(false);
        expect(releasedWith(mod, ALT_L)).toBe(false);
        expect(pressedWith(mod, ALT_L)).toBe(false);
        expect(mod.DeviceEvent.unicodePressed).not.toHaveBeenCalled();
    });

    it('Mac right-Option + "/" -> Slash scancode; only ALT_R toggled', () => {
        down('AltRight', 'Alt', { altKey: true });
        vi.clearAllMocks();
        down('Slash', '/', { altKey: true });
        expect(mod.DeviceEvent.keyPressed).toHaveBeenCalledWith(SLASH);
        expect(mod.DeviceEvent.keyReleased).toHaveBeenCalledWith(ALT_R);
        expect(mod.DeviceEvent.keyPressed).toHaveBeenCalledWith(ALT_R);
        expect(releasedWith(mod, ALT_L)).toBe(false);
        expect(releasedWith(mod, CTRL_L)).toBe(false);
    });

    it('AltGr char that NEEDS shift on US ("#" = Shift+Digit3): held Ctrl/Alt stripped AND Shift tapped', () => {
        seedWinAltGr();
        down('Digit3', '#', { ctrlKey: true, altKey: true });
        expect(mod.DeviceEvent.keyReleased).toHaveBeenCalledWith(CTRL_L);
        expect(mod.DeviceEvent.keyReleased).toHaveBeenCalledWith(ALT_R);
        expect(mod.DeviceEvent.keyPressed).toHaveBeenCalledWith(SHIFT_L);
        expect(mod.DeviceEvent.keyPressed).toHaveBeenCalledWith(DIGIT3);
        expect(releasedWith(mod, ALT_L)).toBe(false);
    });

    it('Ctrl+"/" (no Alt) stays a command chord -> Slash, Ctrl kept', () => {
        down('ControlLeft', 'Control', { ctrlKey: true });
        vi.clearAllMocks();
        down('Slash', '/', { ctrlKey: true });
        expect(mod.DeviceEvent.keyPressed).toHaveBeenCalledWith(SLASH);
        expect(releasedWith(mod, CTRL_L)).toBe(false);
    });
});

describe('CapsLock: case comes from the character, not the guest lock (M2)', () => {
    let service: RemoteDesktopService;
    let mod: RemoteDesktopModule;

    beforeEach(() => {
        vi.clearAllMocks();
        mod = createMockModule();
        service = new RemoteDesktopService(mod);
        service.session = createMockSession();
        service.setKeyboardUnicodeMode(true);
    });

    it('CapsLock keydown forces the guest lock OFF (sync arg false) and does NOT forward a scancode', () => {
        service.sendKeyboardEvent(new KeyboardEvent('keydown', { code: 'CapsLock', key: 'CapsLock' }));
        // synchronizeLockKeys(scroll, num, caps, kana) -> caps (3rd) must be false so the guest never
        // double-applies case on top of the explicit Shift the character model sends for capitals.
        expect(service.session!.synchronizeLockKeys).toHaveBeenCalledWith(false, false, false, false);
        // The CapsLock scancode is NOT forwarded (would toggle the guest lock and fight the sync).
        expect(mod.DeviceEvent.keyPressed).not.toHaveBeenCalled();
    });
});

describe('dead keys and Unidentified emit nothing (M3)', () => {
    let service: RemoteDesktopService;
    let mod: RemoteDesktopModule;

    beforeEach(() => {
        vi.clearAllMocks();
        mod = createMockModule();
        service = new RemoteDesktopService(mod);
        service.session = createMockSession();
        service.setKeyboardUnicodeMode(true);
    });

    it('a Dead key (accent composition) emits no scancode and no Unicode', () => {
        // `^` on French AZERTY: evt.key='Dead', evt.code='BracketLeft'. Must NOT type en-US "[".
        service.sendKeyboardEvent(new KeyboardEvent('keydown', { code: 'BracketLeft', key: 'Dead' }));
        expect(mod.DeviceEvent.keyPressed).not.toHaveBeenCalled();
        expect(mod.DeviceEvent.unicodePressed).not.toHaveBeenCalled();
    });

    it('an Unidentified key emits nothing', () => {
        service.sendKeyboardEvent(new KeyboardEvent('keydown', { code: 'KeyX', key: 'Unidentified' }));
        expect(mod.DeviceEvent.keyPressed).not.toHaveBeenCalled();
        expect(mod.DeviceEvent.unicodePressed).not.toHaveBeenCalled();
    });
});

describe('non-ASCII fallback + no Shift stranding (M1)', () => {
    let service: RemoteDesktopService;
    let mod: RemoteDesktopModule;

    beforeEach(() => {
        vi.clearAllMocks();
        mod = createMockModule();
        service = new RemoteDesktopService(mod);
        service.session = createMockSession();
        service.setKeyboardUnicodeMode(true);
    });
    function key(code: string, k: string, mods: Partial<KeyboardEventInit> = {}) {
        service.sendKeyboardEvent(new KeyboardEvent('keydown', { code, key: k, ...mods }));
    }

    it('accented "é" (not on US) falls back to a Unicode injection', () => {
        key('KeyE', 'é');
        expect(mod.DeviceEvent.unicodePressed).toHaveBeenCalledWith('é');
    });

    it('AltGr "€" (non-ASCII): Unicode injected, only the held Alt side released, ControlLeft untouched', () => {
        service.sendKeyboardEvent(new KeyboardEvent('keydown', { code: 'AltRight', key: 'Alt', altKey: true }));
        vi.clearAllMocks();
        key('KeyE', '€', { altKey: true });
        expect(mod.DeviceEvent.unicodePressed).toHaveBeenCalledWith('€');
        expect(mod.DeviceEvent.keyReleased).toHaveBeenCalledWith(ALT_R);
        expect(releasedWith(mod, CTRL_L)).toBe(false); // never held -> never touched
        expect(releasedWith(mod, ALT_L)).toBe(false);
    });

    it('M1a: a lone Shift keyup (no prior keydown) does NOT seed a phantom held Shift', () => {
        service.sendKeyboardEvent(new KeyboardEvent('keyup', { code: 'ShiftLeft', key: 'Shift' }));
        expect(service.modifierKeyPressed).not.toContain('ShiftLeft');
    });

    it('M1: physical ShiftRight held -> Digit1 releases ONLY ShiftRight (not re-pressed), never fabricates/strands ShiftLeft', () => {
        service.sendKeyboardEvent(new KeyboardEvent('keyup', { code: 'ShiftLeft', key: 'Shift' })); // was a phantom trigger
        service.sendKeyboardEvent(new KeyboardEvent('keydown', { code: 'ShiftRight', key: 'Shift', shiftKey: true }));
        vi.clearAllMocks();
        key('Digit1', '1', { shiftKey: true });
        expect(mod.DeviceEvent.keyReleased).toHaveBeenCalledWith(SHIFT_R);
        expect(pressedWith(mod, SHIFT_R)).toBe(false); // the held side is released and NOT re-pressed (no phantom toggle)
        expect(releasedWith(mod, SHIFT_L)).toBe(false);
        expect(pressedWith(mod, SHIFT_L)).toBe(false); // no fabricated ShiftLeft
    });

    it('empty mirror + char needing no shift: no Shift toggling at all (no fabricated ShiftLeft)', () => {
        // evt.shiftKey false, mirror empty -> mapped.shift(false) === shiftHeld(false) -> just tap.
        key('KeyA', 'a');
        expect(mod.DeviceEvent.keyPressed).toHaveBeenCalledWith(KEY_A);
        expect(releasedWith(mod, SHIFT_L)).toBe(false);
        expect(pressedWith(mod, SHIFT_L)).toBe(false);
    });

    it('releaseAllInputs (blur/focusLost) resets the modifier mirror', () => {
        service.sendKeyboardEvent(new KeyboardEvent('keydown', { code: 'ShiftLeft', key: 'Shift', shiftKey: true }));
        expect(service.modifierKeyPressed.length).toBeGreaterThan(0);
        service.focusLost();
        expect(service.modifierKeyPressed).toEqual([]);
    });
});
