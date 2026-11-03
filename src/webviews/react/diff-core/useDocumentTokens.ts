import { useEffect, useMemo, useState } from "react";
import { highlightDocument, type ShikiDocumentTokens } from "./shikiHighlighter";
import type { SyntaxHighlightState } from "./syntaxHighlightContext";

/** Files at or under this size keep synchronous highlighting. Larger ones paint first. */
const SYNC_LINE_LIMIT = 400;

/**
 * Highlights one pane without blocking the first paint of a large document.
 *
 * Small documents stay synchronous, so opening a normal diff does not flash uncolored text.
 * A larger document renders with the regex tokenizer until one background pass finishes, then
 * swaps in tokens for that exact line list. Tokens from the previous list are not reused:
 * shifted rows would otherwise retokenize one by one.
 */
export function useDocumentTokens(
    lines: readonly string[],
    state: SyntaxHighlightState,
    eol: string,
): SyntaxHighlightState {
    const sync = lines.length <= SYNC_LINE_LIMIT;
    const syncTokens = useMemo(() => {
        if (!sync || !state.ready || !state.lang) return null;
        return highlightDocument(lines, state.lang, state.theme, eol);
    }, [eol, lines, state.lang, state.ready, state.theme, sync]);

    const [asyncTokens, setAsyncTokens] = useState<{
        lines: readonly string[];
        tokens: ShikiDocumentTokens;
    } | null>(null);

    useEffect(() => {
        if (sync || !state.ready || !state.lang) return;
        let cancelled = false;
        const lang = state.lang;
        const theme = state.theme;
        const timer = window.setTimeout(() => {
            const tokens = highlightDocument(lines, lang, theme, eol);
            if (!cancelled && tokens) setAsyncTokens({ lines, tokens });
        }, 0);
        return () => {
            cancelled = true;
            window.clearTimeout(timer);
        };
    }, [eol, lines, state.lang, state.ready, state.theme, sync]);

    if (!state.ready || !state.lang) return state;
    if (sync) return { ...state, documentTokens: syncTokens };
    if (!asyncTokens || asyncTokens.lines !== lines) return { ...state, ready: false };
    return { ...state, documentTokens: asyncTokens.tokens };
}
