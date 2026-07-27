// Server half, ported 1:1 from Guacamole 1.6 guacamole-server src/protocols/rdp/keyboard.c.
//
// This is guacd's keysym -> scancode + modifier state machine. It receives X11 keysyms (press/release)
// from the client half (GuacKeyboard, the Keyboard.js port) and emits the RDP scancode + Shift/AltGr
// key events required to reproduce that keysym on the French-pinned guest (WASM advertises
// keyboard_layout=0x040C, so xrdp sets the guest XKB to "fr" at session start), reconciling the guest's
// modifier state LAZILY: only the delta between the modifiers the guest currently holds and the ones
// the target keysym requires is sent. This is what makes typing terminal-correct -- e.g. a Shift-held
// number row releases/re-uses the guest Shift without per-digit churn because get_modifier_flags derives
// Shift from the guest's ACTUAL pressed scancodes, not the client's physical Shift. When the client has
// released every key, the server releases everything it still holds (guac_rdp_keyboard_reset), including
// any Shift/AltGr it pressed on the guest's behalf.
//
// The French pin is what lets accents type as NATIVE scancodes (é è à ç ù are direct keys; ê ë â û î ï
// ô ö ü compose via the dead circumflex/dieresis keys, see decompose below) -- which xkb terminals
// (Alacritty) receive, unlike an RDP Unicode injection, which this guest's xrdp surfaces only to
// IM-aware GTK apps. The client half stays character-keyed (evt.key), so this is correct for every
// client layout (AZERTY / BEPO / QWERTY): the character the user meant is reproduced with the French
// scancode + Shift/AltGr that yields it.
//
// Deliberate deviations from keyboard.c, documented so the coordinator can diff against the source:
//   1. Lock keys (Caps/Num/Scroll) are NOT synchronized from here. keyboard.c drives guest locks via a
//      SynchronizeEvent; here the guest's lock state is owned out-of-band by the service
//      (session.synchronizeLockKeys, forcing Caps OFF because case is already encoded in the character
//      keysym + Shift). lock_flags is kept only for the cost model.
//   2. Truly undefined keysyms -- a character neither on the French layout nor decomposable via a dead
//      key defined in it (e.g. German sharp-s, or accents needing dead acute/grave/tilde, which fr does
//      not define) -- fall back to an RDP Unicode event, matching send_missing_key's Unicode fallback.
//      Like keyboard.c, that is exactly ONE Unicode event on the press (no matching release: a release
//      makes xrdp un-map the temporary keycode before an xkb terminal resolves it). Such characters
//      therefore appear only in IM-aware/GUI fields, not in xkb terminals -- an accepted tradeoff for a
//      French deployment.

import {
    GUEST_KEYMAP,
    keysymScancode,
    type KeysymDesc,
    MOD_SHIFT,
    MOD_ALTGR,
    LOCK_SCROLL,
    LOCK_NUM,
    LOCK_CAPS,
    LOCK_KANA,
    KEYSYM_LSHIFT,
    KEYSYM_RSHIFT,
    KEYSYM_LCTRL,
    KEYSYM_RCTRL,
    KEYSYM_LALT,
    KEYSYM_RALT,
    KEYSYM_ALTGR,
    KEYSYM_CAPS_LOCK,
    KEYSYM_NUM_LOCK,
    KEYSYM_SCROLL_LOCK,
    KEYSYM_KANA_LOCK,
} from './guacKeyboardMap';

// The source of a key event, mirroring guac_rdp_key_source. Only CLIENT events adjust the count of
// user-held keys (and thus trigger the release-everything reset); SYNTHETIC events are the modifier
// presses/releases the server issues on the user's behalf.
export const enum KeySource {
    Client = 0,
    Synthetic = 1,
}

// The sink the state machine emits to. Scancodes are already 0xE000-encoded for extended keys.
// sendUnicode types a single character via an RDP Unicode event (no press/release state).
export interface GuacRdpKeyboardSink {
    sendScancode(scancode: number, pressed: boolean): void;
    sendUnicode(codepoint: number): void;
}

interface GuacRdpKey {
    definitions: KeysymDesc[];
    pressed: KeysymDesc | null;
    userPressed: boolean;
}

function countBits(value: number): number {
    let bits = 0;
    let v = value;
    while (v !== 0) {
        bits += v & 1;
        v >>>= 1;
    }
    return bits;
}

export class GuacRdpKeyboard {
    private readonly sink: GuacRdpKeyboardSink;
    private readonly keysByKeysym = new Map<number, GuacRdpKey>();

    // The guest's lock state, kept only for the cost model (see file header deviation 1).
    private lockFlags = 0;

    // The number of keys the USER is currently holding on the client side (guac_rdp_keyboard's
    // user_pressed_keys). Synthetic modifier events do not count. When it reaches zero, the server
    // releases everything it still holds.
    private userPressedKeys = 0;

    constructor(sink: GuacRdpKeyboardSink) {
        this.sink = sink;
        for (const mapping of GUEST_KEYMAP) {
            this.addMapping(mapping);
        }
    }

    // guac_rdp_keyboard_map_key: keysyms 0x0000..0xFFFF map to themselves; Unicode-derived keysyms
    // 0x1000000..0x100FFFF map to 0x10000 + low 16 bits; everything else is unmappable.
    private static mapIndex(keysym: number): number | null {
        if (keysym >= 0x0000 && keysym <= 0xffff) {
            return keysym;
        }
        if (keysym >= 0x1000000 && keysym <= 0x100ffff) {
            return 0x10000 + (keysym & 0xffff);
        }
        return null;
    }

    private addMapping(mapping: KeysymDesc): void {
        const index = GuacRdpKeyboard.mapIndex(mapping.keysym);
        if (index === null) {
            return;
        }
        let key = this.keysByKeysym.get(index);
        if (key === undefined) {
            key = { definitions: [], pressed: null, userPressed: false };
            this.keysByKeysym.set(index, key);
        }
        key.definitions.push(mapping);
    }

    private getKey(keysym: number): GuacRdpKey | null {
        const index = GuacRdpKeyboard.mapIndex(keysym);
        if (index === null) {
            return null;
        }
        return this.keysByKeysym.get(index) ?? null;
    }

    private isPressed(keysym: number): boolean {
        const key = this.getKey(keysym);
        return key !== null && key.pressed !== null;
    }

    // guac_rdp_keyboard_get_modifier_flags: derive the guest's modifier state from the scancodes it
    // ACTUALLY holds -- including AltGr simulated by holding Ctrl+Alt. This is the crux of the lazy
    // reconciliation: it reflects the guest, never the client's physical modifiers.
    private getModifierFlags(): number {
        let flags = 0;

        if (this.isPressed(KEYSYM_LSHIFT) || this.isPressed(KEYSYM_RSHIFT)) {
            flags |= MOD_SHIFT;
        }

        if (this.isPressed(KEYSYM_RALT) || this.isPressed(KEYSYM_ALTGR)) {
            flags |= MOD_ALTGR;
        }

        if (this.isPressed(KEYSYM_LALT) && (this.isPressed(KEYSYM_RCTRL) || this.isPressed(KEYSYM_LCTRL))) {
            flags |= MOD_ALTGR;
        }

        return flags;
    }

    // guac_rdp_keyboard_get_cost: how many RDP events typing this definition would take given the
    // current lock/modifier state. Lower is better; used to choose between a key's definitions.
    private getCost(def: KeysymDesc): number {
        const modifierFlags = this.getModifierFlags();

        let cost = 1;

        const setLocks = def.setLocks ?? 0;
        const clearLocks = def.clearLocks ?? 0;
        const updateLocks = (setLocks & ~this.lockFlags) | (clearLocks & this.lockFlags);
        cost += countBits(updateLocks) * 2;

        const setMod = def.setMod ?? 0;
        const clearMod = def.clearMod ?? 0;
        const updateModifiers = (clearMod & modifierFlags) | (setMod & ~modifierFlags);
        cost += countBits(updateModifiers);

        return cost;
    }

    // guac_rdp_keyboard_get_definition: keep the same definition for as long as the key is held;
    // otherwise pick the lowest-cost definition for the current state.
    private getDefinition(key: GuacRdpKey): KeysymDesc {
        if (key.pressed !== null) {
            return key.pressed;
        }

        let bestDef = key.definitions[0];
        let bestCost = this.getCost(bestDef);

        for (let i = 1; i < key.definitions.length; i++) {
            const def = key.definitions[i];
            const cost = this.getCost(def);
            if (cost < bestCost) {
                bestDef = def;
                bestCost = cost;
            }
        }

        return bestDef;
    }

    // guac_rdp_keyboard_send_defined_key: reconcile locks/modifiers (only on press), then fire the key.
    private sendDefinedKey(key: GuacRdpKey, pressed: boolean): KeysymDesc | null {
        const def = this.getDefinition(key);
        if (def.scancode === 0) {
            return null;
        }

        if (pressed) {
            this.updateLocks(def.setLocks ?? 0, def.clearLocks ?? 0);
            this.updateModifiers(def.setMod ?? 0, def.clearMod ?? 0);
        }

        this.sink.sendScancode(keysymScancode(def), pressed);
        return def;
    }

    // guac_rdp_decomposed_keys (decompose.c): accented Latin-1 char keysym -> [dead-key keysym, base-key
    // keysym]. Dead keysyms: grave 0xfe50, acute 0xfe51, circumflex 0xfe52, tilde 0xfe53, dieresis
    // 0xfe57, abovering 0xfe58. Base keysyms are the plain characters (' ', A-Z, a-z).
    private static readonly decomposedKeys = new Map<number, [number, number]>([
        [0x5e, [0xfe52, 0x20]],
        [0x60, [0xfe50, 0x20]],
        [0x7e, [0xfe53, 0x20]],
        [0xa8, [0xfe57, 0x20]],
        [0xb4, [0xfe51, 0x20]],
        [0xc0, [0xfe50, 0x41]],
        [0xc1, [0xfe51, 0x41]],
        [0xc2, [0xfe52, 0x41]],
        [0xc3, [0xfe53, 0x41]],
        [0xc4, [0xfe57, 0x41]],
        [0xc5, [0xfe58, 0x41]],
        [0xc8, [0xfe50, 0x45]],
        [0xc9, [0xfe51, 0x45]],
        [0xca, [0xfe52, 0x45]],
        [0xcb, [0xfe57, 0x45]],
        [0xcc, [0xfe50, 0x49]],
        [0xcd, [0xfe51, 0x49]],
        [0xce, [0xfe52, 0x49]],
        [0xcf, [0xfe57, 0x49]],
        [0xd1, [0xfe53, 0x4e]],
        [0xd2, [0xfe50, 0x4f]],
        [0xd3, [0xfe51, 0x4f]],
        [0xd4, [0xfe52, 0x4f]],
        [0xd5, [0xfe53, 0x4f]],
        [0xd6, [0xfe57, 0x4f]],
        [0xd9, [0xfe50, 0x55]],
        [0xda, [0xfe51, 0x55]],
        [0xdb, [0xfe52, 0x55]],
        [0xdc, [0xfe57, 0x55]],
        [0xdd, [0xfe51, 0x59]],
        [0xe0, [0xfe50, 0x61]],
        [0xe1, [0xfe51, 0x61]],
        [0xe2, [0xfe52, 0x61]],
        [0xe3, [0xfe53, 0x61]],
        [0xe4, [0xfe57, 0x61]],
        [0xe5, [0xfe58, 0x61]],
        [0xe8, [0xfe50, 0x65]],
        [0xe9, [0xfe51, 0x65]],
        [0xea, [0xfe52, 0x65]],
        [0xeb, [0xfe57, 0x65]],
        [0xec, [0xfe50, 0x69]],
        [0xed, [0xfe51, 0x69]],
        [0xee, [0xfe52, 0x69]],
        [0xef, [0xfe57, 0x69]],
        [0xf1, [0xfe53, 0x6e]],
        [0xf2, [0xfe50, 0x6f]],
        [0xf3, [0xfe51, 0x6f]],
        [0xf4, [0xfe52, 0x6f]],
        [0xf5, [0xfe53, 0x6f]],
        [0xf6, [0xfe57, 0x6f]],
        [0xf9, [0xfe50, 0x75]],
        [0xfa, [0xfe51, 0x75]],
        [0xfb, [0xfe52, 0x75]],
        [0xfc, [0xfe57, 0x75]],
        [0xfd, [0xfe51, 0x79]],
        [0xff, [0xfe57, 0x79]],
    ]);

    // guac_rdp_keyboard_send_missing_key: first try to type the character as a dead key + base key using
    // REAL scancodes (guac_rdp_decompose_keysym) -- on the French guest, e-circumflex etc. compose via
    // the dead circumflex/dieresis keys and land in xkb terminals like Alacritty. Only if decomposition
    // is not possible does it fall back to a single RDP Unicode event (which this guest's xrdp surfaces
    // only to IM-aware apps, not xkb terminals). Like keyboard.c, the Unicode fallback fires exactly ONE
    // event on the press; sending a matching Unicode RELEASE makes xrdp un-map the temporary keycode
    // before an xkb terminal resolves it, so no release is sent.
    private sendMissingKey(keysym: number): void {
        if (this.decompose(keysym)) {
            return;
        }
        let codepoint: number;
        if (keysym <= 0xff) {
            codepoint = keysym;
        } else if (keysym >= 0x1000000) {
            codepoint = keysym & 0xffffff;
        } else {
            return;
        }
        this.sink.sendUnicode(codepoint);
    }

    // guac_rdp_decompose_keysym + guac_rdp_decomposed_keys (decompose.c). Types an accented Latin-1
    // character as a dead key followed by its base key, both as real scancodes, when both keysyms are
    // defined in the current keymap. Returns true if the keysym was handled this way.
    private decompose(keysym: number): boolean {
        if (keysym < 0x00 || keysym > 0xff) {
            return false;
        }
        const entry = GuacRdpKeyboard.decomposedKeys.get(keysym);
        if (entry === undefined) {
            return false;
        }
        const [dead, base] = entry;
        if (this.getKey(dead) === null || this.getKey(base) === null) {
            return false;
        }
        this.updateKeysym(dead, true, KeySource.Synthetic);
        this.updateKeysym(dead, false, KeySource.Synthetic);
        this.updateKeysym(base, true, KeySource.Synthetic);
        this.updateKeysym(base, false, KeySource.Synthetic);
        return true;
    }

    // guac_rdp_keyboard_update_locks: kept faithful for the cost model; the guest is NOT synchronized
    // from here (see header deviation 1).
    updateLocks(setFlags: number, clearFlags: number): void {
        this.lockFlags = (this.lockFlags | setFlags) & ~clearFlags;
    }

    // guac_rdp_keyboard_update_modifiers: press/release only the Shift/AltGr delta between what the
    // guest holds now and what is wanted. Releasing AltGr also releases the Ctrl+Alt that may be
    // simulating it. All issued as SYNTHETIC events so they do not disturb the user-held-key count.
    updateModifiers(setFlags: number, clearFlags: number): void {
        const modifierFlags = this.getModifierFlags();

        const clear = clearFlags & modifierFlags;
        const set = setFlags & ~modifierFlags;

        if ((set & MOD_SHIFT) !== 0) {
            this.updateKeysym(KEYSYM_LSHIFT, true, KeySource.Synthetic);
        } else if ((clear & MOD_SHIFT) !== 0) {
            this.updateKeysym(KEYSYM_LSHIFT, false, KeySource.Synthetic);
            this.updateKeysym(KEYSYM_RSHIFT, false, KeySource.Synthetic);
        }

        if ((set & MOD_ALTGR) !== 0) {
            this.updateKeysym(KEYSYM_ALTGR, true, KeySource.Synthetic);
        } else if ((clear & MOD_ALTGR) !== 0) {
            this.updateKeysym(KEYSYM_ALTGR, false, KeySource.Synthetic);
            this.updateKeysym(KEYSYM_LALT, false, KeySource.Synthetic);
            this.updateKeysym(KEYSYM_RALT, false, KeySource.Synthetic);
            this.updateKeysym(KEYSYM_LCTRL, false, KeySource.Synthetic);
            this.updateKeysym(KEYSYM_RCTRL, false, KeySource.Synthetic);
        }
    }

    // guac_rdp_keyboard_update_keysym: the entry point. Tracks the user-held-key count for client
    // events, sends the key only when the guest's state for it actually changes, and once the user is
    // holding nothing, releases everything the server still holds.
    updateKeysym(keysym: number, pressed: boolean, source: KeySource): void {
        const key = this.getKey(keysym);

        if (source === KeySource.Client && key !== null) {
            if (pressed && !key.userPressed) {
                this.userPressedKeys++;
                key.userPressed = true;
            } else if (!pressed && key.userPressed) {
                this.userPressedKeys--;
                key.userPressed = false;
            }
        }

        if (key === null || (pressed && key.pressed === null) || (!pressed && key.pressed !== null)) {
            if (pressed) {
                this.lockFlags ^= GuacRdpKeyboard.lockFlag(keysym);
            }

            let definition: KeysymDesc | null = null;
            if (key !== null) {
                definition = this.sendDefinedKey(key, pressed);
                key.pressed = pressed ? definition : null;
            }

            if (definition === null && pressed) {
                this.sendMissingKey(keysym);
            }
        }

        if (source === KeySource.Client && this.userPressedKeys === 0) {
            this.reset();
        }
    }

    // guac_rdp_keyboard_reset: release every key the server still holds (via synthetic releases).
    reset(): void {
        for (const key of this.keysByKeysym.values()) {
            if (key.pressed !== null) {
                this.updateKeysym(key.pressed.keysym, false, KeySource.Synthetic);
            }
        }
    }

    // Full teardown for blur/focus-loss: release every key the server still holds. Unicode-typed
    // characters have no held state, so there is nothing to release for them.
    releaseAll(): void {
        this.reset();
        for (const key of this.keysByKeysym.values()) {
            key.userPressed = false;
        }
        this.userPressedKeys = 0;
    }

    private static lockFlag(keysym: number): number {
        switch (keysym) {
            case KEYSYM_SCROLL_LOCK:
                return LOCK_SCROLL;
            case KEYSYM_KANA_LOCK:
                return LOCK_KANA;
            case KEYSYM_NUM_LOCK:
                return LOCK_NUM;
            case KEYSYM_CAPS_LOCK:
                return LOCK_CAPS;
            default:
                return 0;
        }
    }
}
