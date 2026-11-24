import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RemoteDesktopService } from './remote-desktop.service';
import { PublicAPI } from './PublicAPI';
import type { ClipboardService } from './clipboard.service';
import type { RemoteDesktopModule } from '../interfaces/RemoteDesktopModule';
import type { Session } from '../interfaces/Session';

/**
 * External input API: a host page drives the session from its own surfaces (RemoteApp windows cropped
 * from the render canvas) instead of the component's canvas, through the same input pipeline.
 */

class MockInputTransaction {
    events: unknown[] = [];
    addEvent = vi.fn((event: unknown) => this.events.push(event));
}

function createMockModule(): RemoteDesktopModule {
    return {
        SessionBuilder: class {} as unknown as RemoteDesktopModule['SessionBuilder'],
        DesktopSize: class {} as unknown as RemoteDesktopModule['DesktopSize'],
        InputTransaction: MockInputTransaction as unknown as RemoteDesktopModule['InputTransaction'],
        ClipboardData: class {} as unknown as RemoteDesktopModule['ClipboardData'],
        DeviceEvent: {
            mouseButtonPressed: vi.fn((id: number) => ({ type: 'pressed', id })),
            mouseButtonReleased: vi.fn((id: number) => ({ type: 'released', id })),
            mouseMove: vi.fn((x: number, y: number) => ({ type: 'move', x, y })),
            wheelRotations: vi.fn((vertical: boolean, amount: number) => ({ type: 'wheel', vertical, amount })),
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
        desktopSize: vi.fn().mockReturnValue({ width: 1600, height: 900 }),
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

describe('external input API', () => {
    let module: RemoteDesktopModule;
    let service: RemoteDesktopService;
    let session: Session;
    let api: ReturnType<PublicAPI['getExposedFunctions']>;

    beforeEach(() => {
        vi.clearAllMocks();
        module = createMockModule();
        service = new RemoteDesktopService(module);
        session = createMockSession();
        service.session = session;
        api = new PublicAPI(service, {} as ClipboardService).getExposedFunctions();
    });

    function sentEvents(): unknown[] {
        return vi
            .mocked(session.applyInputs)
            .mock.calls.flatMap(([transaction]) => (transaction as unknown as MockInputTransaction).events);
    }

    it('moves the pointer to rounded desktop coordinates', () => {
        api.sendPointerMove(100.4, 200.6);
        expect(sentEvents()).toEqual([{ type: 'move', x: 100, y: 201 }]);
    });

    it('clamps pointer moves to the desktop (session size without a canvas)', () => {
        api.sendPointerMove(-40, 5000);
        api.sendPointerMove(1600, 899);
        expect(sentEvents()).toEqual([
            { type: 'move', x: 0, y: 899 },
            { type: 'move', x: 1599, y: 899 },
        ]);
    });

    it('clamps pointer moves to the render canvas once there is one', () => {
        const canvas = document.createElement('canvas');
        canvas.width = 1280;
        canvas.height = 720;
        service.setCanvas(canvas);

        api.sendPointerMove(1500, 800);

        expect(sentEvents()).toEqual([{ type: 'move', x: 1279, y: 719 }]);
        expect(api.renderCanvas()).toBe(canvas);
    });

    it('presses and releases pointer buttons', () => {
        api.sendPointerButton(0, true);
        api.sendPointerButton(2, true);
        api.sendPointerButton(2, false);
        expect(sentEvents()).toEqual([
            { type: 'pressed', id: 0 },
            { type: 'pressed', id: 2 },
            { type: 'released', id: 2 },
        ]);
    });

    it('quantizes wheel events into notches like the canvas', () => {
        api.sendWheel(new WheelEvent('wheel', { deltaY: 100, deltaMode: 0 }));
        expect(sentEvents()).toEqual([{ type: 'wheel', vertical: true, amount: -120 }]);
    });

    it('forwards keys through the physical scancode path and prevents their default', () => {
        const keydown = new KeyboardEvent('keydown', { code: 'KeyV', key: 'v', cancelable: true });
        api.sendKeyboardEvent(keydown);
        api.sendKeyboardEvent(new KeyboardEvent('keyup', { code: 'KeyV', key: 'v' }));
        expect(sentEvents()).toEqual([
            { type: 'keyPressed', sc: 0x2f },
            { type: 'keyReleased', sc: 0x2f },
        ]);
        expect(keydown.defaultPrevented).toBe(true);
    });

    it('uses the unicode keyboard pipeline (French scancodes, Meta as Ctrl) when enabled', () => {
        service.setKeyboardUnicodeMode(true);
        api.sendKeyboardEvent(new KeyboardEvent('keydown', { code: 'MetaLeft', key: 'Meta', metaKey: true }));
        api.sendKeyboardEvent(new KeyboardEvent('keyup', { code: 'MetaLeft', key: 'Meta' }));
        api.sendKeyboardEvent(new KeyboardEvent('keydown', { code: 'Digit2', key: 'é', keyCode: 50 }));
        api.sendKeyboardEvent(
            new KeyboardEvent('keypress', {
                code: 'Digit2',
                key: 'é',
                keyCode: 0xe9,
                which: 0xe9,
            } as KeyboardEventInit),
        );
        api.sendKeyboardEvent(new KeyboardEvent('keyup', { code: 'Digit2', key: 'é', keyCode: 50 }));

        const pressed = vi.mocked(module.DeviceEvent.keyPressed).mock.calls.map(([sc]) => sc);
        expect(pressed).toContain(0xe05b);
        expect(pressed).toContain(0x03);
        expect(module.DeviceEvent.unicodePressed).not.toHaveBeenCalled();
    });

    it('syncs lock keys and releases stale buttons on pointer enter', () => {
        api.syncInputState(new MouseEvent('pointerenter', { buttons: 1 }));
        expect(session.synchronizeLockKeys).toHaveBeenCalledWith(false, false, false, false);
        expect(sentEvents()).toEqual([
            { type: 'released', id: 2 },
            { type: 'released', id: 1 },
        ]);

        api.syncInputState(new KeyboardEvent('keydown', { code: 'KeyA' }));
        expect(session.synchronizeLockKeys).toHaveBeenCalledTimes(2);
    });

    it('releases every held input', () => {
        api.releaseAllInputs();
        expect(session.releaseAllInputs).toHaveBeenCalledTimes(1);
    });

    it('reports the remote cursor style now and on every change', () => {
        const cursors: string[] = [];
        service.setCanvas(document.createElement('canvas'));
        api.onCursorStyleCallback((cursor) => cursors.push(cursor));

        const setCursorStyle = (
            service as unknown as { setCursorStyleCallback: (style: string) => void }
        ).setCursorStyleCallback.bind(service);
        setCursorStyle('hidden');
        setCursorStyle('default');

        expect(cursors).toEqual(['default', 'none', 'default']);
    });

    it('drops input before the session exists', () => {
        service.session = undefined;
        expect(() => {
            api.sendPointerMove(1, 1);
            api.sendPointerButton(0, true);
            api.sendWheel(new WheelEvent('wheel', { deltaY: 100 }));
            api.releaseAllInputs();
        }).not.toThrow();
        expect(session.applyInputs).not.toHaveBeenCalled();
    });
});
