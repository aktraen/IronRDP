import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RemoteDesktopService } from './remote-desktop.service';
import type { RemoteDesktopModule } from '../interfaces/RemoteDesktopModule';
import type { Session } from '../interfaces/Session';
import { scanCode } from '../lib/scancodes';

/**
 * Regression tests for layout-dependent keyboard shortcuts.
 *
 * Bug: sendKeyboard resolved shortcut scancodes from evt.code (the PHYSICAL key
 * position), so Ctrl+V only pasted when the physical QWERTY-V key was pressed.
 * On BEPO/AZERTY the key that TYPES "v" sits elsewhere, so the shortcut sent the
 * wrong scancode and did not paste. Guacamole keys off the character (keysym),
 * which is layout-independent.
 *
 * Fix: when a modifier is held (sendAsUnicode === false) and the key is a letter,
 * derive the scancode from evt.key (the character) as `Key<UPPER>` instead of
 * evt.code. Plain typing (no modifier) keeps the unicode path untouched.
 */

const V = scanCode('KeyV');
const H = scanCode('KeyH');
const A = scanCode('KeyA');
const Q = scanCode('KeyQ');

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

describe('layout-independent keyboard shortcuts', () => {
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

    it('sanity: getModifierState honours ctrlKey under jsdom', () => {
        expect(new KeyboardEvent('keydown', { ctrlKey: true }).getModifierState('Control')).toBe(true);
        expect(V).toBe(0x2f);
        expect(H).toBe(0x23);
    });

    it('BEPO: Ctrl + (physical H key that types "v") sends the V scancode, not H', () => {
        key('KeyH', 'v', { ctrlKey: true });
        expect(mod.DeviceEvent.keyPressed).toHaveBeenCalledWith(V);
        expect(mod.DeviceEvent.keyPressed).not.toHaveBeenCalledWith(H);
    });

    it('QWERTY: Ctrl + V still sends the V scancode', () => {
        key('KeyV', 'v', { ctrlKey: true });
        expect(mod.DeviceEvent.keyPressed).toHaveBeenCalledWith(V);
    });

    it('AZERTY: Ctrl + (physical Q key that types "a") sends the A scancode, not Q', () => {
        key('KeyQ', 'a', { ctrlKey: true });
        expect(mod.DeviceEvent.keyPressed).toHaveBeenCalledWith(A);
        expect(mod.DeviceEvent.keyPressed).not.toHaveBeenCalledWith(Q);
    });

    it('Meta (Mac Command) held is treated as a shortcut too', () => {
        key('KeyH', 'v', { metaKey: true });
        expect(mod.DeviceEvent.keyPressed).toHaveBeenCalledWith(V);
    });

    it('uppercase character (Shift held) still resolves to the letter scancode', () => {
        key('KeyH', 'V', { ctrlKey: true, shiftKey: true });
        expect(mod.DeviceEvent.keyPressed).toHaveBeenCalledWith(V);
    });

    it('plain typing (no modifier) is unchanged: sends unicode, not a scancode', () => {
        key('KeyH', 'v');
        expect(mod.DeviceEvent.unicodePressed).toHaveBeenCalledWith('v');
        expect(mod.DeviceEvent.keyPressed).not.toHaveBeenCalled();
    });

    it('non-letter shortcut (Ctrl+1) is left on the physical-code path', () => {
        key('Digit1', '1', { ctrlKey: true });
        expect(mod.DeviceEvent.keyPressed).toHaveBeenCalledWith(scanCode('Digit1'));
    });
});

describe('AltGr-composed characters (BEPO / AZERTY typing of / { } | @ ...)', () => {
    let service: RemoteDesktopService;
    let mod: RemoteDesktopModule;

    const CTRL_L = scanCode('ControlLeft');
    const CTRL_R = scanCode('ControlRight');
    const ALT_L = scanCode('AltLeft');
    const ALT_R = scanCode('AltRight');

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

    it('Windows AltGr (Ctrl+Alt) + "/" types "/" as Unicode and releases Ctrl+Alt first', () => {
        key('Digit3', '/', { ctrlKey: true, altKey: true });
        expect(mod.DeviceEvent.unicodePressed).toHaveBeenCalledWith('/');
        expect(mod.DeviceEvent.keyReleased).toHaveBeenCalledWith(CTRL_L);
        expect(mod.DeviceEvent.keyReleased).toHaveBeenCalledWith(CTRL_R);
        expect(mod.DeviceEvent.keyReleased).toHaveBeenCalledWith(ALT_L);
        expect(mod.DeviceEvent.keyReleased).toHaveBeenCalledWith(ALT_R);
        expect(mod.DeviceEvent.keyPressed).not.toHaveBeenCalled();
    });

    it('Mac right-Option (altKey only) + "/" also types "/" as Unicode', () => {
        key('Slash', '/', { altKey: true });
        expect(mod.DeviceEvent.unicodePressed).toHaveBeenCalledWith('/');
        expect(mod.DeviceEvent.keyReleased).toHaveBeenCalledWith(ALT_R);
        expect(mod.DeviceEvent.keyPressed).not.toHaveBeenCalled();
    });

    it('AltGr + "€" (multi-byte) types the euro sign as Unicode', () => {
        key('KeyE', '€', { ctrlKey: true, altKey: true });
        expect(mod.DeviceEvent.unicodePressed).toHaveBeenCalledWith('€');
        expect(mod.DeviceEvent.keyPressed).not.toHaveBeenCalled();
    });

    it('Ctrl+Alt+<letter> stays a shortcut (letters never need AltGr)', () => {
        key('KeyT', 't', { ctrlKey: true, altKey: true });
        expect(mod.DeviceEvent.keyPressed).toHaveBeenCalledWith(scanCode('KeyT'));
        expect(mod.DeviceEvent.unicodePressed).not.toHaveBeenCalled();
    });

    it('Ctrl+"/" (no Alt) stays a shortcut on the scancode path', () => {
        key('Slash', '/', { ctrlKey: true });
        expect(mod.DeviceEvent.keyPressed).toHaveBeenCalledWith(scanCode('Slash'));
        expect(mod.DeviceEvent.unicodePressed).not.toHaveBeenCalled();
    });

    it('Meta+"/" (Command shortcut) is not treated as composition', () => {
        key('Slash', '/', { metaKey: true });
        expect(mod.DeviceEvent.unicodePressed).not.toHaveBeenCalled();
    });
});

/**
 * Regression tests for the BEPO Shift+number-row bug (founder-reported).
 *
 * Bug: on a BEPO layout the number row's SHIFTED level types the DIGITS
 * 1234567890, but the physical Shift keydown is forwarded to the guest as a Shift
 * SCANCODE that stays held while the digit is injected as a Unicode character.
 * The guest re-applies Shift to that injection and yields the guest-layout shifted
 * symbol (!@#$%^&*() on a US guest) instead of the digit. Unshifted typing works
 * (no Shift held), and Shift+letter looks fine (uppercase keysym is unchanged by
 * Shift), which is exactly what the founder observed.
 *
 * Fix: mirror Guacamole's release_simulated_altgr. When a printable character is
 * sent as Unicode while Shift is physically held, release the held Shift
 * scancode(s) BEFORE the character and re-press them AFTER, so the guest sees a
 * clean Unicode injection yet Shift stays held for subsequent Shift+navigation
 * (text selection). Only the Shift key(s) actually down (tracked in
 * modifierKeyPressed) are toggled, so a Shift that was never pressed is never
 * stranded.
 */
describe('Shift neutralization around Unicode characters (BEPO Shift+number row)', () => {
    let service: RemoteDesktopService;
    let mod: RemoteDesktopModule;

    const SHIFT_L = scanCode('ShiftLeft');
    const SHIFT_R = scanCode('ShiftRight');
    const ARROW_LEFT = scanCode('ArrowLeft');

    beforeEach(() => {
        vi.clearAllMocks();
        mod = createMockModule();
        service = new RemoteDesktopService(mod);
        service.session = createMockSession();
        service.setKeyboardUnicodeMode(true);
    });

    function press(code: string, k: string, mods: Partial<KeyboardEventInit> = {}) {
        service.sendKeyboardEvent(new KeyboardEvent('keydown', { code, key: k, ...mods }));
    }

    it('sanity: Shift scancodes resolve', () => {
        expect(SHIFT_L).toBe(0x2a);
        expect(SHIFT_R).toBe(0x36);
    });

    it('BEPO Shift+Digit1 types "1" as Unicode with ShiftLeft released before and re-pressed after', () => {
        press('ShiftLeft', 'Shift', { shiftKey: true });
        vi.clearAllMocks();

        press('Digit1', '1', { shiftKey: true });

        expect(mod.DeviceEvent.keyReleased).toHaveBeenCalledWith(SHIFT_L);
        expect(mod.DeviceEvent.unicodePressed).toHaveBeenCalledWith('1');
        expect(mod.DeviceEvent.keyPressed).toHaveBeenCalledWith(SHIFT_L);

        // Order must be: release Shift -> inject char -> re-press Shift.
        const relOrder = (mod.DeviceEvent.keyReleased as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
        const uniOrder = (mod.DeviceEvent.unicodePressed as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
        const preOrder = (mod.DeviceEvent.keyPressed as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
        expect(relOrder).toBeLessThan(uniOrder);
        expect(uniOrder).toBeLessThan(preOrder);
    });

    it('no net Shift dangling: exactly one release and one matching re-press of the held Shift', () => {
        press('ShiftLeft', 'Shift', { shiftKey: true });
        vi.clearAllMocks();

        press('Digit5', '5', { shiftKey: true });

        const releasedShift = (mod.DeviceEvent.keyReleased as ReturnType<typeof vi.fn>).mock.calls.filter(
            ([sc]) => sc === SHIFT_L,
        );
        const pressedShift = (mod.DeviceEvent.keyPressed as ReturnType<typeof vi.fn>).mock.calls.filter(
            ([sc]) => sc === SHIFT_L,
        );
        expect(releasedShift).toHaveLength(1);
        expect(pressedShift).toHaveLength(1);
    });

    it('restores only the Shift actually held: ShiftLeft down does not touch ShiftRight', () => {
        press('ShiftLeft', 'Shift', { shiftKey: true });
        vi.clearAllMocks();

        press('Digit2', '2', { shiftKey: true });

        expect(mod.DeviceEvent.keyReleased).not.toHaveBeenCalledWith(SHIFT_R);
        expect(mod.DeviceEvent.keyPressed).not.toHaveBeenCalledWith(SHIFT_R);
    });

    it('ShiftRight held neutralizes ShiftRight (not ShiftLeft)', () => {
        press('ShiftRight', 'Shift', { shiftKey: true });
        vi.clearAllMocks();

        press('Digit3', '3', { shiftKey: true });

        expect(mod.DeviceEvent.keyReleased).toHaveBeenCalledWith(SHIFT_R);
        expect(mod.DeviceEvent.keyPressed).toHaveBeenCalledWith(SHIFT_R);
        expect(mod.DeviceEvent.keyReleased).not.toHaveBeenCalledWith(SHIFT_L);
    });

    it('Shift+letter still types the uppercase letter (as Unicode), Shift neutralized around it', () => {
        press('ShiftLeft', 'Shift', { shiftKey: true });
        vi.clearAllMocks();

        press('KeyV', 'V', { shiftKey: true });

        expect(mod.DeviceEvent.unicodePressed).toHaveBeenCalledWith('V');
        expect(mod.DeviceEvent.keyReleased).toHaveBeenCalledWith(SHIFT_L);
        expect(mod.DeviceEvent.keyPressed).toHaveBeenCalledWith(SHIFT_L);
    });

    it('Shift+ArrowLeft (text selection) still sends the Arrow scancode with Shift held', () => {
        press('ShiftLeft', 'Shift', { shiftKey: true });
        // Type a shifted digit first: Shift is released then RESTORED, so it stays held.
        press('Digit1', '1', { shiftKey: true });
        vi.clearAllMocks();

        press('ArrowLeft', 'ArrowLeft', { shiftKey: true });

        // Navigation goes via scancode (not Unicode), so the guest's still-held Shift selects.
        expect(mod.DeviceEvent.keyPressed).toHaveBeenCalledWith(ARROW_LEFT);
        expect(mod.DeviceEvent.unicodePressed).not.toHaveBeenCalled();
    });

    it('plain digit typing (no Shift) is unchanged: pure Unicode, no Shift toggling', () => {
        press('Digit1', '1');

        expect(mod.DeviceEvent.unicodePressed).toHaveBeenCalledWith('1');
        expect(mod.DeviceEvent.keyReleased).not.toHaveBeenCalled();
        expect(mod.DeviceEvent.keyPressed).not.toHaveBeenCalled();
    });

    it('Ctrl+Alt+Shift AltGr composition path is unaffected by Shift neutralization', () => {
        // AltGr-composed non-letter still goes through the composed-char branch (Ctrl/Alt released,
        // char as Unicode) regardless of the new Shift handling.
        press('Digit3', '/', { ctrlKey: true, altKey: true });
        expect(mod.DeviceEvent.unicodePressed).toHaveBeenCalledWith('/');
    });

    it('does NOT strand Shift when the mirror is stale but Shift is not really held (no re-press)', () => {
        // A lone Shift keyup (focus gained mid-hold) pushes a PHANTOM ShiftLeft into
        // modifierKeyPressed while the guest's Shift is UP. Typing a char with Shift not actually
        // held must NOT release/re-press Shift (a re-press would strand Shift down on the guest and
        // shift every subsequent key). The neutralization is gated on the event's own evt.shiftKey,
        // so with the phantom present but evt.shiftKey === false, no Shift toggling occurs.
        service.sendKeyboardEvent(new KeyboardEvent('keyup', { code: 'ShiftLeft', key: 'Shift' }));
        expect(service.modifierKeyPressed).toContain('ShiftLeft'); // phantom seeded
        vi.clearAllMocks();

        press('KeyA', 'a'); // evt.shiftKey defaults to false

        expect(mod.DeviceEvent.unicodePressed).toHaveBeenCalledWith('a');
        expect(mod.DeviceEvent.keyPressed).not.toHaveBeenCalled();
        expect(mod.DeviceEvent.keyReleased).not.toHaveBeenCalled();
    });

    it('releaseAllInputs (blur/focusLost/mouseOut) resets the modifier mirror', () => {
        press('ShiftLeft', 'Shift', { shiftKey: true });
        expect(service.modifierKeyPressed.length).toBeGreaterThan(0);

        service.focusLost();

        expect(service.modifierKeyPressed).toEqual([]);
    });
});
