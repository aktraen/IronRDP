import { loggingService } from './logging.service';
import { scanCode } from '../lib/scancodes';
import { GuacKeyboard } from '../lib/GuacKeyboard';
import { GuacRdpKeyboard, KeySource, type GuacRdpKeyboardSink } from '../lib/GuacRdpKeyboard';
import { KEYSYM_CAPS_LOCK, KEYSYM_NUM_LOCK, KEYSYM_SCROLL_LOCK } from '../lib/guacKeyboardMap';
import { LockKey } from '../enums/LockKey';
import type { NewSessionInfo } from '../interfaces/NewSessionInfo';
import { SpecialCombination } from '../enums/SpecialCombination';
import type { ResizeEvent } from '../interfaces/ResizeEvent';
import { ScreenScale } from '../enums/ScreenScale';
import type { MousePosition } from '../interfaces/MousePosition';
import type { ClipboardData } from '../interfaces/ClipboardData';
import type { Session } from '../interfaces/Session';
import { RotationUnit } from '../interfaces/DeviceEvent';
import type { DeviceEvent } from '../interfaces/DeviceEvent';
import type { RemoteDesktopModule } from '../interfaces/RemoteDesktopModule';
import { ConfigBuilder } from './ConfigBuilder';
import type { Config } from './Config';
import type { Extension } from '../interfaces/Extension';
import { Observable } from '../lib/Observable';
import type { SessionTerminationInfo } from '../interfaces/SessionTerminationInfo';
import type { FileTransferProvider } from '../interfaces/FileTransferProvider';

type OnRemoteClipboardChanged = (data: ClipboardData) => void;
type OnForceClipboardUpdate = () => void;
type OnCanvasResized = () => void;
type OnWarning = (data: string) => void;
type OnClipboardRemoteUpdate = () => void;

export class RemoteDesktopService {
    private module: RemoteDesktopModule;
    private canvas?: HTMLCanvasElement;
    private keyboardUnicodeMode: boolean = false;
    private onRemoteClipboardChanged?: OnRemoteClipboardChanged;
    private onForceClipboardUpdate?: OnForceClipboardUpdate;
    private onCanvasResized?: OnCanvasResized;
    private onWarningCallback?: OnWarning;
    private onClipboardRemoteUpdate?: OnClipboardRemoteUpdate;
    private fileTransferProvider?: FileTransferProvider;
    private cursorHasOverride: boolean = false;
    private lastCursorStyle: string = 'default';
    private enableClipboard: boolean = true;
    private _autoClipboard: boolean = true;

    sessionStartedObservable: Observable<null> = new Observable();

    resizeObservable: Observable<ResizeEvent> = new Observable();

    session?: Session;

    // The two halves of the ported Guacamole keyboard. guacKeyboard is the Keyboard.js client half
    // (browser event -> X11 keysym); guacRdp is the keyboard.c server half (keysym -> scancode +
    // lazy Shift/AltGr reconciliation). They are wired below so that the keysym stream the client half
    // emits drives the server half, whose scancode/Unicode output is batched into RDP transactions.
    private readonly guacKeyboard = new GuacKeyboard();
    private readonly guacRdp: GuacRdpKeyboard;

    // Scancode/Unicode DeviceEvents accumulated while the server half handles a single keysym, flushed
    // as one InputTransaction per keysym (a keysym may expand to several events: reconcile Shift, tap
    // the key, ...). The RDP server processes transactions in order, so per-keysym batching is exact.
    private pendingKeyEvents: DeviceEvent[] = [];

    mousePositionObservable: Observable<MousePosition> = new Observable();
    changeVisibilityObservable: Observable<boolean> = new Observable();
    scaleObservable: Observable<ScreenScale> = new Observable();

    dynamicResizeObservable: Observable<{ width: number; height: number }> = new Observable();

    constructor(module: RemoteDesktopModule) {
        this.module = module;

        // The sink the server half emits to: scancode/Unicode events are queued, then flushed per
        // keysym by the onKeyDown/onKeyUp wrappers below.
        const sink: GuacRdpKeyboardSink = {
            sendScancode: (scancode: number, pressed: boolean) => {
                const device = this.module.DeviceEvent;
                this.pendingKeyEvents.push(pressed ? device.keyPressed(scancode) : device.keyReleased(scancode));
            },
            sendUnicode: (codepoint: number) => {
                // One RDP Unicode event types the character (no held state). unicodeReleased is not sent:
                // it makes xkb-based terminals (Alacritty) drop the injected keysym. See GuacRdpKeyboard.
                this.pendingKeyEvents.push(this.module.DeviceEvent.unicodePressed(String.fromCodePoint(codepoint)));
            },
        };
        this.guacRdp = new GuacRdpKeyboard(sink);

        // Client half keysym stream -> server half. Lock keysyms (Caps/Num/Scroll) are NOT forwarded to
        // the guest here: the guest is en-US-pinned and case is encoded in the character + Shift, so the
        // guest lock state is driven out-of-band by syncModifier (Caps forced OFF). Each forwarded keysym
        // is flushed as its own transaction.
        this.guacKeyboard.onKeyDown = (keysym: number): boolean => {
            if (!RemoteDesktopService.isForwardedLockKeysym(keysym)) {
                this.pendingKeyEvents = [];
                this.guacRdp.updateKeysym(keysym, true, KeySource.Client);
                this.flushPendingKeyEvents();
            }
            return false;
        };
        this.guacKeyboard.onKeyUp = (keysym: number): void => {
            if (!RemoteDesktopService.isForwardedLockKeysym(keysym)) {
                this.pendingKeyEvents = [];
                this.guacRdp.updateKeysym(keysym, false, KeySource.Client);
                this.flushPendingKeyEvents();
            }
        };

        loggingService.info('Web bridge initialized.');
    }

    private static isForwardedLockKeysym(keysym: number): boolean {
        return keysym === KEYSYM_CAPS_LOCK || keysym === KEYSYM_NUM_LOCK || keysym === KEYSYM_SCROLL_LOCK;
    }

    private flushPendingKeyEvents(): void {
        if (this.pendingKeyEvents.length > 0) {
            const events = this.pendingKeyEvents;
            this.pendingKeyEvents = [];
            this.doTransactionFromDeviceEvents(events);
        }
    }

    get autoClipboard(): boolean {
        return this._autoClipboard;
    }

    // If set to false, the clipboard will not be enabled and the callbacks will not be registered to the Rust side
    setEnableClipboard(enable: boolean) {
        this.enableClipboard = enable;
    }

    // If set to true, automatic clipboard synchronization with the server is enabled.
    //
    // If set to false, then the client must invoke `PublicAPI.saveRemoteClipboardData` and
    // `PublicAPI.sendClipboardData` to write to clipboard and to send clipboard data to the server.
    setEnableAutoClipboard(enable: boolean) {
        this._autoClipboard = enable;
    }

    /// Callback to set the local clipboard content to data received from the remote.
    setOnRemoteClipboardChanged(callback: OnRemoteClipboardChanged) {
        this.onRemoteClipboardChanged = callback;
    }

    /// Callback which is called when the remote requests a forced clipboard update (e.g. on
    /// clipboard initialization sequence)
    setOnForceClipboardUpdate(callback: OnForceClipboardUpdate) {
        this.onForceClipboardUpdate = callback;
    }

    /// Callback which is called when the canvas is resized.
    setOnCanvasResized(callback: OnCanvasResized) {
        this.onCanvasResized = callback;
    }

    /// Callback which is called when the warning event is emitted.
    setOnWarningCallback(callback: OnWarning) {
        this.onWarningCallback = callback;
    }

    /// Callback which is called when the clipboard remote update event is emitted.
    setOnClipboardRemoteUpdate(callback: OnClipboardRemoteUpdate) {
        this.onClipboardRemoteUpdate = callback;
    }

    /**
     * Enable file transfer support. Must be called before connect().
     * Implicitly enables clipboard (required for file transfer protocol).
     *
     * @param provider - Protocol-specific file transfer provider (e.g., RdpFileTransferProvider)
     * @returns The same provider, for chaining
     */
    enableFileTransfer(provider: FileTransferProvider): FileTransferProvider {
        this.fileTransferProvider?.dispose();
        this.fileTransferProvider = provider;
        this.enableClipboard = true;
        return provider;
    }

    mouseIn(event: MouseEvent) {
        if (!this.session) return;
        this.syncModifier(event);
        // Release any button the session thinks is held but the browser no longer reports,
        // clearing stale state from buttons released outside the canvas (e.g. off-canvas mouseup).
        const buttonsMap: [number, number][] = [
            [1, 0], // left button
            [2, 2], // right button
            [4, 1], // middle button
        ];
        const releases = buttonsMap
            .filter(([mask]) => (event.buttons & mask) === 0)
            .map(([, buttonId]) => this.module.DeviceEvent.mouseButtonReleased(buttonId));
        if (releases.length > 0) {
            this.doTransactionFromDeviceEvents(releases);
        }
    }

    mouseOut(_event: MouseEvent) {
        this.releaseAllInputs();
    }

    focusLost() {
        this.releaseAllInputs();
    }

    sendKeyboardEvent(evt: KeyboardEvent) {
        this.sendKeyboard(evt);
    }

    shutdown() {
        this.fileTransferProvider?.dispose();
        this.session?.shutdown();
    }

    mouseButtonState(event: MouseEvent, isDown: boolean, preventDefault: boolean) {
        if (preventDefault) {
            event.preventDefault(); // prevent default behavior (context menu, etc)
        }
        const mouseFnc = isDown
            ? this.module.DeviceEvent.mouseButtonPressed
            : this.module.DeviceEvent.mouseButtonReleased;
        this.doTransactionFromDeviceEvents([mouseFnc(event.button)]);
    }

    updateMousePosition(position: MousePosition) {
        this.doTransactionFromDeviceEvents([this.module.DeviceEvent.mouseMove(position.x, position.y)]);
        this.mousePositionObservable.publish(position);
    }

    configBuilder(): ConfigBuilder {
        return new ConfigBuilder();
    }

    async connect(config: Config): Promise<NewSessionInfo> {
        const sessionBuilder = new this.module.SessionBuilder();

        sessionBuilder.proxyAddress(config.proxyAddress);
        sessionBuilder.destination(config.destination);
        sessionBuilder.serverDomain(config.serverDomain);
        sessionBuilder.password(config.password);
        sessionBuilder.authToken(config.authToken);
        sessionBuilder.username(config.username);
        sessionBuilder.renderCanvas(this.canvas!);
        sessionBuilder.setCursorStyleCallbackContext(this);
        sessionBuilder.setCursorStyleCallback(this.setCursorStyleCallback);

        config.extensions.forEach((extension) => {
            sessionBuilder.extension(extension);
        });

        if (this.onRemoteClipboardChanged != null && this.enableClipboard) {
            sessionBuilder.remoteClipboardChangedCallback(this.onRemoteClipboardChanged);
        }
        if (this.onForceClipboardUpdate != null && this.enableClipboard) {
            sessionBuilder.forceClipboardUpdateCallback(this.onForceClipboardUpdate);
        }
        // File transfer callbacks are protocol-specific and routed through
        // the extension mechanism. The provider supplies the extensions.
        if (this.fileTransferProvider != null && this.enableClipboard) {
            for (const ext of this.fileTransferProvider.getBuilderExtensions()) {
                sessionBuilder.extension(ext);
            }
        }
        if (this.onCanvasResized != null) {
            sessionBuilder.canvasResizedCallback(this.onCanvasResized);
        }

        if (config.desktopSize != null) {
            sessionBuilder.desktopSize(
                new this.module.DesktopSize(config.desktopSize.width, config.desktopSize.height),
            );
        }

        const session = await sessionBuilder.connect();

        this.session = session;
        this.fileTransferProvider?.setSession(session);

        this.resizeObservable.publish({
            desktopSize: session.desktopSize(),
            sessionId: 0,
        });

        this.sessionStartedObservable.publish(null);

        const run = async (): Promise<SessionTerminationInfo> => {
            try {
                loggingService.info('Starting the session.');
                return await session.run();
            } finally {
                this.setVisibility(false);
            }
        };

        return {
            sessionId: 0,
            initialDesktopSize: session.desktopSize(),
            websocketPort: 0,
            run,
        };
    }

    sendSpecialCombination(specialCombination: SpecialCombination): void {
        switch (specialCombination) {
            case SpecialCombination.CTRL_ALT_DEL:
                this.ctrlAltDel();
                break;
            case SpecialCombination.META:
                this.sendMeta();
                break;
            case SpecialCombination.CTRL_C:
                this.sendCtrlC();
                break;
            case SpecialCombination.CTRL_V:
                this.sendCtrlV();
                break;
        }
    }

    rotation_unit_from_wheel_event(event: WheelEvent): RotationUnit {
        switch (event.deltaMode) {
            case event.DOM_DELTA_PIXEL:
                return RotationUnit.Pixel;
            case event.DOM_DELTA_LINE:
                return RotationUnit.Line;
            case event.DOM_DELTA_PAGE:
                return RotationUnit.Page;
            default:
                return RotationUnit.Pixel;
        }
    }

    mouseWheel(event: WheelEvent) {
        const vertical = event.deltaY !== 0;
        const rotation = vertical ? event.deltaY : event.deltaX;
        const rotation_unit = this.rotation_unit_from_wheel_event(event);

        this.doTransactionFromDeviceEvents([
            this.module.DeviceEvent.wheelRotations(vertical, -rotation, rotation_unit),
        ]);
    }

    emitWarningEvent(data: string): void {
        this.onWarningCallback?.(data);
    }

    emitClipboardRemoteUpdateEvent(): void {
        this.onClipboardRemoteUpdate?.();
    }

    setVisibility(state: boolean) {
        this.changeVisibilityObservable.publish(state);
    }

    setScale(scale: ScreenScale) {
        this.scaleObservable.publish(scale);
    }

    setCanvas(canvas: HTMLCanvasElement) {
        this.canvas = canvas;
    }

    resizeDynamic(width: number, height: number, scale?: number) {
        this.dynamicResizeObservable.publish({ width, height });
        this.session?.resize(width, height, scale);
    }

    /// Triggered by the browser when local clipboard is updated. Clipboard backend should
    /// cache the content and send it to the server when it is requested.
    onClipboardChanged(data: ClipboardData): Promise<void> {
        const onClipboardChangedPromise = async () => {
            await this.session?.onClipboardPaste(data);
        };
        return onClipboardChangedPromise();
    }

    onClipboardChangedEmpty(): Promise<void> {
        const onClipboardChangedPromise = async () => {
            await this.session?.onClipboardPaste(new this.module.ClipboardData());
        };
        return onClipboardChangedPromise();
    }

    setKeyboardUnicodeMode(use_unicode: boolean) {
        this.keyboardUnicodeMode = use_unicode;
    }

    setCursorStyleOverride(style: string | null) {
        if (style == null) {
            this.canvas!.style.cursor = this.lastCursorStyle;
            this.cursorHasOverride = false;
        } else {
            this.canvas!.style.cursor = style;
            this.cursorHasOverride = true;
        }
    }

    invokeExtension(ext: Extension) {
        this.session?.invokeExtension(ext);
    }

    private releaseAllInputs() {
        // Blur/alt-tab/mouse-out: release everything so no key is stranded down. The client half
        // releases every keysym it holds (firing keyup -> the server half releases the matching
        // scancodes and, once nothing is user-held, resets any Shift/AltGr it pressed on the guest's
        // behalf), then the server half drops any residual synthetic/Unicode state, then the WASM side
        // is told to release all. Matches Guacamole.Keyboard.reset + guac_rdp_keyboard_reset.
        this.guacKeyboard.reset();
        this.guacRdp.releaseAll();
        this.session?.releaseAllInputs();
    }

    // Feed a browser key event into the ported Guacamole pipeline (when unicode mode is on) or the base
    // package's plain physical-scancode path (when off). preventDefault is applied the way Guacamole's
    // listenTo does: NOT blanket on keydown/keypress (that would suppress the keypress event the client
    // half relies on to disambiguate a printable keydown), only when the pipeline actually handled the
    // event; keyup is always prevented.
    private sendKeyboard(evt: KeyboardEvent) {
        if (this.keyboardUnicodeMode) {
            // Guest lock state (Num/Scroll synced from the OS, Caps forced OFF) is driven out-of-band --
            // the character keysym + Shift already encode case, so mirroring Caps would double-apply it.
            if (evt.code in LockKey) {
                this.syncModifier(evt);
            }

            if (evt.type === 'keydown') {
                if (this.guacKeyboard.handleKeyDown(evt)) {
                    evt.preventDefault();
                }
            } else if (evt.type === 'keypress') {
                if (this.guacKeyboard.handleKeyPress(evt)) {
                    evt.preventDefault();
                }
            } else if (evt.type === 'keyup') {
                evt.preventDefault();
                this.guacKeyboard.handleKeyUp(evt);
            }
            return;
        }

        // Base package default (unicode mode off): forward the physical scancode of the key position,
        // down on keydown and up on keyup. keypress carries no scancode and is ignored.
        evt.preventDefault();
        let keyEvent;
        if (evt.type === 'keydown') {
            keyEvent = this.module.DeviceEvent.keyPressed;
        } else if (evt.type === 'keyup') {
            keyEvent = this.module.DeviceEvent.keyReleased;
        } else {
            return;
        }
        const sc = scanCode(evt.code);
        if (!Number.isNaN(sc)) {
            this.doTransactionFromDeviceEvents([keyEvent(sc)]);
        }
    }

    private setCursorStyleCallback(
        style: string,
        data: string | undefined,
        hotspotX: number | undefined,
        hotspotY: number | undefined,
    ) {
        let cssStyle;

        switch (style) {
            case 'hidden': {
                cssStyle = 'none';
                break;
            }
            case 'default': {
                cssStyle = 'default';
                break;
            }
            case 'url': {
                if (data == undefined || hotspotX == undefined || hotspotY == undefined) {
                    console.error('Invalid custom cursor parameters.');
                    return;
                }

                // IMPORTANT: We need to make proxy `Image` object to actually load the image and
                // make it usable for CSS property. Without this proxy object, URL will be rejected.
                const image = new Image();
                image.src = data;

                const rounded_hotspot_x = Math.round(hotspotX);
                const rounded_hotspot_y = Math.round(hotspotY);

                cssStyle = `url(${data}) ${rounded_hotspot_x} ${rounded_hotspot_y}, default`;

                break;
            }
            default: {
                console.error(`Unsupported cursor style: ${style}.`);
                return;
            }
        }

        this.lastCursorStyle = cssStyle;

        if (!this.cursorHasOverride) {
            this.canvas!.style.cursor = cssStyle;
        }
    }

    private syncModifier(evt: KeyboardEvent | MouseEvent): void {
        const syncNumsLockActive = evt.getModifierState(LockKey.NUM_LOCK);
        const syncScrollLockActive = evt.getModifierState(LockKey.SCROLL_LOCK);
        const syncKanaModeActive = evt.getModifierState(LockKey.KANA_MODE);

        // Force the guest's CapsLock OFF regardless of the client. The character model already encodes
        // case in evt.key -> mapped.shift (explicit Shift for capitals), so mirroring the client's Caps
        // onto the guest would apply case a SECOND time and invert every letter. Num/Scroll/Kana sync.
        this.session?.synchronizeLockKeys(syncScrollLockActive, syncNumsLockActive, false, syncKanaModeActive);
    }

    private doTransactionFromDeviceEvents(deviceEvents: DeviceEvent[]) {
        const transaction = new this.module.InputTransaction();
        deviceEvents.forEach((event) => transaction.addEvent(event));
        this.session?.applyInputs(transaction);
    }

    private ctrlAltDel() {
        const ctrl = parseInt('0x001D', 16);
        const alt = parseInt('0x0038', 16);
        const suppr = parseInt('0xE053', 16);

        this.doTransactionFromDeviceEvents([
            this.module.DeviceEvent.keyPressed(ctrl),
            this.module.DeviceEvent.keyPressed(alt),
            this.module.DeviceEvent.keyPressed(suppr),
            this.module.DeviceEvent.keyReleased(ctrl),
            this.module.DeviceEvent.keyReleased(alt),
            this.module.DeviceEvent.keyReleased(suppr),
        ]);
    }

    private sendMeta() {
        const meta = parseInt('0xE05B', 16);

        this.doTransactionFromDeviceEvents([
            this.module.DeviceEvent.keyPressed(meta),
            this.module.DeviceEvent.keyReleased(meta),
        ]);
    }

    private sendCtrlC() {
        const ctrl = parseInt('0x001D', 16);
        const c = parseInt('0x002E', 16);

        this.doTransactionFromDeviceEvents([
            this.module.DeviceEvent.keyPressed(ctrl),
            this.module.DeviceEvent.keyPressed(c),
            this.module.DeviceEvent.keyReleased(c),
            this.module.DeviceEvent.keyReleased(ctrl),
        ]);
    }

    private sendCtrlV() {
        const ctrl = parseInt('0x001D', 16);
        const v = parseInt('0x002F', 16);

        this.doTransactionFromDeviceEvents([
            this.module.DeviceEvent.keyPressed(ctrl),
            this.module.DeviceEvent.keyPressed(v),
            this.module.DeviceEvent.keyReleased(v),
            this.module.DeviceEvent.keyReleased(ctrl),
        ]);
    }
}
