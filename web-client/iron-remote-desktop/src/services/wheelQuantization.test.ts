import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RemoteDesktopService } from './remote-desktop.service';
import { RotationUnit } from '../interfaces/DeviceEvent';
import type { RemoteDesktopModule } from '../interfaces/RemoteDesktopModule';
import type { Session } from '../interfaces/Session';

/**
 * Wheel quantization: the RDP session must receive whole notches, never one PDU per DOM event.
 *
 * xrdp turns every wheel PDU into one X11 button-4/5 click whatever the rotation amount, and
 * Windows scrolls per WHEEL_DELTA (120). A Mac trackpad or mouse emits dozens of small-delta
 * wheel events per gesture, so one PDU per event made the guest scroll many times further than
 * the host. These tests pin the guacamole-common-js heuristic this service mirrors.
 */

type Emitted = { vertical: boolean; rotation: number; unit: RotationUnit };

class MockInputTransaction {
    events: Emitted[] = [];
    addEvent = vi.fn((e: Emitted) => {
        this.events.push(e);
    });
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
            wheelRotations: vi.fn(
                (vertical: boolean, rotation: number, unit: RotationUnit): Emitted => ({ vertical, rotation, unit }),
            ),
            keyPressed: vi.fn(),
            keyReleased: vi.fn(),
            unicodePressed: vi.fn(),
            unicodeReleased: vi.fn(),
        },
    } as unknown as RemoteDesktopModule;
}

function wheel(deltaY: number, deltaX = 0, deltaMode = 0): WheelEvent {
    return { deltaY, deltaX, deltaMode } as unknown as WheelEvent;
}

describe('mouseWheel quantization', () => {
    let service: RemoteDesktopService;
    let transactions: MockInputTransaction[];

    beforeEach(() => {
        transactions = [];
        service = new RemoteDesktopService(createMockModule());
        const session = {
            applyInputs: vi.fn((t: MockInputTransaction) => {
                transactions.push(t);
            }),
        } as unknown as Session;
        (service as unknown as { session?: Session }).session = session;
    });

    const emitted = () => transactions.flatMap((t) => t.events);

    it('accumulates trackpad-sized deltas and emits one notch per 53 px, then drops the remainder', () => {
        for (let i = 0; i < 10; i++) {
            service.mouseWheel(wheel(5));
        }
        expect(emitted()).toHaveLength(0);
        service.mouseWheel(wheel(5)); // 55 px crosses 53
        expect(emitted()).toEqual([{ vertical: true, rotation: -120, unit: RotationUnit.Pixel }]);
        for (let i = 0; i < 10; i++) {
            service.mouseWheel(wheel(5)); // remainder was dropped: 50 px, still under 53
        }
        expect(emitted()).toHaveLength(1);
    });

    it('treats one Chrome mouse notch (100 px) as exactly one notch', () => {
        service.mouseWheel(wheel(100));
        expect(emitted()).toEqual([{ vertical: true, rotation: -120, unit: RotationUnit.Pixel }]);
        expect(transactions).toHaveLength(1);
    });

    it('treats a Firefox pixel-mode notch (48 px) as one notch each time, never half', () => {
        service.mouseWheel(wheel(48));
        service.mouseWheel(wheel(48));
        expect(emitted().map((e) => e.rotation)).toEqual([-120, -120]);
    });

    it('sends a large single delta as several notches in ONE transaction', () => {
        service.mouseWheel(wheel(300));
        expect(transactions).toHaveLength(1);
        expect(emitted().map((e) => e.rotation)).toEqual([-120, -120, -120]);
    });

    it('converts line and page modes to pixels (18 px per line, 288 px per page)', () => {
        service.mouseWheel(wheel(3, 0, 1)); // Firefox line mode: 3 lines = 54 px
        expect(emitted().map((e) => e.rotation)).toEqual([-120]);
        service.mouseWheel(wheel(1, 0, 2)); // one page = 288 px ~ 3 notches
        expect(emitted().map((e) => e.rotation)).toEqual([-120, -120, -120, -120]);
    });

    it('maps DOM deltaY > 0 to a negative (down) rotation and deltaY < 0 to a positive (up) one', () => {
        service.mouseWheel(wheel(100));
        service.mouseWheel(wheel(-100));
        expect(emitted().map((e) => [e.vertical, e.rotation])).toEqual([
            [true, -120],
            [true, 120],
        ]);
    });

    it('maps DOM deltaX > 0 (scroll right) to a POSITIVE horizontal rotation', () => {
        service.mouseWheel(wheel(0, 100));
        service.mouseWheel(wheel(0, -100));
        expect(emitted().map((e) => [e.vertical, e.rotation])).toEqual([
            [false, 120],
            [false, -120],
        ]);
    });

    it('keeps the horizontal and vertical accumulators independent', () => {
        service.mouseWheel(wheel(30, 30));
        expect(emitted()).toHaveLength(0);
        service.mouseWheel(wheel(30, 0));
        expect(emitted().map((e) => [e.vertical, e.rotation])).toEqual([[true, -120]]);
        service.mouseWheel(wheel(0, 30));
        expect(emitted().map((e) => [e.vertical, e.rotation])).toEqual([
            [true, -120],
            [false, 120],
        ]);
    });

    it('a discrete notch resets the sub-threshold accumulator of its axis', () => {
        service.mouseWheel(wheel(30));
        service.mouseWheel(wheel(100));
        service.mouseWheel(wheel(30));
        expect(emitted().map((e) => e.rotation)).toEqual([-120]);
        service.mouseWheel(wheel(30));
        expect(emitted().map((e) => e.rotation)).toEqual([-120, -120]);
    });

    it('emits nothing for a zero-delta event and never a rotation other than +/-120', () => {
        service.mouseWheel(wheel(0, 0));
        expect(transactions).toHaveLength(0);
        for (const d of [7, 13, 41, 60, 99, 149, 151, 1000, -7, -260]) {
            service.mouseWheel(wheel(d));
        }
        expect(emitted().every((e) => Math.abs(e.rotation) === 120 && e.unit === RotationUnit.Pixel)).toBe(true);
    });
});
