// US-QWERTY character map: the printable character the user MEANT (KeyboardEvent.key, already
// resolved by the OS through the client's own layout) -> the physical key position (KeyboardEvent.code
// name, fed to scanCode()) plus whether Shift is required to produce it on a US-QWERTY guest.
//
// This is the client half of Guacamole's model (guac_rdp keyboard.c + the en_us_qwerty keymap): the
// RDP session is pinned to en-US (keyboard_layout 0x409 in the connector), so producing a character
// means sending the US scancode that yields it, pressing/releasing Shift as the US layout requires and
// clearing any interfering client-side modifiers (AltGr). Because it keys on the RESULTING character,
// it is correct for every client layout (US, AZERTY, BEPO, QWERTZ, ...): what the user sees typed is
// what the guest receives, terminals included (a real scancode, never a Unicode-keysym injection that
// terminals re-shift). Non-ASCII characters (accents, currency) are absent here and fall back to the
// Unicode path in remote-desktop.service.ts.

export interface UsKey {
    code: string;
    shift: boolean;
}

const UNSHIFTED: Record<string, string> = {
    '`': 'Backquote',
    '1': 'Digit1',
    '2': 'Digit2',
    '3': 'Digit3',
    '4': 'Digit4',
    '5': 'Digit5',
    '6': 'Digit6',
    '7': 'Digit7',
    '8': 'Digit8',
    '9': 'Digit9',
    '0': 'Digit0',
    '-': 'Minus',
    '=': 'Equal',
    q: 'KeyQ',
    w: 'KeyW',
    e: 'KeyE',
    r: 'KeyR',
    t: 'KeyT',
    y: 'KeyY',
    u: 'KeyU',
    i: 'KeyI',
    o: 'KeyO',
    p: 'KeyP',
    '[': 'BracketLeft',
    ']': 'BracketRight',
    '\\': 'Backslash',
    a: 'KeyA',
    s: 'KeyS',
    d: 'KeyD',
    f: 'KeyF',
    g: 'KeyG',
    h: 'KeyH',
    j: 'KeyJ',
    k: 'KeyK',
    l: 'KeyL',
    ';': 'Semicolon',
    "'": 'Quote',
    z: 'KeyZ',
    x: 'KeyX',
    c: 'KeyC',
    v: 'KeyV',
    b: 'KeyB',
    n: 'KeyN',
    m: 'KeyM',
    ',': 'Comma',
    '.': 'Period',
    '/': 'Slash',
    ' ': 'Space',
};

const SHIFTED: Record<string, string> = {
    '~': 'Backquote',
    '!': 'Digit1',
    '@': 'Digit2',
    '#': 'Digit3',
    $: 'Digit4',
    '%': 'Digit5',
    '^': 'Digit6',
    '&': 'Digit7',
    '*': 'Digit8',
    '(': 'Digit9',
    ')': 'Digit0',
    _: 'Minus',
    '+': 'Equal',
    Q: 'KeyQ',
    W: 'KeyW',
    E: 'KeyE',
    R: 'KeyR',
    T: 'KeyT',
    Y: 'KeyY',
    U: 'KeyU',
    I: 'KeyI',
    O: 'KeyO',
    P: 'KeyP',
    '{': 'BracketLeft',
    '}': 'BracketRight',
    '|': 'Backslash',
    A: 'KeyA',
    S: 'KeyS',
    D: 'KeyD',
    F: 'KeyF',
    G: 'KeyG',
    H: 'KeyH',
    J: 'KeyJ',
    K: 'KeyK',
    L: 'KeyL',
    ':': 'Semicolon',
    '"': 'Quote',
    Z: 'KeyZ',
    X: 'KeyX',
    C: 'KeyC',
    V: 'KeyV',
    B: 'KeyB',
    N: 'KeyN',
    M: 'KeyM',
    '<': 'Comma',
    '>': 'Period',
    '?': 'Slash',
};

const US_KEYMAP: Record<string, UsKey> = {};
for (const [ch, code] of Object.entries(UNSHIFTED)) {
    US_KEYMAP[ch] = { code, shift: false };
}
for (const [ch, code] of Object.entries(SHIFTED)) {
    US_KEYMAP[ch] = { code, shift: true };
}

/// The US-QWERTY position + Shift requirement that produces `character`, or undefined when the
/// character is not on the US layout (non-ASCII: accents/currency -> Unicode fallback).
export function usKey(character: string): UsKey | undefined {
    return US_KEYMAP[character];
}
