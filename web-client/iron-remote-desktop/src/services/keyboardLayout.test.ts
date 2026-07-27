import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RemoteDesktopService } from './remote-desktop.service';
import type { RemoteDesktopModule } from '../interfaces/RemoteDesktopModule';
import type { Session } from '../interfaces/Session';

/**
 * End-to-end keyboard model: Guacamole 1.6 ported 1:1 into IronRDP.
 *
 * The client half (GuacKeyboard, the Keyboard.js port) turns the browser keydown/keypress/keyup stream
 * into X11 keysyms; the server half (GuacRdpKeyboard, the keyboard.c port) turns those keysyms into the
 * en-US scancode + Shift/AltGr the guest needs, reconciling the guest's modifier state lazily. The RDP
 * session is pinned to en-US (keyboard_layout 0x0409), so a scancode is interpreted as en-US and typing
 * is correct for every client layout (US/AZERTY/BEPO) and in terminals (a real scancode, never a
 * re-shifted Unicode injection). These tests drive the real browser event shapes (a printable keydown
 * is followed by a keypress; a modifier/nav keydown is not) through the service and assert the guest
 * scancode/Unicode stream. Per-keysym reconciliation is covered exhaustively in
 * ../lib/GuacRdpKeyboard.test.ts; this file verifies the full wiring.
 */

// Scancodes from the ported en-us-qwerty keymap.
const KEY_V = 0x2f;
const KEY_A = 0x1e;
const KEY_C = 0x2e;
const DIGIT1 = 0x02;
const DIGIT2 = 0x03;
const SHIFT_L = 0x2a;
const CTRL_L = 0x1d;
const ARROW_LEFT = 0xe04b;

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

// Reconstruct the full keyPressed/keyReleased stream in invocation order.
function keyStream(mod: RemoteDesktopModule): { sc: number; down: boolean; order: number }[] {
    const kp = mod.DeviceEvent.keyPressed as ReturnType<typeof vi.fn>;
    const kr = mod.DeviceEvent.keyReleased as ReturnType<typeof vi.fn>;
    const stream: { sc: number; down: boolean; order: number }[] = [];
    kp.mock.calls.forEach(([sc], i) => stream.push({ sc, down: true, order: kp.mock.invocationCallOrder[i] }));
    kr.mock.calls.forEach(([sc], i) => stream.push({ sc, down: false, order: kr.mock.invocationCallOrder[i] }));
    stream.sort((a, b) => a.order - b.order);
    return stream;
}

// Whether Shift is held on the guest at the moment targetSc is first pressed.
function shiftDownWhenPressed(mod: RemoteDesktopModule, targetSc: number): boolean {
    let shift = 0;
    for (const e of keyStream(mod)) {
        if (e.sc === SHIFT_L) shift += e.down ? 1 : -1;
        else if (e.down && e.sc === targetSc) return shift > 0;
    }
    return false;
}

describe('Guacamole keyboard port (end-to-end through the service)', () => {
    let service: RemoteDesktopService;
    let mod: RemoteDesktopModule;

    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
        mod = createMockModule();
        service = new RemoteDesktopService(mod);
        service.session = createMockSession();
        service.setKeyboardUnicodeMode(true);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    function ev(type: string, init: KeyboardEventInit): KeyboardEvent {
        return new KeyboardEvent(type, init);
    }

    // Type a printable character the way a browser does: keydown, then keypress carrying the character's
    // codepoint (unless a Ctrl/Meta chord suppresses keypress), then keyup. keyCode is stable across
    // keydown/keyup so the client half can resolve the release.
    function typeChar(
        code: string,
        key: string,
        keyCode: number,
        mods: Partial<KeyboardEventInit> = {},
        keypressFires = true,
    ) {
        service.sendKeyboardEvent(ev('keydown', { code, key, keyCode, ...mods }));
        if (keypressFires) {
            const cp = key.codePointAt(0) ?? 0;
            service.sendKeyboardEvent(
                ev('keypress', { code, key, keyCode: cp, which: cp, ...mods } as KeyboardEventInit),
            );
        }
        service.sendKeyboardEvent(ev('keyup', { code, key, keyCode, ...mods }));
    }

    function modDown(code: string, key: string, mods: Partial<KeyboardEventInit> = {}) {
        service.sendKeyboardEvent(ev('keydown', { code, key, ...mods }));
    }
    function modUp(code: string, key: string, mods: Partial<KeyboardEventInit> = {}) {
        service.sendKeyboardEvent(ev('keyup', { code, key, ...mods }));
    }

    it('plain "v" (US or the BEPO key that types v) -> KeyV, no Unicode', () => {
        typeChar('KeyV', 'v', 86);
        expect(pressedWith(mod, KEY_V)).toBe(true);
        expect(releasedWith(mod, KEY_V)).toBe(true);
        expect(mod.DeviceEvent.unicodePressed).not.toHaveBeenCalled();
    });

    it('plain digit "1" (no Shift) -> Digit1, no Shift toggling', () => {
        typeChar('Digit1', '1', 49);
        expect(pressedWith(mod, DIGIT1)).toBe(true);
        expect(pressedWith(mod, SHIFT_L)).toBe(false);
    });

    it('AZERTY Shift-held number row "12345" -> digits, Shift never re-pressed', () => {
        modDown('ShiftLeft', 'Shift', { shiftKey: true });
        for (const [code, key, kc] of [
            ['Digit1', '1', 49],
            ['Digit2', '2', 50],
            ['Digit3', '3', 51],
            ['Digit4', '4', 52],
            ['Digit5', '5', 53],
        ] as const) {
            typeChar(code, key, kc, { shiftKey: true });
        }
        modUp('ShiftLeft', 'Shift', {});

        for (const sc of [DIGIT1, DIGIT2]) {
            expect(shiftDownWhenPressed(mod, sc)).toBe(false);
        }
        const shiftPresses = keyStream(mod).filter((e) => e.sc === SHIFT_L && e.down).length;
        expect(shiftPresses).toBe(1);
        expect(mod.DeviceEvent.unicodePressed).not.toHaveBeenCalled();
    });

    it('"@" with no physical Shift -> Shift tapped around Digit2', () => {
        typeChar('Digit2', '@', 50);
        expect(pressedWith(mod, SHIFT_L)).toBe(true);
        expect(pressedWith(mod, DIGIT2)).toBe(true);
        expect(shiftDownWhenPressed(mod, DIGIT2)).toBe(true);
        expect(releasedWith(mod, SHIFT_L)).toBe(true);
    });

    it('uppercase "A" (Shift held) -> KeyA with Shift down', () => {
        modDown('ShiftLeft', 'Shift', { shiftKey: true });
        typeChar('KeyA', 'A', 65, { shiftKey: true });
        modUp('ShiftLeft', 'Shift', {});
        expect(shiftDownWhenPressed(mod, KEY_A)).toBe(true);
    });

    it('Ctrl+C (no keypress fires) -> Ctrl held, KeyC sent, Ctrl not stripped', () => {
        modDown('ControlLeft', 'Control', { ctrlKey: true });
        typeChar('KeyC', 'c', 67, { ctrlKey: true }, /* keypressFires */ false);
        modUp('ControlLeft', 'Control', {});
        expect(pressedWith(mod, CTRL_L)).toBe(true);
        expect(pressedWith(mod, KEY_C)).toBe(true);
        expect(shiftDownWhenPressed(mod, KEY_C)).toBe(false);
    });

    it('Mac Option+"@" : Option (Alt) becomes AltGr, dropped on en-US; "@" -> Shift+Digit2, no Alt to guest', () => {
        // On macOS Alt is a typable modifier, so keypress fires for the composed character.
        modDown('AltRight', 'Alt', { altKey: true });
        typeChar('Digit2', '@', 50, { altKey: true }, /* keypressFires */ true);
        modUp('AltRight', 'Alt', {});
        expect(pressedWith(mod, DIGIT2)).toBe(true);
        expect(shiftDownWhenPressed(mod, DIGIT2)).toBe(true);
        // AltRight scancode (0xE038) must never reach the guest.
        expect(pressedWith(mod, 0xe038)).toBe(false);
    });

    it('non-printable navigation key (ArrowLeft) -> extended scancode, no keypress, no Unicode', () => {
        service.sendKeyboardEvent(ev('keydown', { code: 'ArrowLeft', key: 'ArrowLeft' }));
        service.sendKeyboardEvent(ev('keyup', { code: 'ArrowLeft', key: 'ArrowLeft' }));
        expect(pressedWith(mod, ARROW_LEFT)).toBe(true);
        expect(mod.DeviceEvent.unicodePressed).not.toHaveBeenCalled();
    });

    it('accented "é" (not on en-US) -> Unicode injection', () => {
        typeChar('KeyE', 'é', 69);
        expect(mod.DeviceEvent.unicodePressed).toHaveBeenCalledWith('é');
    });

    it('a Dead key (accent composition) emits nothing', () => {
        service.sendKeyboardEvent(ev('keydown', { code: 'BracketLeft', key: 'Dead' }));
        service.sendKeyboardEvent(ev('keyup', { code: 'BracketLeft', key: 'Dead' }));
        expect(mod.DeviceEvent.keyPressed).not.toHaveBeenCalled();
        expect(mod.DeviceEvent.unicodePressed).not.toHaveBeenCalled();
    });

    it('CapsLock is forced OFF on the guest and its scancode is not forwarded', () => {
        service.sendKeyboardEvent(ev('keydown', { code: 'CapsLock', key: 'CapsLock' }));
        expect(service.session!.synchronizeLockKeys).toHaveBeenCalledWith(false, false, false, false);
    });

    it('blur/focusLost releases everything', () => {
        modDown('ShiftLeft', 'Shift', { shiftKey: true });
        service.focusLost();
        expect(service.session!.releaseAllInputs).toHaveBeenCalled();
    });
});

describe('non-unicode mode keeps the base package physical-scancode path', () => {
    let service: RemoteDesktopService;
    let mod: RemoteDesktopModule;

    beforeEach(() => {
        vi.clearAllMocks();
        mod = createMockModule();
        service = new RemoteDesktopService(mod);
        service.session = createMockSession();
    });

    it('keydown forwards scanCode(evt.code) directly', () => {
        service.sendKeyboardEvent(new KeyboardEvent('keydown', { code: 'KeyV', key: 'v' }));
        expect(pressedWith(mod, KEY_V)).toBe(true);
    });
});
