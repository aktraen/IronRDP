/**
 * RemoteApp (RAIL) sessions against xrdp.
 *
 * `remoteApp()` and the three callbacks are builder extensions (`configBuilder().withExtension()`); the
 * `rail*` operations are session extensions (`invokeExtension()`), which throw when the session is not a
 * RemoteApp session. All coordinates are desktop pixels, the same space as `renderCanvas()`.
 */

import { Extension } from '../../../crates/ironrdp-web/pkg/ironrdp_web';

export interface RemoteAppOptions {
    /** Sent in the Client Info PDU; xrdp starts the RemoteApp session from it. */
    alternateShell: string;
    workDir?: string;
    /** Executed once to wake xrdp's RAIL channel, which waits for a client Execute (default `/usr/bin/true`). */
    bootstrapExecutable?: string;
    /** Initiation attempts, one every 5 s, before the state becomes `exhausted` (default 24). */
    maxInitAttempts?: number;
}

export type RailWindowRole = 'app' | 'dialog' | 'popup';

export type RailShowState = 'hidden' | 'minimized' | 'maximized' | 'shown';

export interface RailRect {
    left: number;
    top: number;
    width: number;
    height: number;
}

export interface RailWindowSnapshot {
    id: number;
    /** The owning window, or `null` for a top-level window. */
    ownerId: number | null;
    role: RailWindowRole;
    showState: RailShowState;
    title: string;
    style: number;
    extendedStyle: number;
    /** Window offset and size. */
    rect: RailRect;
    clientRect: RailRect | null;
    windowRects: RailRect[];
    /** The parts of the window that are visible on the desktop. */
    visibilityRects: RailRect[];
}

export type RailWindowChange = 'title' | 'geometry' | 'visibility' | 'showState' | 'style' | 'owner';

export type RailWindowEvent =
    | { kind: 'created'; id: number; window: RailWindowSnapshot }
    | {
          kind: 'updated';
          id: number;
          window: RailWindowSnapshot;
          changed: RailWindowChange[];
          /** The server sent the window again as new (xrdp does after every launch and work area). */
          reannounced: boolean;
      }
    | { kind: 'deleted'; id: number };

export type RailState = 'initiating' | 'established' | 'resyncing' | 'exhausted';

export interface RailStateEvent {
    state: RailState;
    /** Initiation attempts so far. */
    attempt: number;
    desktopWidth: number;
    desktopHeight: number;
    /** Set when the server violated the protocol and the PDU was ignored. */
    warning?: string;
}

/** `invokeExtension(railState())` result; the state fields are absent before the session runs. */
export interface RailSessionState extends Partial<RailStateEvent> {
    windows: RailWindowSnapshot[];
}

/** A damaged area of `renderCanvas()`; `right` and `bottom` are exclusive. */
export interface GraphicsRegion {
    left: number;
    top: number;
    right: number;
    bottom: number;
}

export type RailSysCommand = 'close' | 'minimize' | 'maximize' | 'restore' | 'move' | 'size' | 'keymenu' | 'default';

export interface RailExecuteOptions {
    /** Executable path; xrdp ignores arguments and working directory. */
    exe: string;
    args?: string;
    workDir?: string;
}

const SYS_COMMANDS: readonly RailSysCommand[] = [
    'close',
    'minimize',
    'maximize',
    'restore',
    'move',
    'size',
    'keymenu',
    'default',
];
const I16_MIN = -32768;
const I16_MAX = 32767;
const U16_MAX = 65535;
const U32_MAX = 4294967295;

function fail(message: string): never {
    throw new Error(message);
}

function requireInteger(name: string, value: unknown, min: number, max: number): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
        fail(`${name} must be an integer in ${min}..${max}`);
    }
    return value;
}

function requireString(name: string, value: unknown, allowEmpty: boolean): string {
    if (typeof value !== 'string' || (!allowEmpty && value === '')) {
        fail(`${name} must be a${allowEmpty ? '' : ' non-empty'} string`);
    }
    return value;
}

function requireFunction<T>(name: string, value: T): T {
    if (typeof value !== 'function') {
        fail(`${name} must be a function`);
    }
    return value;
}

function windowId(id: unknown): number {
    return requireInteger('window id', id, 0, U32_MAX);
}

// --- Builder extensions ---

/** Makes the session an xrdp RemoteApp session. */
export function remoteApp(options: RemoteAppOptions): Extension {
    const payload: Record<string, unknown> = {
        alternate_shell: requireString('alternateShell', options.alternateShell, true),
    };
    if (options.workDir !== undefined) {
        payload.work_dir = requireString('workDir', options.workDir, true);
    }
    if (options.bootstrapExecutable !== undefined) {
        payload.bootstrap_executable = requireString('bootstrapExecutable', options.bootstrapExecutable, false);
    }
    if (options.maxInitAttempts !== undefined) {
        payload.max_init_attempts = requireInteger('maxInitAttempts', options.maxInitAttempts, 1, U32_MAX);
    }
    return new Extension('remote_app', payload);
}

/** Receives every window creation, change and deletion. */
export function railWindowCallback(callback: (event: RailWindowEvent) => void): Extension {
    return new Extension('rail_window_callback', requireFunction('railWindowCallback', callback) as unknown);
}

/** Receives every RAIL state change, initiation attempt and protocol warning. */
export function railStateCallback(callback: (event: RailStateEvent) => void): Extension {
    return new Extension('rail_state_callback', requireFunction('railStateCallback', callback) as unknown);
}

/**
 * Receives the areas of `renderCanvas()` repainted by each session loop iteration (at most 64, else
 * their bounding box), after the canvas was updated.
 */
export function graphicsRegionCallback(callback: (regions: GraphicsRegion[]) => void): Extension {
    return new Extension('graphics_region_callback', requireFunction('graphicsRegionCallback', callback) as unknown);
}

// --- Session operations (invokeExtension) ---

/** Launches an executable; queued until RAIL is established. */
export function railExecute(options: RailExecuteOptions): Extension {
    const payload: Record<string, unknown> = { exe: requireString('exe', options.exe, false) };
    if (options.args !== undefined) {
        payload.args = requireString('args', options.args, true);
    }
    if (options.workDir !== undefined) {
        payload.work_dir = requireString('workDir', options.workDir, true);
    }
    return new Extension('rail_execute', payload);
}

/** Raises and focuses a window (or deactivates it with `enabled = false`). */
export function railActivate(id: number, enabled = true): Extension {
    return new Extension('rail_activate', { id: windowId(id), enabled: enabled === true });
}

/** Sends a system command; xrdp closes on `close`, unmaps on `minimize` and ignores `maximize`. */
export function railSysCommand(id: number, command: RailSysCommand): Extension {
    if (!SYS_COMMANDS.includes(command)) {
        fail(`unknown RAIL system command: ${String(command)}`);
    }
    return new Extension('rail_sys_command', { id: windowId(id), command });
}

/** Moves and resizes a window; every edge must fit in a signed 16-bit coordinate. */
export function railWindowMove(id: number, rect: RailRect): Extension {
    const left = requireInteger('left', rect.left, I16_MIN, I16_MAX);
    const top = requireInteger('top', rect.top, I16_MIN, I16_MAX);
    const width = requireInteger('width', rect.width, 0, I16_MAX - left);
    const height = requireInteger('height', rect.height, 0, I16_MAX - top);
    return new Extension('rail_window_move', { id: windowId(id), left, top, width, height });
}

/** Sends a new work area (the session resize sends one itself after reactivation). */
export function railSetWorkArea(width: number, height: number): Extension {
    return new Extension('rail_set_work_area', {
        width: requireInteger('width', width, 1, U16_MAX),
        height: requireInteger('height', height, 1, U16_MAX),
    });
}

/** Asks the server to re-announce its windows; windows it does not re-announce are deleted. */
export function railResync(): Extension {
    return new Extension('rail_resync', true);
}

/** Returns the current `RailSessionState`. */
export function railState(): Extension {
    return new Extension('rail_state', true);
}
