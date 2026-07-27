import { loggingService } from './logging.service';
import { scanCode } from '../lib/scancodes';
import { usKey, type UsKey } from '../lib/usKeymap';
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

    // The scancode of the Shift key currently held on the GUEST, or null. The guest's Shift is a lazy
    // state tracked separately from the physical mirror (modifierKeyPressed): a layout-shifted digit
    // releases it and LEAVES it released (terminal-safe -- no per-digit re-press churn), and it is
    // reconciled to what the NEXT event needs (the character's Shift requirement, or the physical Shift
    // for a navigation key) instead of being restored eagerly. This is Guacamole's guest-side modifier
    // model (guac_rdp keyboard.c update_modifiers): only the delta from the current guest state is sent.
    private guestShiftScanCode: number | null = null;

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
        // The guest releases every held key, so the local mirror AND the tracked guest-Shift state must
        // be cleared too; otherwise they drift (a stale Shift left behind across blur/alt-tab/mouse-out
        // would make the next reconcile release or re-press a Shift the guest no longer holds).
        this.modifierKeyPressed = [];
        this.guestShiftScanCode = null;
        this.session?.releaseAllInputs();
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

        const isModifierKey = evt.code in ModifierKey;
        const isLockKey = evt.code in LockKey;

        // AltGr-composed characters (BEPO/AZERTY `/ { } | @ # ~ \ ...`) arrive with Ctrl+Alt (or the
        // AltGraph modifier) held. On the en-US-pinned guest they are base or Shift characters, so the
        // guest must not see Ctrl/Alt while the scancode is sent: strip them around the key, restore
        // after. Letters are excluded so Ctrl+Alt+<letter> stays a command chord (Guacamole's assumption
        // that letters never need AltGr); a lone Ctrl chord (Ctrl+C) is excluded too.
        const codePoint = evt.key.length === 1 ? (evt.key.codePointAt(0) ?? 0) : 0;
        const stripCtrlAlt =
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

        if (evt.repeat && (isModifierKey || isLockKey)) {
            return;
        }

        // Modifier and lock keys: forward the physical scancode so the guest holds them for chords
        // (Ctrl+C, Ctrl+Shift+V, AltGr). Their pressed/lock state is tracked above. CapsLock is the
        // exception -- it is handled ABSOLUTELY by syncModifier (forced off), so forwarding its scancode
        // (an edge-triggered toggle) would fight that sync; skip it.
        if (isModifierKey || isLockKey) {
            if (evt.code === LockKey.CAPS_LOCK) {
                return;
            }
            // Shift is managed as lazy GUEST state (see guestShiftScanCode): reconcile the guest Shift to
            // the physical Shift still held, collapsing both sides to a single guest key. Forwarding the
            // raw Shift scancode here instead would desync the guest from a layout-shifted digit that
            // lazily released it (the digit's re-press regression), and would strand a side if a capital
            // re-pressed a different Shift than the one physically held.
            if (evt.code === ModifierKey.SHIFT_LEFT || evt.code === ModifierKey.SHIFT_RIGHT) {
                const shiftEvents = this.syncGuestShift(this.isPhysicalShiftHeld());
                if (shiftEvents.length > 0) {
                    this.doTransactionFromDeviceEvents(shiftEvents);
                }
                return;
            }
            const modSc = scanCode(evt.code);
            if (keyEvent && !Number.isNaN(modSc)) {
                this.doTransactionFromDeviceEvents([keyEvent(modSc)]);
            }
            return;
        }

        // Dead keys (accent composition: `^` `¨` on French, all of `' " ` ^ ~` on US-International) and
        // Unidentified keys must emit NOTHING -- the composed character arrives on the next event. Guard
        // here, before the scancode fallback below would forward their physical scancode and type a stray
        // character on the en-US guest (`^` dead key -> `[`).
        if (evt.key === 'Dead' || evt.key === 'Unidentified') {
            return;
        }

        // A single printable character: reproduce it on the en-US-pinned guest the way Guacamole does
        // (key on the CHARACTER the user meant -- evt.key, already resolved through the client's own
        // layout -- and send the US scancode + Shift that yields it). Correct for every client layout,
        // and, unlike a Unicode-keysym injection, correct in terminals too. Gated on unicode mode (the
        // component enables it); without it the base package keeps its plain physical-scancode default.
        if (this.keyboardUnicodeMode && evt.key.length === 1) {
            const mapped = usKey(evt.key);
            if (mapped) {
                this.sendUsCharacter(evt, mapped, stripCtrlAlt);
                return;
            }
            // Non-ASCII (accents, currency): no US scancode exists, so inject the Unicode codepoint,
            // releasing any held Shift/AltGr around it so the guest does not re-shift the injection.
            // (Dead/Unidentified already returned above.)
            if (keyEvent && unicodeEvent) {
                this.sendUnicodeCharacter(evt, stripCtrlAlt);
            }
            return;
        }

        // Non-printable key (Enter, Tab, Backspace, arrows, F-keys, Home/End, ...): its physical
        // position is layout-independent, so forward the scancode down/up as-is. First reconcile the
        // guest Shift to the physical Shift: these keys combine with Shift (Shift+Arrow/Home selection)
        // and must see the real modifier even when a preceding layout-shifted digit lazily released the
        // guest Shift, or when a preceding shifted symbol left a stray Shift the guest should not apply.
        const sc = scanCode(evt.code);
        if (keyEvent && !Number.isNaN(sc)) {
            const events: DeviceEvent[] = [...this.syncGuestShift(evt.shiftKey), keyEvent(sc)];
            this.doTransactionFromDeviceEvents(events);
        }
    }

    /// Reproduce a printable US-QWERTY character on the en-US-pinned guest (Guacamole's keysym->scancode
    /// model). Emitted as ONE atomic transaction on keydown: strip any AltGr the client used, reconcile
    /// the guest Shift to exactly what the US layout needs for this character (lazy -- only the delta
    /// from the current guest Shift is sent), tap the scancode, then re-press the stripped AltGr. The
    /// guest Shift is NOT restored to the physical state here: under a continuous Shift-hold that restore
    /// re-pressed Shift after every layout-shifted digit, and a terminal that honours the live modifier
    /// stream then read the next digit as its shifted symbol (12345 -> !@#$%). Instead the guest Shift is
    /// left where the character needed it and reconciled by the NEXT event; the only exception is a
    /// character that needed Shift while none is physically held ("@"), where the tapped Shift is
    /// released now so it does not linger. keyup carries nothing (auto-repeat re-fires keydown). Command
    /// chords (Ctrl+C) keep their modifiers: Ctrl is forwarded by its own key event and never stripped.
    private sendUsCharacter(evt: KeyboardEvent, mapped: UsKey, stripCtrlAlt: boolean) {
        if (evt.type !== 'keydown') {
            return;
        }
        const sc = scanCode(mapped.code);
        if (Number.isNaN(sc)) {
            return;
        }
        const device = this.module.DeviceEvent;
        const events: DeviceEvent[] = [];

        // Strip only the Ctrl/Alt side(s) actually held (from the tracked mirror), never a hardcoded
        // four -- re-pressing a side the user never held would emit a real make code and STRAND it down.
        const altGrScanCodes = stripCtrlAlt ? this.heldCtrlAltScanCodes() : [];
        for (const modSc of altGrScanCodes) {
            events.push(device.keyReleased(modSc));
        }

        // Reconcile the guest Shift to what THIS character needs and tap the key. Then leave the guest
        // Shift where it is (lazy) -- the next event reconciles it -- EXCEPT when no Shift is physically
        // held: release the Shift we just tapped so a symbol like "@" (Shift+Digit2 on US, produced with
        // no physical Shift) does not leave a stray Shift down. When Shift IS physically held it is never
        // re-pressed after the key: across a continuous number-row hold the first digit releases the
        // guest Shift and it stays released, so a modifier-honouring terminal never sees a per-digit
        // Shift toggle; a following capital re-presses it (reconcile), a following digit leaves it down-
        // free. This is the digit-terminal fix AND keeps Shift+letter / capitals mid-hold correct.
        events.push(...this.syncGuestShift(mapped.shift));
        events.push(device.keyPressed(sc));
        events.push(device.keyReleased(sc));
        if (!evt.shiftKey) {
            events.push(...this.syncGuestShift(false));
        }

        for (const modSc of altGrScanCodes) {
            events.push(device.keyPressed(modSc));
        }
        this.doTransactionFromDeviceEvents(events);
    }

    /// Fallback for a non-ASCII printable character (accent, currency) that the en-US layout cannot
    /// produce with a scancode: inject the Unicode codepoint. A Shift held on the guest would be
    /// re-applied to the injected keysym and corrupt it, so reconcile the guest Shift to released for the
    /// injection and leave it released (lazy) -- the next key reconciles it back if Shift is still held.
    /// Any AltGr the client used is stripped around the injection and restored (Ctrl/Alt are not lazy).
    private sendUnicodeCharacter(evt: KeyboardEvent, stripCtrlAlt: boolean) {
        const device = this.module.DeviceEvent;
        const unicode = evt.type === 'keydown' ? device.unicodePressed : device.unicodeReleased;
        const events: DeviceEvent[] = [];

        const altGrScanCodes = stripCtrlAlt && evt.type === 'keydown' ? this.heldCtrlAltScanCodes() : [];

        for (const modSc of altGrScanCodes) {
            events.push(device.keyReleased(modSc));
        }
        if (evt.type === 'keydown') {
            events.push(...this.syncGuestShift(false));
        }
        events.push(unicode(evt.key));
        for (const modSc of altGrScanCodes) {
            events.push(device.keyPressed(modSc));
        }
        this.doTransactionFromDeviceEvents(events);
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

    /// Reconcile the GUEST's Shift to `desired`, returning only the delta and updating guestShiftScanCode.
    /// Pressing uses the physically-held Shift side (so a later physical keyup releases the SAME scancode,
    /// never stranding a side), or ShiftLeft when none is held (e.g. tapping Shift for "@"). Releasing
    /// drops whatever the guest currently holds. Never restores eagerly: the caller leaves the guest
    /// Shift in the reconciled state, so a continuous number-row hold releases Shift once instead of
    /// churning it per digit -- the terminal digit fix. Guacamole's guest-side modifier reconciliation.
    private syncGuestShift(desired: boolean): DeviceEvent[] {
        const device = this.module.DeviceEvent;
        const events: DeviceEvent[] = [];
        if (desired && this.guestShiftScanCode === null) {
            const held = this.heldShiftScanCodes();
            const sc = held.length > 0 ? held[0] : scanCode('ShiftLeft');
            if (!Number.isNaN(sc)) {
                events.push(device.keyPressed(sc));
                this.guestShiftScanCode = sc;
            }
        } else if (!desired && this.guestShiftScanCode !== null) {
            events.push(device.keyReleased(this.guestShiftScanCode));
            this.guestShiftScanCode = null;
        }
        return events;
    }

    /// Whether the client physically holds a Shift (either side), from the tracked mirror.
    private isPhysicalShiftHeld(): boolean {
        return (
            this.modifierKeyPressed.indexOf(ModifierKey.SHIFT_LEFT) !== -1 ||
            this.modifierKeyPressed.indexOf(ModifierKey.SHIFT_RIGHT) !== -1
        );
    }

    /// Windows scancodes for the Shift key(s) currently held down, as tracked in
    /// modifierKeyPressed (i.e. the ones the client physically holds). Used to pick which Shift side to
    /// press when reconciling the guest Shift so the eventual physical keyup releases the same scancode.
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

    /// Windows scancodes for the Ctrl/Alt key(s) currently held down, tracked in modifierKeyPressed --
    /// the ones we actually pressed on the guest. Strip AltGr around a character using ONLY these, so a
    /// Ctrl/Alt side the user never held is never re-pressed and stranded.
    private heldCtrlAltScanCodes(): number[] {
        const codes: number[] = [];
        for (const [modifier, keyCode] of [
            [ModifierKey.CTRL_LEFT, 'ControlLeft'],
            [ModifierKey.CTRL_RIGHT, 'ControlRight'],
            [ModifierKey.ALT_LEFT, 'AltLeft'],
            [ModifierKey.ALT_RIGHT, 'AltRight'],
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
        const idx = this.modifierKeyPressed.indexOf(modKey);

        // Gate on event type: a lone keyup with no prior keydown (focus gained mid-hold) must NOT seed a
        // phantom "held" entry -- a phantom would later be re-pressed and strand the modifier down.
        if (evt.type === 'keydown') {
            if (idx === -1) {
                this.modifierKeyPressed.push(modKey);
            }
        } else if (evt.type === 'keyup' && idx !== -1) {
            this.modifierKeyPressed.splice(idx, 1);
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
