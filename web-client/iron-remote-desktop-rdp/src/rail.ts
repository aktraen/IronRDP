/**
 * RemoteApp (RAIL) sessions against xrdp.
 *
 * `remoteApp()` and the three callbacks are builder extensions (`configBuilder().withExtension()`); the
 * `rail*` operations are session extensions (`invokeExtension()`), which throw when the session is not a
 * RemoteApp session. All coordinates are desktop pixels, the same space as `renderCanvas()`.
 *
 * Geometry belongs to the host: xrdp applies `railWindowMove()` but never reports a move or resize back,
 * nor one the application makes itself. The session applies each `railWindowMove()` to its own window
 * state and reports it as an `updated` event with `local: true`.
 *
 * Operations and the RAIL state: every `rail*` operation throws while the state is `exhausted` or
 * `unavailable` (nothing is queued). While `initiating`, launches, activations and system commands wait
 * until the server answers, at most 64 of them (the next one throws); a work area waits too (only the
 * latest counts) and a resync is dropped. A `railWindowMove()` of a window the session does not know is
 * ignored, and of queued moves of one window only the latest is sent.
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
    /**
     * The owning window, or `null` for a top-level window. It may name a window that is not (or no longer)
     * known; hosts show such a dialog as an ownerless window.
     */
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
          /**
           * The server sent the window again as new: xrdp does for every mapped window after each launch
           * (a work area alone re-sends windows as plain updates).
           */
          reannounced: boolean;
          /** The change comes from this client's own `railWindowMove()`, not from the server. */
          local: boolean;
      }
    | { kind: 'deleted'; id: number };

/**
 * `exhausted`: the server never answered the initiation, which is also what xrdp with its RAIL channel
 * disabled produces (after 24 attempts 5 s apart by default); a late answer still establishes it.
 * `unavailable`: the server did not join the RAIL channel (or it cannot be used); final.
 * Neither ends the session, and `rail*` operations throw in both.
 */
export type RailState = 'initiating' | 'established' | 'resyncing' | 'exhausted' | 'unavailable';

export interface RailStateEvent {
    state: RailState;
    /** Initiation attempts so far. */
    attempt: number;
    /** The size of the remote desktop. */
    desktopWidth: number;
    desktopHeight: number;
    /** The work area sent to the server: the whole desktop unless set with `railSetWorkArea()`. */
    workArea: RailRect;
    /** Why RAIL is `unavailable`, or a server protocol violation that was ignored. */
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

/**
 * Sends a system command. On xrdp, `close` asks the application to close (the window stays until its
 * `deleted` event), `maximize` is ignored, and `minimize` unmaps the window: xrdp then forgets it at the next
 * launch and never re-sends it, so the window is orphaned. Hosts minimize by moving the window off-screen
 * with `railWindowMove()` instead.
 */
export function railSysCommand(id: number, command: RailSysCommand): Extension {
    if (!SYS_COMMANDS.includes(command)) {
        fail(`unknown RAIL system command: ${String(command)}`);
    }
    return new Extension('rail_sys_command', { id: windowId(id), command });
}

/**
 * Moves and resizes a window (at least 1x1; every edge must fit in a signed 16-bit coordinate). The server
 * never confirms it; the session reports it at once as an `updated` event with `local: true`. A window the
 * session does not know is ignored.
 */
export function railWindowMove(id: number, rect: RailRect): Extension {
    const left = requireInteger('left', rect.left, I16_MIN, I16_MAX);
    const top = requireInteger('top', rect.top, I16_MIN, I16_MAX);
    const width = requireInteger('width', rect.width, 1, I16_MAX - left);
    const height = requireInteger('height', rect.height, 1, I16_MAX - top);
    return new Extension('rail_window_move', { id: windowId(id), left, top, width, height });
}

/**
 * Sets the work area (where the server places and maximizes windows) and sends it alone, without a display
 * change. A desktop resize resets it to the whole desktop.
 */
export function railSetWorkArea(rect: RailRect): Extension {
    const left = requireInteger('left', rect.left, 0, U16_MAX - 1);
    const top = requireInteger('top', rect.top, 0, U16_MAX - 1);
    const width = requireInteger('width', rect.width, 1, U16_MAX - left);
    const height = requireInteger('height', rect.height, 1, U16_MAX - top);
    return new Extension('rail_set_work_area', { left, top, width, height });
}

/**
 * Sends the work area again so the server re-sends every window it still maps; after about 5 to 10 s, windows
 * it did not re-send (for example ones it unmapped) are deleted. A deleted window the server later updates
 * stays unknown until it is announced as new again. Popups (menus, tooltips) open during a launch are not
 * re-sent by xrdp, so they may be deleted; xrdp announces them again the next time they open.
 */
export function railResync(): Extension {
    return new Extension('rail_resync', true);
}

/** Returns the current `RailSessionState`. */
export function railState(): Extension {
    return new Extension('rail_state', true);
}
