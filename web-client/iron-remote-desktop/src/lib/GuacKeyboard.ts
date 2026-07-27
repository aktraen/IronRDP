// Client half, ported 1:1 from Guacamole 1.6 guacamole-common-js modules/Keyboard.js.
//
// Turns a browser KeyboardEvent stream (keydown/keypress/keyup) into a stream of X11 keysym
// press/release events, abstracting away browser and keyboard-layout variation exactly the way
// Guacamole.Keyboard does: an event log is interpreted incrementally (interpret_events), a keydown is
// disambiguated by the keypress that follows it when its own keysym is not reliable, modifier keysyms
// are reconciled against the event's modifier flags (syncModifierStates), Ctrl+Alt is released when it
// is only simulating AltGr for a printable (release_simulated_altgr), and Meta is deferred until it is
// known to be acting as a modifier. The macOS quirks matter here: Option is a typable modifier, so an
// Alt keysym is rewritten to AltGr -- which the server half leaves undefined on the en-US guest and
// drops, so Option-composed characters land as their base/Shift character, never as Alt+key.
//
// The emitted keysyms are consumed by GuacRdpKeyboard (the keyboard.c port) via onKeyDown/onKeyUp.

interface ModifierState {
    shift: boolean;
    ctrl: boolean;
    alt: boolean;
    meta: boolean;
    hyper: boolean;
    capsLock: boolean;
    numLock: boolean;
    scrollLock: boolean;
}

type EventType = 'keydown' | 'keypress' | 'keyup' | 'mouse';

interface LoggedEvent {
    type: EventType;
    keyCode: number;
    keyIdentifier: string | undefined;
    key: string | undefined;
    location: number;
    modifiers: ModifierState;
    keysym: number | null;
    reliable: boolean;
    keyupReliable: boolean;
    defaultPrevented: boolean;
}

function emptyModifiers(): ModifierState {
    return {
        shift: false,
        ctrl: false,
        alt: false,
        meta: false,
        hyper: false,
        capsLock: false,
        numLock: false,
        scrollLock: false,
    };
}

function modifiersFromEvent(e: KeyboardEvent | MouseEvent): ModifierState {
    const state = emptyModifiers();
    state.shift = e.shiftKey;
    state.ctrl = e.ctrlKey;
    state.alt = e.altKey;
    state.meta = e.metaKey;
    if (typeof e.getModifierState === 'function') {
        state.hyper =
            e.getModifierState('OS') ||
            e.getModifierState('Super') ||
            e.getModifierState('Hyper') ||
            e.getModifierState('Win');
        state.capsLock = e.getModifierState('CapsLock');
        state.numLock = e.getModifierState('NumLock');
        state.scrollLock = e.getModifierState('ScrollLock');
    }
    return state;
}

export class GuacKeyboard {
    onKeyDown: ((keysym: number) => boolean) | null = null;
    onKeyUp: ((keysym: number) => void) | null = null;

    // Guacamole.Keyboard.pressed: the state of every key, indexed by keysym.
    readonly pressed: Record<number, boolean> = {};

    // Guacamole.Keyboard.modifiers: the modifier state as last reconciled.
    readonly modifiers: ModifierState = emptyModifiers();

    private readonly implicitlyPressed: Record<number, boolean> = {};
    private readonly lastKeydownResult: Record<number, boolean> = {};
    private readonly recentKeysym: Record<number, number> = {};
    private readonly lastToggleKeydownState: Record<string, boolean | undefined> = {};
    private eventLog: LoggedEvent[] = [];

    private keyRepeatTimeout: ReturnType<typeof setTimeout> | null = null;
    private keyRepeatInterval: ReturnType<typeof setInterval> | null = null;

    private readonly quirks = {
        keyupUnreliable: false,
        altIsTypableOnly: false,
        lockKeyIsModifierToggle: false,
    };

    constructor() {
        const platform =
            typeof navigator !== 'undefined' && typeof navigator.platform === 'string' ? navigator.platform : '';
        if (platform !== '') {
            if (platform.match(/ipad|iphone|ipod/i)) {
                this.quirks.keyupUnreliable = true;
            } else if (platform.match(/^mac/i)) {
                this.quirks.altIsTypableOnly = true;
                this.quirks.lockKeyIsModifierToggle = true;
            }
        }
    }

    // ---- Keysym derivation (Keyboard.js free functions) ---------------------------------------

    private static readonly keycodeKeysyms: Record<number, number[]> = {
        8: [0xff08],
        9: [0xff09],
        12: [0xff0b, 0xff0b, 0xff0b, 0xffb5],
        13: [0xff0d],
        16: [0xffe1, 0xffe1, 0xffe2],
        17: [0xffe3, 0xffe3, 0xffe4],
        18: [0xffe9, 0xffe9, 0xffea],
        19: [0xff13],
        20: [0xffe5],
        27: [0xff1b],
        32: [0x0020],
        33: [0xff55, 0xff55, 0xff55, 0xffb9],
        34: [0xff56, 0xff56, 0xff56, 0xffb3],
        35: [0xff57, 0xff57, 0xff57, 0xffb1],
        36: [0xff50, 0xff50, 0xff50, 0xffb7],
        37: [0xff51, 0xff51, 0xff51, 0xffb4],
        38: [0xff52, 0xff52, 0xff52, 0xffb8],
        39: [0xff53, 0xff53, 0xff53, 0xffb6],
        40: [0xff54, 0xff54, 0xff54, 0xffb2],
        45: [0xff63, 0xff63, 0xff63, 0xffb0],
        46: [0xffff, 0xffff, 0xffff, 0xffae],
        91: [0xffe7],
        92: [0xffe8],
        93: [0xff67],
        96: [0xffb0],
        97: [0xffb1],
        98: [0xffb2],
        99: [0xffb3],
        100: [0xffb4],
        101: [0xffb5],
        102: [0xffb6],
        103: [0xffb7],
        104: [0xffb8],
        105: [0xffb9],
        106: [0xffaa],
        107: [0xffab],
        109: [0xffad],
        110: [0xffae],
        111: [0xffaf],
        112: [0xffbe],
        113: [0xffbf],
        114: [0xffc0],
        115: [0xffc1],
        116: [0xffc2],
        117: [0xffc3],
        118: [0xffc4],
        119: [0xffc5],
        120: [0xffc6],
        121: [0xffc7],
        122: [0xffc8],
        123: [0xffc9],
        144: [0xff7f],
        145: [0xff14],
        225: [0xfe03],
    };

    private static readonly keyidentifierKeysym: Record<string, (number | null)[]> = {
        Again: [0xff66],
        AllCandidates: [0xff3d],
        Alphanumeric: [0xff30],
        Alt: [0xffe9, 0xffe9, 0xffea],
        Attn: [0xfd0e],
        AltGraph: [0xfe03],
        ArrowDown: [0xff54],
        ArrowLeft: [0xff51],
        ArrowRight: [0xff53],
        ArrowUp: [0xff52],
        Backspace: [0xff08],
        CapsLock: [0xffe5],
        Cancel: [0xff69],
        Clear: [0xff0b],
        Convert: [0xff23],
        Copy: [0xfd15],
        Crsel: [0xfd1c],
        CrSel: [0xfd1c],
        CodeInput: [0xff37],
        Compose: [0xff20],
        Control: [0xffe3, 0xffe3, 0xffe4],
        ContextMenu: [0xff67],
        Delete: [0xffff],
        Down: [0xff54],
        End: [0xff57],
        Enter: [0xff0d],
        EraseEof: [0xfd06],
        Escape: [0xff1b],
        Execute: [0xff62],
        Exsel: [0xfd1d],
        ExSel: [0xfd1d],
        F1: [0xffbe],
        F2: [0xffbf],
        F3: [0xffc0],
        F4: [0xffc1],
        F5: [0xffc2],
        F6: [0xffc3],
        F7: [0xffc4],
        F8: [0xffc5],
        F9: [0xffc6],
        F10: [0xffc7],
        F11: [0xffc8],
        F12: [0xffc9],
        F13: [0xffca],
        F14: [0xffcb],
        F15: [0xffcc],
        F16: [0xffcd],
        F17: [0xffce],
        F18: [0xffcf],
        F19: [0xffd0],
        F20: [0xffd1],
        F21: [0xffd2],
        F22: [0xffd3],
        F23: [0xffd4],
        F24: [0xffd5],
        Find: [0xff68],
        GroupFirst: [0xfe0c],
        GroupLast: [0xfe0e],
        GroupNext: [0xfe08],
        GroupPrevious: [0xfe0a],
        FullWidth: [null],
        HalfWidth: [null],
        HangulMode: [0xff31],
        Hankaku: [0xff29],
        HanjaMode: [0xff34],
        Help: [0xff6a],
        Hiragana: [0xff25],
        HiraganaKatakana: [0xff27],
        Home: [0xff50],
        Hyper: [0xffed, 0xffed, 0xffee],
        Insert: [0xff63],
        JapaneseHiragana: [0xff25],
        JapaneseKatakana: [0xff26],
        JapaneseRomaji: [0xff24],
        JunjaMode: [0xff38],
        KanaMode: [0xff2d],
        KanjiMode: [0xff21],
        Katakana: [0xff26],
        Left: [0xff51],
        Meta: [0xffe7, 0xffe7, 0xffe8],
        ModeChange: [0xff7e],
        NonConvert: [0xff22],
        NumLock: [0xff7f],
        PageDown: [0xff56],
        PageUp: [0xff55],
        Pause: [0xff13],
        Play: [0xfd16],
        PreviousCandidate: [0xff3e],
        PrintScreen: [0xff61],
        Redo: [0xff66],
        Right: [0xff53],
        Romaji: [0xff24],
        RomanCharacters: [null],
        Scroll: [0xff14],
        Select: [0xff60],
        Separator: [0xffac],
        Shift: [0xffe1, 0xffe1, 0xffe2],
        SingleCandidate: [0xff3c],
        Super: [0xffeb, 0xffeb, 0xffec],
        Tab: [0xff09],
        UIKeyInputDownArrow: [0xff54],
        UIKeyInputEscape: [0xff1b],
        UIKeyInputLeftArrow: [0xff51],
        UIKeyInputRightArrow: [0xff53],
        UIKeyInputUpArrow: [0xff52],
        Up: [0xff52],
        Undo: [0xff65],
        Win: [0xffe7, 0xffe7, 0xffe8],
        Zenkaku: [0xff28],
        ZenkakuHankaku: [0xff2a],
    };

    private static readonly modifierKeysymsByType: Record<string, number[]> = {
        shift: [0xffe1, 0xffe2],
        ctrl: [0xffe3, 0xffe4],
        alt: [0xffe9, 0xffea, 0xfe03],
        meta: [0xffe7, 0xffe8],
        hyper: [0xffeb, 0xffec],
    };

    private static readonly modifierKeysyms: Record<number, boolean> = (() => {
        const lookup: Record<number, boolean> = {};
        for (const modifier in GuacKeyboard.modifierKeysymsByType) {
            for (const keysym of GuacKeyboard.modifierKeysymsByType[modifier]) {
                lookup[keysym] = true;
            }
        }
        return lookup;
    })();

    private static readonly toggleModifierKeysymsByType: Record<string, number[]> = {
        capsLock: [0xffe5],
        numLock: [0xff7f],
        scrollLock: [0xff14],
    };

    private static readonly noRepeat: Record<number, boolean> = {
        0xfe03: true,
        0xffe1: true,
        0xffe2: true,
        0xffe3: true,
        0xffe4: true,
        0xffe5: true,
        0xffe7: true,
        0xffe8: true,
        0xffe9: true,
        0xffea: true,
        0xffeb: true,
        0xffec: true,
    };

    private static getKeysym(keysyms: (number | null)[] | undefined, location: number): number | null {
        if (!keysyms) {
            return null;
        }
        return keysyms[location] ?? keysyms[0];
    }

    private static isPrintable(keysym: number): boolean {
        return (keysym >= 0x00 && keysym <= 0xff) || (keysym & 0xffff0000) === 0x01000000;
    }

    private static isControlCharacter(codepoint: number): boolean {
        return codepoint <= 0x1f || (codepoint >= 0x7f && codepoint <= 0x9f);
    }

    private static keysymFromCharcode(codepoint: number): number | null {
        if (GuacKeyboard.isControlCharacter(codepoint)) {
            return 0xff00 | codepoint;
        }
        if (codepoint >= 0x0000 && codepoint <= 0x00ff) {
            return codepoint;
        }
        if (codepoint >= 0x0100 && codepoint <= 0x10ffff) {
            return 0x01000000 | codepoint;
        }
        return null;
    }

    private static keysymFromKeycode(keyCode: number, location: number): number | null {
        return GuacKeyboard.getKeysym(GuacKeyboard.keycodeKeysyms[keyCode], location);
    }

    private static keysymFromKeyIdentifier(
        identifier: string | undefined,
        location: number,
        shifted?: boolean,
    ): number | null {
        if (identifier === undefined || identifier === '') {
            return null;
        }

        let typedCharacter: string;

        const unicodePrefixLocation = identifier.indexOf('U+');
        if (unicodePrefixLocation >= 0) {
            const hex = identifier.substring(unicodePrefixLocation + 2);
            typedCharacter = String.fromCharCode(parseInt(hex, 16));
        } else if (identifier.length === 1 && location !== 3) {
            typedCharacter = identifier;
        } else {
            return GuacKeyboard.getKeysym(GuacKeyboard.keyidentifierKeysym[identifier], location);
        }

        if (shifted === true) {
            typedCharacter = typedCharacter.toUpperCase();
        } else if (shifted === false) {
            typedCharacter = typedCharacter.toLowerCase();
        }

        const codepoint = typedCharacter.charCodeAt(0);
        return GuacKeyboard.keysymFromCharcode(codepoint);
    }

    private static keyIdentifierSane(keyCode: number, keyIdentifier: string | undefined): boolean {
        if (keyIdentifier === undefined || keyIdentifier === '') {
            return false;
        }
        const unicodePrefixLocation = keyIdentifier.indexOf('U+');
        if (unicodePrefixLocation === -1) {
            return true;
        }
        const codepoint = parseInt(keyIdentifier.substring(unicodePrefixLocation + 2), 16);
        if (keyCode !== codepoint) {
            return true;
        }
        if ((keyCode >= 65 && keyCode <= 90) || (keyCode >= 48 && keyCode <= 57)) {
            return true;
        }
        return false;
    }

    private static isCapsLockKey(keysym: number): boolean {
        return GuacKeyboard.toggleModifierKeysymsByType.capsLock.indexOf(keysym) !== -1;
    }
    private static isNumLockKey(keysym: number): boolean {
        return GuacKeyboard.toggleModifierKeysymsByType.numLock.indexOf(keysym) !== -1;
    }
    private static isScrollLockKey(keysym: number): boolean {
        return GuacKeyboard.toggleModifierKeysymsByType.scrollLock.indexOf(keysym) !== -1;
    }
    private static isLockKey(keysym: number): boolean {
        return (
            GuacKeyboard.isCapsLockKey(keysym) ||
            GuacKeyboard.isNumLockKey(keysym) ||
            GuacKeyboard.isScrollLockKey(keysym)
        );
    }
    private static isMetaKey(keysym: number): boolean {
        return GuacKeyboard.modifierKeysymsByType.meta.indexOf(keysym) !== -1;
    }
    private static isModifierKey(keysym: number): boolean {
        return GuacKeyboard.modifierKeysyms[keysym] === true;
    }

    private static getEventLocation(e: KeyboardEvent): number {
        if ('location' in e) {
            return e.location;
        }
        return 0;
    }

    // ---- Event construction (KeydownEvent / KeypressEvent / KeyupEvent) ------------------------

    private makeKeydown(orig: KeyboardEvent): LoggedEvent {
        const evt: LoggedEvent = {
            type: 'keydown',
            keyCode: orig.which !== 0 ? orig.which : orig.keyCode,
            keyIdentifier: (orig as unknown as { keyIdentifier?: string }).keyIdentifier,
            key: orig.key,
            location: GuacKeyboard.getEventLocation(orig),
            modifiers: modifiersFromEvent(orig),
            keysym: null,
            reliable: false,
            keyupReliable: !this.quirks.keyupUnreliable,
            defaultPrevented: false,
        };

        evt.keysym =
            GuacKeyboard.keysymFromKeyIdentifier(evt.key, evt.location) ??
            GuacKeyboard.keysymFromKeycode(evt.keyCode, evt.location);

        if (evt.keysym !== null && !GuacKeyboard.isPrintable(evt.keysym)) {
            evt.reliable = true;
        }

        if (evt.keysym === null && GuacKeyboard.keyIdentifierSane(evt.keyCode, evt.keyIdentifier)) {
            evt.keysym = GuacKeyboard.keysymFromKeyIdentifier(evt.keyIdentifier, evt.location, evt.modifiers.shift);
        }

        if (evt.modifiers.meta && evt.keysym !== null && !GuacKeyboard.isModifierKey(evt.keysym)) {
            evt.keyupReliable = false;
        } else if (evt.keysym !== null && GuacKeyboard.isLockKey(evt.keysym) && this.quirks.lockKeyIsModifierToggle) {
            evt.keyupReliable = false;
        }

        const preventAlt = !evt.modifiers.ctrl && !this.quirks.altIsTypableOnly;

        if (this.quirks.altIsTypableOnly && (evt.keysym === 0xffe9 || evt.keysym === 0xffea)) {
            evt.keysym = 0xfe03;
        }

        const preventCtrl = !evt.modifiers.alt;

        if (
            (preventCtrl && evt.modifiers.ctrl) ||
            (preventAlt && evt.modifiers.alt) ||
            evt.modifiers.meta ||
            evt.modifiers.hyper
        ) {
            evt.reliable = true;
        }

        this.recentKeysym[evt.keyCode] = evt.keysym as number;

        return evt;
    }

    private makeKeypress(orig: KeyboardEvent): LoggedEvent {
        const keyCode = orig.which !== 0 ? orig.which : orig.keyCode;
        return {
            type: 'keypress',
            keyCode,
            keyIdentifier: (orig as unknown as { keyIdentifier?: string }).keyIdentifier,
            key: orig.key,
            location: GuacKeyboard.getEventLocation(orig),
            modifiers: modifiersFromEvent(orig),
            keysym: GuacKeyboard.keysymFromCharcode(keyCode),
            reliable: true,
            keyupReliable: !this.quirks.keyupUnreliable,
            defaultPrevented: false,
        };
    }

    private makeKeyup(orig: KeyboardEvent): LoggedEvent {
        const evt: LoggedEvent = {
            type: 'keyup',
            keyCode: orig.which !== 0 ? orig.which : orig.keyCode,
            keyIdentifier: (orig as unknown as { keyIdentifier?: string }).keyIdentifier,
            key: orig.key,
            location: GuacKeyboard.getEventLocation(orig),
            modifiers: modifiersFromEvent(orig),
            keysym: null,
            reliable: true,
            keyupReliable: !this.quirks.keyupUnreliable,
            defaultPrevented: false,
        };

        evt.keysym =
            GuacKeyboard.keysymFromKeycode(evt.keyCode, evt.location) ??
            GuacKeyboard.keysymFromKeyIdentifier(evt.key, evt.location);

        if (evt.keysym === null || !this.pressed[evt.keysym]) {
            evt.keysym = this.recentKeysym[evt.keyCode] ?? evt.keysym;
        }

        return evt;
    }

    // ---- Press / release -----------------------------------------------------------------------

    press(keysym: number | null): boolean {
        if (keysym === null) {
            return false;
        }

        if (!this.pressed[keysym]) {
            this.pressed[keysym] = true;

            if (this.onKeyDown) {
                const result = this.onKeyDown(keysym);

                if (GuacKeyboard.isCapsLockKey(keysym)) {
                    this.modifiers.capsLock = !this.modifiers.capsLock;
                } else if (GuacKeyboard.isNumLockKey(keysym)) {
                    this.modifiers.numLock = !this.modifiers.numLock;
                } else if (GuacKeyboard.isScrollLockKey(keysym)) {
                    this.modifiers.scrollLock = !this.modifiers.scrollLock;
                }

                this.lastKeydownResult[keysym] = result;

                if (this.keyRepeatTimeout !== null) {
                    clearTimeout(this.keyRepeatTimeout);
                }
                if (this.keyRepeatInterval !== null) {
                    clearInterval(this.keyRepeatInterval);
                }

                if (!GuacKeyboard.noRepeat[keysym]) {
                    this.keyRepeatTimeout = setTimeout(() => {
                        this.keyRepeatInterval = setInterval(() => {
                            if (this.onKeyUp) {
                                this.onKeyUp(keysym);
                            }
                            if (this.onKeyDown) {
                                this.onKeyDown(keysym);
                            }
                        }, 50);
                    }, 500);
                }

                return result;
            }
        }

        return this.lastKeydownResult[keysym] || false;
    }

    release(keysym: number | null): void {
        if (keysym === null) {
            return;
        }

        if (this.pressed[keysym]) {
            delete this.pressed[keysym];
            delete this.implicitlyPressed[keysym];

            if (this.keyRepeatTimeout !== null) {
                clearTimeout(this.keyRepeatTimeout);
            }
            if (this.keyRepeatInterval !== null) {
                clearInterval(this.keyRepeatInterval);
            }

            if (this.onKeyUp) {
                this.onKeyUp(keysym);
            }
        }
    }

    type(str: string): void {
        for (let i = 0; i < str.length; i++) {
            const codepoint = str.codePointAt(i) ?? str.charCodeAt(i);
            if (str.charCodeAt(i) !== codepoint) {
                i++;
            }
            const keysym = GuacKeyboard.keysymFromCharcode(codepoint);
            this.press(keysym);
            this.release(keysym);
        }
    }

    reset(): void {
        for (const keysym in this.pressed) {
            this.release(parseInt(keysym));
        }
        this.eventLog = [];
    }

    // ---- Modifier reconciliation ---------------------------------------------------------------

    private updateModifierState(modifier: keyof ModifierState, keysyms: number[], keyEvent: LoggedEvent): void {
        const localState = keyEvent.modifiers[modifier];
        const remoteState = this.modifiers[modifier];

        if (keyEvent.keysym !== null && keysyms.indexOf(keyEvent.keysym) !== -1) {
            return;
        }

        if (remoteState && localState === false) {
            for (const keysym of keysyms) {
                this.release(keysym);
            }
        } else if (!remoteState && localState) {
            for (const keysym of keysyms) {
                if (this.pressed[keysym]) {
                    return;
                }
            }

            const keysym = keysyms[0];
            if (keyEvent.keysym !== null) {
                this.implicitlyPressed[keysym] = true;
            }
            this.press(keysym);
        }
    }

    private updateToggleModifierState(
        modifier: keyof ModifierState,
        keysyms: number[],
        keyEvent: { modifiers: ModifierState; keysym: number | null; type?: EventType },
    ): void {
        const localToggleState = keyEvent.modifiers[modifier];
        if (localToggleState === undefined) {
            return;
        }

        if (keyEvent.keysym === keysyms[0] && keyEvent.type === 'keydown') {
            this.lastToggleKeydownState[modifier] = localToggleState;
            return;
        }

        if (keyEvent.keysym === keysyms[0] && keyEvent.type === 'keyup') {
            if (this.lastToggleKeydownState[modifier] === localToggleState) {
                return;
            }
        }

        if (localToggleState !== this.modifiers[modifier]) {
            const keysym = keysyms[0];
            this.press(keysym);
            this.release(keysym);
        }
    }

    private syncToggleModifierStates(modifierState: ModifierState): void {
        for (const modifier of ['capsLock', 'numLock', 'scrollLock'] as const) {
            this.updateToggleModifierState(modifier, GuacKeyboard.toggleModifierKeysymsByType[modifier], {
                modifiers: modifierState,
                keysym: null,
            });
        }
    }

    private syncModifierStates(keyEvent: LoggedEvent): void {
        this.updateModifierState('alt', GuacKeyboard.modifierKeysymsByType.alt, keyEvent);
        this.updateModifierState('shift', GuacKeyboard.modifierKeysymsByType.shift, keyEvent);
        this.updateModifierState('ctrl', GuacKeyboard.modifierKeysymsByType.ctrl, keyEvent);
        this.updateModifierState('meta', GuacKeyboard.modifierKeysymsByType.meta, keyEvent);
        this.updateModifierState('hyper', GuacKeyboard.modifierKeysymsByType.hyper, keyEvent);

        this.modifiers.shift = keyEvent.modifiers.shift;
        this.modifiers.ctrl = keyEvent.modifiers.ctrl;
        this.modifiers.alt = keyEvent.modifiers.alt;
        this.modifiers.meta = keyEvent.modifiers.meta;
        this.modifiers.hyper = keyEvent.modifiers.hyper;

        this.updateToggleModifierState('capsLock', GuacKeyboard.toggleModifierKeysymsByType.capsLock, keyEvent);
        this.updateToggleModifierState('numLock', GuacKeyboard.toggleModifierKeysymsByType.numLock, keyEvent);
        this.updateToggleModifierState('scrollLock', GuacKeyboard.toggleModifierKeysymsByType.scrollLock, keyEvent);
    }

    private isStateImplicit(): boolean {
        for (const keysym in this.pressed) {
            if (!this.implicitlyPressed[keysym]) {
                return false;
            }
        }
        return true;
    }

    private releaseSimulatedAltgr(keysym: number): void {
        if (!this.modifiers.ctrl || !this.modifiers.alt) {
            return;
        }
        if (keysym >= 0x0041 && keysym <= 0x005a) {
            return;
        }
        if (keysym >= 0x0061 && keysym <= 0x007a) {
            return;
        }
        if (keysym <= 0xff || (keysym & 0xff000000) === 0x01000000) {
            this.release(0xffe3);
            this.release(0xffe4);
            this.release(0xffe9);
            this.release(0xffea);
        }
    }

    // ---- Event log interpretation --------------------------------------------------------------

    private interpretEvents(): boolean {
        let handledEvent = this.interpretEvent();
        if (!handledEvent) {
            return false;
        }

        let lastEvent: LoggedEvent;
        do {
            lastEvent = handledEvent;
            handledEvent = this.interpretEvent();
        } while (handledEvent !== null);

        if (this.isStateImplicit()) {
            this.reset();
        }

        return lastEvent.defaultPrevented;
    }

    private interpretEvent(): LoggedEvent | null {
        const first: LoggedEvent | undefined = this.eventLog[0];
        if (first === undefined) {
            return null;
        }

        if (first.type === 'keydown') {
            let keysym: number | null = null;
            let acceptedEvents: LoggedEvent[] = [];

            if (first.keysym !== null && GuacKeyboard.isMetaKey(first.keysym)) {
                if (this.eventLog.length === 1) {
                    return null;
                }

                if (this.eventLog[1].keysym !== first.keysym) {
                    if (!this.eventLog[1].modifiers.meta) {
                        return this.eventLog.shift() ?? null;
                    }
                } else if (this.eventLog[1].type === 'keydown') {
                    return this.eventLog.shift() ?? null;
                }
            }

            if (first.keysym === 0xffe3 && !first.modifiers.ctrl) {
                return this.eventLog.shift() ?? null;
            }

            if (first.reliable) {
                keysym = first.keysym;
                acceptedEvents = this.eventLog.splice(0, 1);
            } else if (this.eventLog.length > 1 && this.eventLog[1].type === 'keypress') {
                keysym = this.eventLog[1].keysym;
                acceptedEvents = this.eventLog.splice(0, 2);
            } else if (this.eventLog.length > 1) {
                keysym = first.keysym;
                acceptedEvents = this.eventLog.splice(0, 1);
            }

            if (acceptedEvents.length > 0) {
                this.syncModifierStates(first);

                if (keysym !== null) {
                    this.releaseSimulatedAltgr(keysym);
                    const defaultPrevented = !this.press(keysym);
                    this.recentKeysym[first.keyCode] = keysym;

                    if (!first.keyupReliable) {
                        this.release(keysym);
                    }

                    for (const accepted of acceptedEvents) {
                        accepted.defaultPrevented = defaultPrevented;
                    }
                }

                return first;
            }
        } else if (first.type === 'keyup' && !this.quirks.keyupUnreliable) {
            const keysym = first.keysym;
            if (keysym !== null) {
                this.release(keysym);
                delete this.recentKeysym[first.keyCode];
                first.defaultPrevented = true;
            } else {
                this.reset();
                return first;
            }

            this.syncModifierStates(first);
            return this.eventLog.shift() ?? null;
        } else {
            return this.eventLog.shift() ?? null;
        }

        return null;
    }

    // ---- Public entry points (replacing Keyboard.js listenTo) ----------------------------------

    // Returns true if the default action should be prevented.
    handleKeyDown(e: KeyboardEvent): boolean {
        const keydownEvent = this.makeKeydown(e);

        if (e.isComposing || keydownEvent.keyCode === 229) {
            return false;
        }

        this.eventLog.push(keydownEvent);
        return this.interpretEvents();
    }

    handleKeyPress(e: KeyboardEvent): boolean {
        this.eventLog.push(this.makeKeypress(e));
        return this.interpretEvents();
    }

    handleKeyUp(e: KeyboardEvent): boolean {
        this.eventLog.push(this.makeKeyup(e));
        return this.interpretEvents();
    }

    updateModifiersFromMouse(mouseEvent: MouseEvent): void {
        if (!this.onKeyDown && !this.onKeyUp) {
            return;
        }
        const modifiers = modifiersFromEvent(mouseEvent);
        this.syncToggleModifierStates(modifiers);

        const hasPendingMeta =
            this.eventLog.length > 0 &&
            this.eventLog[0].type === 'keydown' &&
            this.eventLog[0].keysym !== null &&
            GuacKeyboard.isMetaKey(this.eventLog[0].keysym);

        if (modifiers.meta && hasPendingMeta) {
            this.eventLog.push({
                type: 'mouse',
                keyCode: 0,
                keyIdentifier: undefined,
                key: undefined,
                location: 0,
                modifiers,
                keysym: null,
                reliable: false,
                keyupReliable: true,
                defaultPrevented: false,
            });
            this.interpretEvents();
        }
    }
}
