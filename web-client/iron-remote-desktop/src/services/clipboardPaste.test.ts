import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RemoteDesktopService } from './remote-desktop.service';
import { ClipboardService } from './clipboard.service';
import type { RemoteDesktopModule } from '../interfaces/RemoteDesktopModule';
import type { Session } from '../interfaces/Session';

/**
 * Tests for the gesture-driven HOST->GUEST clipboard push.
 *
 * The background 100ms monitor can never run: navigator.clipboard.read() throws
 * without transient user activation. Instead the learn component reads the
 * clipboard from a real `paste` DOM event (event.clipboardData, no permission
 * chip) and calls pasteText(text), which announces a CLIPRDR Format List to the
 * guest via session.onClipboardPaste BEFORE the Ctrl+V keystroke is injected.
 */

class MockClipboardData {
    entries: Record<string, string> = {};
    addText = vi.fn((kind: string, text: string) => {
        this.entries[kind] = text;
    });
    isEmpty = vi.fn(() => Object.keys(this.entries).length === 0);
}

function createMockModule(): RemoteDesktopModule {
    return {
        SessionBuilder: class {} as unknown as RemoteDesktopModule['SessionBuilder'],
        DesktopSize: class {} as unknown as RemoteDesktopModule['DesktopSize'],
        InputTransaction: class {} as unknown as RemoteDesktopModule['InputTransaction'],
        ClipboardData: MockClipboardData as unknown as RemoteDesktopModule['ClipboardData'],
        DeviceEvent: {} as unknown as RemoteDesktopModule['DeviceEvent'],
    };
}

function createMockSession(): Session {
    return {
        run: vi.fn(),
        desktopSize: vi.fn(),
        applyInputs: vi.fn(),
        releaseAllInputs: vi.fn(),
        synchronizeLockKeys: vi.fn(),
        shutdown: vi.fn(),
        onClipboardPaste: vi.fn().mockResolvedValue(undefined),
        resize: vi.fn(),
        supportsUnicodeKeyboardShortcuts: vi.fn().mockReturnValue(false),
        invokeExtension: vi.fn(),
    } as unknown as Session;
}

describe('host->guest clipboard push (pasteText)', () => {
    let rds: RemoteDesktopService;
    let clip: ClipboardService;
    let session: Session;
    let mod: RemoteDesktopModule;

    beforeEach(() => {
        vi.clearAllMocks();
        mod = createMockModule();
        rds = new RemoteDesktopService(mod);
        session = createMockSession();
        rds.session = session;
        clip = new ClipboardService(rds, mod);
    });

    it('announces the pasted text to the guest via session.onClipboardPaste', async () => {
        await clip.pasteText('hello world');
        expect(session.onClipboardPaste).toHaveBeenCalledTimes(1);
        const data = vi.mocked(session.onClipboardPaste).mock.calls[0][0] as unknown as MockClipboardData;
        expect(data.entries['text/plain']).toBe('hello world');
    });

    it('does NOT read the local clipboard (no permission chip)', async () => {
        const readSpy = vi.fn();
        Object.defineProperty(globalThis, 'navigator', {
            value: { clipboard: { read: readSpy, readText: readSpy } },
            configurable: true,
        });
        await clip.pasteText('abc');
        expect(readSpy).not.toHaveBeenCalled();
    });

    it('skips empty text (never announces an empty format list)', async () => {
        await clip.pasteText('');
        expect(session.onClipboardPaste).not.toHaveBeenCalled();
    });
});
