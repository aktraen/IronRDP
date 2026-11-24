import type { ScreenScale } from '../enums/ScreenScale';
import type { NewSessionInfo } from './NewSessionInfo';
import { ConfigBuilder } from '../services/ConfigBuilder';
import type { Config } from '../services/Config';
import type { Extension } from './Extension';
import type { Callback } from '../lib/Observable';
import type { FileTransferProvider } from './FileTransferProvider';

export interface UserInteraction {
    setVisibility(state: boolean): void;

    setScale(scale: ScreenScale): void;

    configBuilder(): ConfigBuilder;

    connect(config: Config): Promise<NewSessionInfo>;

    setKeyboardUnicodeMode(useUnicode: boolean): void;

    ctrlAltDel(): void;

    metaKey(): void;

    ctrlC(): void;

    ctrlV(): void;

    shutdown(): void;

    setCursorStyleOverride(style: string | null): void;

    onWarningCallback(callback: Callback<string>): void;

    onClipboardRemoteUpdateCallback(callback: Callback<void>): void;

    resize(width: number, height: number, scale?: number): void;

    setEnableClipboard(enable: boolean): void;

    setEnableAutoClipboard(enable: boolean): void;

    saveRemoteClipboardData(): Promise<void>;

    sendClipboardData(): Promise<void>;

    pasteClipboardText(text: string): Promise<void>;

    /** Runs a session extension and returns its result (`undefined` before the session exists). */
    invokeExtension(ext: Extension): unknown;

    /**
     * Enable file transfer support. Must be called before connect().
     * The provider becomes active after connect() resolves.
     * Implicitly enables clipboard (required for file transfer protocol).
     *
     * @param provider - Protocol-specific file transfer provider (e.g., RdpFileTransferProvider)
     * @returns The same provider, with monitoring hooks composed in
     */
    enableFileTransfer(provider: FileTransferProvider): FileTransferProvider;

    // External input: lets the host page drive the session from its own surfaces (for example
    // RemoteApp windows cropped from `renderCanvas()`) through the same input pipeline as the canvas.
    // Coordinates are desktop pixels. Every call is a no-op before the session exists.

    /** Moves the remote pointer; coordinates are rounded and clamped to the desktop. */
    sendPointerMove(x: number, y: number): void;

    /** Presses or releases a pointer button (DOM numbering: 0 left, 1 middle, 2 right). */
    sendPointerButton(button: number, pressed: boolean): void;

    /** Forwards a wheel event, quantized into notches like the canvas. */
    sendWheel(event: WheelEvent): void;

    /**
     * Forwards a keydown/keypress/keyup event through the canvas keyboard pipeline (Unicode mode, French
     * guest scancodes, AZERTY shortcuts, Meta as Ctrl). Calls `preventDefault()` on handled events and
     * never stops propagation.
     */
    sendKeyboardEvent(event: KeyboardEvent): void;

    /** Reconciles lock keys and held pointer buttons with the browser state, e.g. on pointer enter. */
    syncInputState(event: MouseEvent | KeyboardEvent): void;

    /** Releases every key and button held on the remote side, e.g. when a surface loses focus. */
    releaseAllInputs(): void;

    /** Receives the CSS `cursor` value of the remote pointer, at once and on every change. */
    onCursorStyleCallback(callback: (cursor: string) => void): void;

    /** The canvas holding the whole remote desktop image (`undefined` before the component mounts). */
    renderCanvas(): HTMLCanvasElement | undefined;
}
