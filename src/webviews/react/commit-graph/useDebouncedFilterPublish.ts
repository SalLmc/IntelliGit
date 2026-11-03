import { useCallback, useEffect, useRef } from "react";

const FILTER_PUBLISH_DELAY_MS = 200;

/**
 * Publishes commit-search text after typing pauses.
 *
 * The input itself updates immediately. One or two characters never reach Git.
 * Clearing the field publishes at once so the unfiltered graph returns without waiting.
 */
export function useDebouncedFilterPublish(publish: (text: string) => void): (text: string) => void {
    const publishRef = useRef(publish);
    publishRef.current = publish;
    const timerRef = useRef<number | null>(null);

    useEffect(
        () => () => {
            if (timerRef.current !== null) window.clearTimeout(timerRef.current);
        },
        [],
    );

    return useCallback((text: string) => {
        if (timerRef.current !== null) {
            window.clearTimeout(timerRef.current);
            timerRef.current = null;
        }
        if (text.length !== 0 && text.length < 3) return;
        if (text.length === 0) {
            publishRef.current(text);
            return;
        }
        timerRef.current = window.setTimeout(() => {
            timerRef.current = null;
            publishRef.current(text);
        }, FILTER_PUBLISH_DELAY_MS);
    }, []);
}
