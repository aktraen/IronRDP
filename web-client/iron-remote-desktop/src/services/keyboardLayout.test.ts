import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RemoteDesktopService } from './remote-desktop.service';
import type { RemoteDesktopModule } from '../interfaces/RemoteDesktopModule';
import type { Session } from '../interfaces/Session';
import { GUEST_KEYMAP, keysymScancode, MOD_SHIFT } from '../lib/guacKeyboardMap';

/**
 * End-to-end keyboard model: Guacamole 1.6 server half + keymap ported into IronRDP, driven by a
 * master-branch Keyboard.js client half.
 *
 * The client half (GuacKeyboard) turns the browser keydown/keypress/keyup stream into X11 keysyms; the
 * server half (GuacRdpKeyboard) turns those keysyms into scancode + Shift/AltGr key events using the
 * loaded keymap. The guest is pinned to FRENCH (WASM advertises keyboard_layout=0x040C, so xrdp sets the
 * guest XKB to "fr" at session start): accents (é è à ç ù, and ê ë â û î ï ô ö ü via dead-key
 * decomposition) type as NATIVE scancodes, which xkb terminals (Alacritty) receive. The client half is
 * still character-keyed (evt.key), so it stays correct for every client layout (AZERTY/BÉPO/QWERTY).
 * These tests drive real browser event shapes through the service and assert the guest scancode/Unicode
 * stream; expected scancodes are DERIVED from the loaded keymap.
 */

const SHIFT_L = 0x2a;
const CTRL_L = 0x1d;
const ARROW_LEFT = 0xe04b;

function scFor(keysym: number, mods = 0): number {
    const defs = GUEST_KEYMAP.filter((d) => d.keysym === keysym);
    const chosen = defs.find((d) => (d.setMod ?? 0) === mods) ?? defs[0];
    if (chosen === undefined) {
        throw new Error(`keysym 0x${keysym.toString(16)} not in keymap`);
    }
    return keysymScancode(chosen);
}
const cpOf = (s: string): number => s.codePointAt(0) ?? 0;

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
function keyStream(mod: RemoteDesktopModule): { sc: number; down: boolean; order: number }[] {
    const kp = mod.DeviceEvent.keyPressed as ReturnType<typeof vi.fn>;
    const kr = mod.DeviceEvent.keyReleased as ReturnType<typeof vi.fn>;
    const stream: { sc: number; down: boolean; order: number }[] = [];
    kp.mock.calls.forEach(([sc], i) => stream.push({ sc, down: true, order: kp.mock.invocationCallOrder[i] }));
    kr.mock.calls.forEach(([sc], i) => stream.push({ sc, down: false, order: kr.mock.invocationCallOrder[i] }));
    stream.sort((a, b) => a.order - b.order);
    return stream;
}
function shiftDownWhenPressed(mod: RemoteDesktopModule, targetSc: number): boolean {
    let shift = 0;
    for (const e of keyStream(mod)) {
        if (e.sc === SHIFT_L) shift += e.down ? 1 : -1;
        else if (e.down && e.sc === targetSc) return shift > 0;
    }
    return false;
}

describe('Guacamole keyboard port, French guest pin (end-to-end through the service)', () => {
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
    function typeChar(
        code: string,
        key: string,
        keyCode: number,
        mods: Partial<KeyboardEventInit> = {},
        keypressFires = true,
    ) {
        service.sendKeyboardEvent(ev('keydown', { code, key, keyCode, ...mods }));
        if (keypressFires) {
            const cp = cpOf(key);
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

    it('plain letter "a" -> its French scancode, no Unicode', () => {
        typeChar('KeyA', 'a', 65);
        expect(pressedWith(mod, scFor(cpOf('a')))).toBe(true);
        expect(mod.DeviceEvent.unicodePressed).not.toHaveBeenCalled();
    });

    it('direct accent "é" -> native French scancode in the terminal (NOT Unicode)', () => {
        typeChar('Digit2', 'é', 50);
        expect(pressedWith(mod, scFor(0xe9))).toBe(true);
        expect(mod.DeviceEvent.unicodePressed).not.toHaveBeenCalled();
    });

    it('circumflex accent "ê" -> dead circumflex + e (native scancodes), no Unicode', () => {
        typeChar('KeyE', 'ê', 69);
        expect(pressedWith(mod, scFor(0xfe52))).toBe(true); // dead circumflex
        expect(pressedWith(mod, scFor(cpOf('e')))).toBe(true); // base e
        expect(mod.DeviceEvent.unicodePressed).not.toHaveBeenCalled();
    });

    it('non-French, non-decomposable "ß" -> Unicode fallback', () => {
        typeChar('KeyS', 'ß', 83);
        expect(mod.DeviceEvent.unicodePressed).toHaveBeenCalledWith('ß');
    });

    it('AZERTY Shift-held number row "12345" -> digits (Shift pressed once, not per-digit)', () => {
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
        expect(pressedWith(mod, scFor(cpOf('1'), MOD_SHIFT))).toBe(true);
        const shiftPresses = keyStream(mod).filter((e) => e.sc === SHIFT_L && e.down).length;
        expect(shiftPresses).toBe(1);
    });

    it('Ctrl+C -> Ctrl held, "c" scancode, Ctrl not stripped', () => {
        modDown('ControlLeft', 'Control', { ctrlKey: true });
        typeChar('KeyC', 'c', 67, { ctrlKey: true }, false);
        modUp('ControlLeft', 'Control', {});
        expect(pressedWith(mod, CTRL_L)).toBe(true);
        expect(pressedWith(mod, scFor(cpOf('c')))).toBe(true);
    });

    it('Cmd+Shift+C -> guest Ctrl (Meta remap) + Shift + "C"', () => {
        modDown('MetaLeft', 'Meta', { metaKey: true });
        modDown('ShiftLeft', 'Shift', { metaKey: true, shiftKey: true });
        service.sendKeyboardEvent(
            ev('keydown', { code: 'KeyC', key: 'C', keyCode: 67, metaKey: true, shiftKey: true }),
        );
        service.sendKeyboardEvent(ev('keyup', { code: 'KeyC', key: 'C', keyCode: 67, metaKey: true, shiftKey: true }));
        modUp('ShiftLeft', 'Shift', { metaKey: true });
        modUp('MetaLeft', 'Meta', {});
        expect(shiftDownWhenPressed(mod, scFor(0x43, MOD_SHIFT))).toBe(true);
        expect(pressedWith(mod, 0xe05b)).toBe(true); // Meta_L scancode (WASM remaps to Left Ctrl)
    });

    it('plain Shift+ArrowLeft forwards the extended scancode, no Unicode', () => {
        service.sendKeyboardEvent(ev('keydown', { code: 'ShiftLeft', key: 'Shift', shiftKey: true }));
        service.sendKeyboardEvent(ev('keydown', { code: 'ArrowLeft', key: 'ArrowLeft', shiftKey: true }));
        service.sendKeyboardEvent(ev('keyup', { code: 'ArrowLeft', key: 'ArrowLeft', shiftKey: true }));
        service.sendKeyboardEvent(ev('keyup', { code: 'ShiftLeft', key: 'Shift' }));
        expect(pressedWith(mod, ARROW_LEFT)).toBe(true);
        expect(mod.DeviceEvent.unicodePressed).not.toHaveBeenCalled();
    });

    it('CapsLock forces the guest lock OFF and is not forwarded', () => {
        service.sendKeyboardEvent(ev('keydown', { code: 'CapsLock', key: 'CapsLock' }));
        expect(service.session!.synchronizeLockKeys).toHaveBeenCalledWith(false, false, false, false);
    });

    it('a Dead key emits nothing', () => {
        service.sendKeyboardEvent(ev('keydown', { code: 'BracketLeft', key: 'Dead' }));
        service.sendKeyboardEvent(ev('keyup', { code: 'BracketLeft', key: 'Dead' }));
        expect(mod.DeviceEvent.keyPressed).not.toHaveBeenCalled();
        expect(mod.DeviceEvent.unicodePressed).not.toHaveBeenCalled();
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
        expect(pressedWith(mod, 0x2f)).toBe(true); // KeyV physical scancode
    });
});
