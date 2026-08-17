const ANSI_CONTROL = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const SGR_CONTROL = /^\u001b\[([0-9;]*)m$/;
const UNSAFE_TEXT_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

const foregroundClasses = new Map([
    [30, 'ansi-fg-black'],
    [31, 'ansi-fg-red'],
    [32, 'ansi-fg-green'],
    [33, 'ansi-fg-yellow'],
    [34, 'ansi-fg-blue'],
    [35, 'ansi-fg-magenta'],
    [36, 'ansi-fg-cyan'],
    [37, 'ansi-fg-white'],
    [90, 'ansi-fg-black-bright'],
    [91, 'ansi-fg-red-bright'],
    [92, 'ansi-fg-green-bright'],
    [93, 'ansi-fg-yellow-bright'],
    [94, 'ansi-fg-blue-bright'],
    [95, 'ansi-fg-magenta-bright'],
    [96, 'ansi-fg-cyan-bright'],
    [97, 'ansi-fg-white-bright']
]);

const backgroundClasses = new Map([
    [40, 'ansi-bg-black'],
    [41, 'ansi-bg-red'],
    [42, 'ansi-bg-green'],
    [43, 'ansi-bg-yellow'],
    [44, 'ansi-bg-blue'],
    [45, 'ansi-bg-magenta'],
    [46, 'ansi-bg-cyan'],
    [47, 'ansi-bg-white'],
    [100, 'ansi-bg-black-bright'],
    [101, 'ansi-bg-red-bright'],
    [102, 'ansi-bg-green-bright'],
    [103, 'ansi-bg-yellow-bright'],
    [104, 'ansi-bg-blue-bright'],
    [105, 'ansi-bg-magenta-bright'],
    [106, 'ansi-bg-cyan-bright'],
    [107, 'ansi-bg-white-bright']
]);

function initialState() {
    return {
        foreground: null,
        background: null,
        bold: false,
        dim: false,
        italic: false,
        underline: false,
        inverse: false,
        hidden: false,
        strikethrough: false
    };
}

function resetState(state) {
    Object.assign(state, initialState());
}

function applyCode(state, code) {
    if (code === 0) resetState(state);
    else if (code === 1) state.bold = true;
    else if (code === 2) state.dim = true;
    else if (code === 3) state.italic = true;
    else if (code === 4) state.underline = true;
    else if (code === 7) state.inverse = true;
    else if (code === 8) state.hidden = true;
    else if (code === 9) state.strikethrough = true;
    else if (code === 22) {
        state.bold = false;
        state.dim = false;
    } else if (code === 23) state.italic = false;
    else if (code === 24) state.underline = false;
    else if (code === 27) state.inverse = false;
    else if (code === 28) state.hidden = false;
    else if (code === 29) state.strikethrough = false;
    else if (code === 39) state.foreground = null;
    else if (code === 49) state.background = null;
    else if (foregroundClasses.has(code)) state.foreground = foregroundClasses.get(code);
    else if (backgroundClasses.has(code)) state.background = backgroundClasses.get(code);
}

function stateClasses(state) {
    return [
        state.foreground,
        state.background,
        state.bold && 'ansi-mod-bold',
        state.dim && 'ansi-mod-dim',
        state.italic && 'ansi-mod-italic',
        state.underline && 'ansi-mod-underline',
        state.inverse && 'ansi-mod-inverse',
        state.hidden && 'ansi-mod-hidden',
        state.strikethrough && 'ansi-mod-strikethrough'
    ].filter(Boolean);
}

function appendSegment(segments, state, value) {
    const text = value.replace(UNSAFE_TEXT_CONTROL, '');
    if (!text) return;
    const classes = stateClasses(state);
    const previous = segments.at(-1);

    if (previous && previous.classes.join(' ') === classes.join(' ')) {
        previous.text += text;
        return;
    }

    segments.push({ text, classes });
}

export function parseAnsi(value) {
    const source = String(value);
    const state = initialState();
    const segments = [];
    let cursor = 0;

    for (const match of source.matchAll(ANSI_CONTROL)) {
        appendSegment(segments, state, source.slice(cursor, match.index));
        const sgr = match[0].match(SGR_CONTROL);
        if (sgr) {
            const codes = sgr[1] === '' ? [0] : sgr[1].split(';').map(Number);
            for (const code of codes) applyCode(state, code);
        }
        cursor = match.index + match[0].length;
    }

    appendSegment(segments, state, source.slice(cursor));
    return segments;
}

export function appendAnsiText(container, value) {
    const document = container.ownerDocument;
    const fragment = document.createDocumentFragment();

    for (const segment of parseAnsi(value)) {
        if (segment.classes.length === 0) {
            fragment.append(document.createTextNode(segment.text));
            continue;
        }

        const span = document.createElement('span');
        span.classList.add(...segment.classes);
        span.textContent = segment.text;
        fragment.append(span);
    }

    container.append(fragment);
}
