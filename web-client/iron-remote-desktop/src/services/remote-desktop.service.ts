import { loggingService } from './logging.service';
import { scanCode } from '../lib/scancodes';
import { ModifierKey } from '../enums/ModifierKey';
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
    private backendSupportsUnicodeKeyboardShortcuts: boolean | undefined = undefined;
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
    modifierKeyPressed: ModifierKey[] = [];

    mousePositionObservable: Observable<MousePosition> = new Observable();
    changeVisibilityObservable: Observable<boolean> = new Observable();
    scaleObservable: Observable<ScreenScale> = new Observable();

    dynamicResizeObservable: Observable<{ width: number; height: number }> = new Observable();

    constructor(module: RemoteDesktopModule) {
        this.module = module;
        loggingService.info('Web bridge initialized.');
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
        // The guest releases every held key, so the local modifier mirror must be cleared too;
        // otherwise it drifts (a phantom Shift left behind across blur/alt-tab/mouse-out would
        // make the next Unicode-char neutralization re-press a Shift the guest no longer holds).
        this.modifierKeyPressed = [];
        this.session?.releaseAllInputs();
    }

    private supportsUnicodeKeyboardShortcuts(): boolean {
        // Use cached value to reduce FFI calls
        if (this.backendSupportsUnicodeKeyboardShortcuts !== undefined) {
            return this.backendSupportsUnicodeKeyboardShortcuts;
        }

        if (this.session?.supportsUnicodeKeyboardShortcuts) {
            this.backendSupportsUnicodeKeyboardShortcuts = this.session?.supportsUnicodeKeyboardShortcuts();
            return this.backendSupportsUnicodeKeyboardShortcuts;
        }

        // By default we use unicode keyboard shortcuts for backends
        return true;
    }

    private sendKeyboard(evt: KeyboardEvent) {
        evt.preventDefault();

        let keyEvent;
        let unicodeEvent;

        if (evt.type === 'keydown') {
            keyEvent = this.module.DeviceEvent.keyPressed;
            unicodeEvent = this.module.DeviceEvent.unicodePressed;
        } else if (evt.type === 'keyup') {
            keyEvent = this.module.DeviceEvent.keyReleased;
            unicodeEvent = this.module.DeviceEvent.unicodeReleased;
        }

        let sendAsUnicode = true;

        if (!this.supportsUnicodeKeyboardShortcuts()) {
            for (const modifier of ['Alt', 'Control', 'Meta', 'AltGraph', 'OS']) {
                if (evt.getModifierState(modifier)) {
                    sendAsUnicode = false;
                    break;
                }
            }
        }

        const isModifierKey = evt.code in ModifierKey;
        const isLockKey = evt.code in LockKey;

        // AltGr-composed characters (BEPO/AZERTY `/`, `{`, `}`, `|`, `@`, `#`, `~`, `\`, `€`, ...)
        // must be typed as the resulting character, not as a physical scancode routed through the
        // guest layout while AltGr is held. Mirrors Guacamole's release_simulated_altgr: for a
        // printable non-letter produced with Alt/AltGr (but not a Ctrl/Meta command chord), send the
        // character as Unicode and release the Ctrl/Alt modifiers first so the guest sees a clean char.
        // Letters are excluded so Ctrl+Alt+<letter> stays a shortcut (Guacamole assumes letters never
        // need AltGr).
        const codePoint = evt.key.length === 1 ? evt.key.codePointAt(0) ?? 0 : 0;
        const isComposedChar =
            this.keyboardUnicodeMode &&
            codePoint >= 0x20 &&
            codePoint !== 0x7f &&
            !isModifierKey &&
            !/^[a-z]$/i.test(evt.key) &&
            (evt.altKey || evt.getModifierState('AltGraph')) &&
            !evt.metaKey &&
            !(evt.ctrlKey && !evt.altKey);

        if (isModifierKey) {
            this.updateModifierKeyState(evt);
        }

        if (isLockKey) {
            this.syncModifier(evt);
        }

        if (!evt.repeat || (!isModifierKey && !isLockKey)) {
            // For keyboard SHORTCUTS (a modifier is held) resolve the scancode from the CHARACTER the
            // user typed, not the physical key position, so shortcuts are keyboard-layout independent
            // (mirrors Guacamole's keysym approach): Ctrl+V pastes on QWERTY, BEPO, AZERTY alike. For
            // plain typing (no modifier) the physical code path stays, since typed text goes as unicode.
            let scanCodeSource = evt.code;
            if (!sendAsUnicode && /^[a-z]$/i.test(evt.key)) {
                scanCodeSource = 'Key' + evt.key.toUpperCase();
            }
            const keyScanCode = scanCode(scanCodeSource);
            const unknownScanCode = Number.isNaN(keyScanCode);

            if (!this.keyboardUnicodeMode && keyEvent && !unknownScanCode) {
                this.doTransactionFromDeviceEvents([keyEvent(keyScanCode)]);
                return;
            }

            if (this.keyboardUnicodeMode && unicodeEvent && keyEvent) {
                // `Dead` and `Unidentified` keys should be ignored
                if (['Dead', 'Unidentified'].indexOf(evt.key) != -1) {
                    return;
                }

                if (isComposedChar) {
                    const events: DeviceEvent[] = [];
                    if (evt.type === 'keydown') {
                        for (const code of ['ControlLeft', 'ControlRight', 'AltLeft', 'AltRight']) {
                            const modScanCode = scanCode(code);
                            if (!Number.isNaN(modScanCode)) {
                                events.push(this.module.DeviceEvent.keyReleased(modScanCode));
                            }
                        }
                    }
                    events.push(unicodeEvent(evt.key));
                    this.doTransactionFromDeviceEvents(events);
                    return;
                }

                const keyCode = scanCode(evt.key);
                const isUnicodeCharacter = Number.isNaN(keyCode) && evt.key.length === 1 && !isModifierKey;

                if (isUnicodeCharacter && sendAsUnicode) {
                    // The character is injected as Unicode (WYSIWYG: the OS already resolved which
                    // glyph the key produces). A physically-held Shift would be re-applied by the
                    // guest to that injection and corrupt it: on BEPO/AZERTY the number row's SHIFTED
                    // level types the DIGITS 1234567890, but with the Shift scancode still down the
                    // guest yields the guest-layout shifted symbol (!@#$%^&*() on a US guest) instead.
                    // Mirror Guacamole's release_simulated_altgr (Keyboard.js): release the held
                    // modifier scancode(s) around the character, then RESTORE them so subsequent
                    // Shift+navigation (Shift+ArrowLeft/Home/End text selection) still applies Shift.
                    //
                    // Gate on THIS event's own Shift truth (evt.shiftKey), not the modifierKeyPressed
                    // mirror. The mirror can drift out of sync with the guest's real Shift state
                    // (releaseAllInputs releases the guest's keys without clearing it; a Shift keyup
                    // seen without a preceding keydown after focus is gained mid-hold pushes a phantom
                    // entry). If we re-pressed a Shift from a stale mirror while Shift is not really
                    // held, we would STRAND Shift down on the guest and every later key would be
                    // shifted. With the gate, a char typed while Shift is genuinely up never toggles
                    // Shift. modifierKeyPressed is used only to pick WHICH side (Left/Right) to toggle.
                    const shiftScanCodes =
                        evt.type === 'keydown' && evt.shiftKey ? this.heldShiftScanCodes() : [];
                    if (shiftScanCodes.length > 0) {
                        const events: DeviceEvent[] = [];
                        for (const sc of shiftScanCodes) {
                            events.push(this.module.DeviceEvent.keyReleased(sc));
                        }
                        events.push(unicodeEvent(evt.key));
                        for (const sc of shiftScanCodes) {
                            events.push(this.module.DeviceEvent.keyPressed(sc));
                        }
                        this.doTransactionFromDeviceEvents(events);
                    } else {
                        this.doTransactionFromDeviceEvents([unicodeEvent(evt.key)]);
                    }
                } else if (!unknownScanCode) {
                    // Use scancode instead of key code for non-unicode character values
                    this.doTransactionFromDeviceEvents([keyEvent(keyScanCode)]);
                }
                return;
            }
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
        const syncCapsLockActive = evt.getModifierState(LockKey.CAPS_LOCK);
        const syncNumsLockActive = evt.getModifierState(LockKey.NUM_LOCK);
        const syncScrollLockActive = evt.getModifierState(LockKey.SCROLL_LOCK);
        const syncKanaModeActive = evt.getModifierState(LockKey.KANA_MODE);

        this.session?.synchronizeLockKeys(
            syncScrollLockActive,
            syncNumsLockActive,
            syncCapsLockActive,
            syncKanaModeActive,
        );
    }

    /// Windows scancodes for the Shift key(s) currently held down, as tracked in
    /// modifierKeyPressed (i.e. the ones we actually pressed on the guest). Used to
    /// neutralize Shift around a Unicode character injection without stranding a Shift
    /// that was never pressed.
    private heldShiftScanCodes(): number[] {
        const codes: number[] = [];
        for (const [modifier, keyCode] of [
            [ModifierKey.SHIFT_LEFT, 'ShiftLeft'],
            [ModifierKey.SHIFT_RIGHT, 'ShiftRight'],
        ] as const) {
            if (this.modifierKeyPressed.indexOf(modifier) !== -1) {
                const sc = scanCode(keyCode);
                if (!Number.isNaN(sc)) {
                    codes.push(sc);
                }
            }
        }
        return codes;
    }

    private updateModifierKeyState(evt: KeyboardEvent) {
        const modKey: ModifierKey = ModifierKey[evt.code as keyof typeof ModifierKey];

        if (this.modifierKeyPressed.indexOf(modKey) === -1) {
            this.modifierKeyPressed.push(modKey);
        } else if (evt.type === 'keyup') {
            this.modifierKeyPressed.splice(this.modifierKeyPressed.indexOf(modKey), 1);
        }
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
