import { describe, it, expect, vi } from 'vitest';
import type { RailSysCommand, RemoteAppOptions } from './rail';

// The real Extension class lives in the WASM module; a plain stand-in keeps these tests WASM-free.
vi.mock('../../../crates/ironrdp-web/pkg/ironrdp_web', () => ({
    Extension: class {
        constructor(
            public ident: string,
            public value: unknown,
        ) {}
    },
}));

const rail = await import('./rail');

function parts(extension: unknown): { ident: string; value: unknown } {
    return extension as { ident: string; value: unknown };
}

describe('RemoteApp extensions', () => {
    it('remoteApp sends snake_case options and leaves defaults to the session', () => {
        expect(parts(rail.remoteApp({ alternateShell: 'aktraen-rail' }))).toEqual({
            ident: 'remote_app',
            value: { alternate_shell: 'aktraen-rail' },
        });
        expect(
            parts(
                rail.remoteApp({
                    alternateShell: 'aktraen-rail',
                    workDir: '/home/user',
                    bootstrapExecutable: '/usr/bin/true',
                    maxInitAttempts: 12,
                }),
            ).value,
        ).toEqual({
            alternate_shell: 'aktraen-rail',
            work_dir: '/home/user',
            bootstrap_executable: '/usr/bin/true',
            max_init_attempts: 12,
        });
    });

    it('remoteApp rejects invalid options', () => {
        expect(() => rail.remoteApp({} as RemoteAppOptions)).toThrow(/alternateShell/);
        expect(() => rail.remoteApp({ alternateShell: 'x', bootstrapExecutable: '' })).toThrow(/bootstrapExecutable/);
        expect(() => rail.remoteApp({ alternateShell: 'x', maxInitAttempts: 0 })).toThrow(/maxInitAttempts/);
        expect(() => rail.remoteApp({ alternateShell: 'x', maxInitAttempts: 2.5 })).toThrow(/maxInitAttempts/);
    });

    it('callback extensions carry the function and refuse anything else', () => {
        const callback = vi.fn();
        expect(parts(rail.railWindowCallback(callback))).toEqual({ ident: 'rail_window_callback', value: callback });
        expect(parts(rail.railStateCallback(callback)).ident).toBe('rail_state_callback');
        expect(parts(rail.graphicsRegionCallback(callback)).ident).toBe('graphics_region_callback');
        expect(() => rail.railWindowCallback('nope' as unknown as () => void)).toThrow(/function/);
    });

    it('railExecute requires an executable', () => {
        expect(parts(rail.railExecute({ exe: '/usr/local/lib/aktraen/apps/wireshark' }))).toEqual({
            ident: 'rail_execute',
            value: { exe: '/usr/local/lib/aktraen/apps/wireshark' },
        });
        expect(parts(rail.railExecute({ exe: '/usr/bin/xterm', args: '-e top', workDir: '/tmp' })).value).toEqual({
            exe: '/usr/bin/xterm',
            args: '-e top',
            work_dir: '/tmp',
        });
        expect(() => rail.railExecute({ exe: '' })).toThrow(/exe/);
    });

    it('railWindowMove keeps every edge in a signed 16-bit coordinate', () => {
        expect(parts(rail.railWindowMove(0x1400007, { left: -20, top: 30, width: 800, height: 600 }))).toEqual({
            ident: 'rail_window_move',
            value: { id: 0x1400007, left: -20, top: 30, width: 800, height: 600 },
        });
        expect(() => rail.railWindowMove(7, { left: 32000, top: 0, width: 800, height: 600 })).toThrow(/width/);
        expect(() => rail.railWindowMove(7, { left: -40000, top: 0, width: 1, height: 1 })).toThrow(/left/);
        expect(() => rail.railWindowMove(7, { left: 0, top: 0.5, width: 1, height: 1 })).toThrow(/top/);
        expect(() => rail.railWindowMove(-1, { left: 0, top: 0, width: 1, height: 1 })).toThrow(/window id/);
    });

    it('railActivate and railSysCommand validate the window and command', () => {
        expect(parts(rail.railActivate(7))).toEqual({ ident: 'rail_activate', value: { id: 7, enabled: true } });
        expect(parts(rail.railActivate(7, false)).value).toEqual({ id: 7, enabled: false });
        expect(parts(rail.railSysCommand(7, 'close'))).toEqual({
            ident: 'rail_sys_command',
            value: { id: 7, command: 'close' },
        });
        expect(() => rail.railSysCommand(7, 'explode' as RailSysCommand)).toThrow(/system command/);
        expect(() => rail.railActivate(Number.NaN)).toThrow(/window id/);
    });

    it('work area, resync and state operations', () => {
        expect(parts(rail.railSetWorkArea(1280, 720))).toEqual({
            ident: 'rail_set_work_area',
            value: { width: 1280, height: 720 },
        });
        expect(() => rail.railSetWorkArea(0, 720)).toThrow(/width/);
        expect(() => rail.railSetWorkArea(1280, 70000)).toThrow(/height/);
        expect(parts(rail.railResync()).ident).toBe('rail_resync');
        expect(parts(rail.railState()).ident).toBe('rail_state');
    });
});
