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
