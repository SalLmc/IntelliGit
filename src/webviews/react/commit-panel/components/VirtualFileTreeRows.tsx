import React, { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { TreeEntry, TreeFolder } from "../../shared/fileTree";
import {
    FileTreeRows,
    TreeFileRow,
    TreeFolderRow,
    type FileTreeRowsProps,
    type TreeRowFile,
} from "../../shared/components/FileTreeRows";
import { JETBRAINS_UI } from "../../shared/tokens";

const ROW_HEIGHT = JETBRAINS_UI.size.treeRowHeight;
const OVERSCAN = 10;
export const VIRTUAL_THRESHOLD = 200;

interface VisibleRow<F extends TreeRowFile> {
    entry: TreeEntry<F>;
    depth: number;
}

/** Flattens only expanded rows while retaining the existing tree order and indentation. */
export function visibleCommitRows<F extends TreeRowFile>(
    entries: readonly TreeEntry<F>[],
    expanded: (path: string) => boolean,
    depth = 0,
): VisibleRow<F>[] {
    const rows: VisibleRow<F>[] = [];
    const append = (children: readonly TreeEntry<F>[], level: number): void => {
        for (const entry of children) {
            rows.push({ entry, depth: level });
            if (entry.type === "folder" && expanded(entry.path)) append(entry.children, level + 1);
        }
    };
    append(entries, depth);
    return rows;
}

/** Uses the commit area's existing scroller instead of nesting another scrolling surface. */
function scrollParent(element: HTMLElement): HTMLElement {
    let parent = element.parentElement;
    while (parent) {
        if (/auto|scroll/.test(getComputedStyle(parent).overflowY)) return parent;
        parent = parent.parentElement;
    }
    return element.parentElement ?? element;
}

function fileCount<F extends TreeRowFile>(folder: TreeFolder<F>): number {
    const descendants = (folder as TreeFolder<F> & { descendantFiles?: readonly unknown[] })
        .descendantFiles;
    if (descendants) return descendants.length;
    return folder.children.reduce(
        (count, child) => count + (child.type === "file" ? 1 : fileCount(child)),
        0,
    );
}

/**
 * Bounds large commit trees; small trees retain the original DOM and pixel layout unless
 * `virtualize` says the panel around them is large.
 */
export function VirtualFileTreeRows<F extends TreeRowFile>({
    virtualize = false,
    ...props
}: FileTreeRowsProps<F> & { virtualize?: boolean }): React.ReactElement {
    const root = useRef<HTMLDivElement>(null);
    const rows = useMemo(
        () => visibleCommitRows(props.entries, props.isDirectoryExpanded, props.depth),
        [props.depth, props.entries, props.isDirectoryExpanded],
    );
    const [windowRange, setWindowRange] = useState({ start: 0, end: 40 });
    const virtual = virtualize || rows.length > VIRTUAL_THRESHOLD;
    const fileWiringSeen = useRef(props.fileWiring);
    const folderWiringSeen = useRef(props.folderWiring);
    const fileWiringCache = useRef(
        new WeakMap<object, { depth: number; wiring: ReturnType<typeof props.fileWiring> }>(),
    );
    const folderWiringCache = useRef(
        new Map<string, ReturnType<NonNullable<typeof props.folderWiring>>>(),
    );
    if (fileWiringSeen.current !== props.fileWiring) {
        fileWiringSeen.current = props.fileWiring;
        fileWiringCache.current = new WeakMap();
    }
    if (folderWiringSeen.current !== props.folderWiring) {
        folderWiringSeen.current = props.folderWiring;
        folderWiringCache.current = new Map();
    }
    const fileWiringFor = (file: F, depth: number): ReturnType<typeof props.fileWiring> => {
        const cached = fileWiringCache.current.get(file);
        if (cached && cached.depth === depth) return cached.wiring;
        const wiring = props.fileWiring(file, depth);
        fileWiringCache.current.set(file, { depth, wiring });
        return wiring;
    };
    const folderWiringFor = (
        folder: TreeFolder<F>,
    ): ReturnType<NonNullable<typeof props.folderWiring>> | undefined => {
        if (!props.folderWiring) return undefined;
        const cached = folderWiringCache.current.get(folder.path);
        if (cached) return cached;
        const wiring = props.folderWiring(folder);
        folderWiringCache.current.set(folder.path, wiring);
        return wiring;
    };

    useLayoutEffect(() => {
        const element = root.current;
        if (!virtual || !element) return;
        const parent = scrollParent(element);
        let frame = 0;
        const measure = (): void => {
            frame = 0;
            const offset =
                element.getBoundingClientRect().top -
                parent.getBoundingClientRect().top +
                parent.scrollTop;
            const top = parent.scrollTop - offset;
            const bottom = top + (parent.clientHeight || 400);
            const start = Math.min(
                rows.length,
                Math.max(0, Math.floor(top / ROW_HEIGHT) - OVERSCAN),
            );
            const end = Math.min(
                rows.length,
                Math.max(start, Math.ceil(bottom / ROW_HEIGHT) + OVERSCAN),
            );
            setWindowRange((previous) =>
                previous.start === start && previous.end === end ? previous : { start, end },
            );
        };
        const schedule = (): void => {
            if (!frame) frame = requestAnimationFrame(measure);
        };
        measure();
        parent.addEventListener("scroll", schedule, { passive: true });
        const observer =
            typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(schedule);
        observer?.observe(parent);
        observer?.observe(element);
        return () => {
            parent.removeEventListener("scroll", schedule);
            observer?.disconnect();
            if (frame) cancelAnimationFrame(frame);
        };
    }, [rows.length, virtual]);

    if (!virtual) return <FileTreeRows {...props} />;
    const onKeyDown: React.KeyboardEventHandler<HTMLDivElement> = (event) => {
        if (event.target instanceof HTMLInputElement && event.target.type !== "checkbox") return;
        const wrapper = (event.target as Element).closest<HTMLElement>("[data-virtual-row-index]");
        if (!wrapper || !root.current) return;
        const current = Number(wrapper.dataset.virtualRowIndex);
        const entry = rows[current]?.entry;
        if (event.target === wrapper && (event.key === " " || event.key === "Enter")) {
            event.preventDefault();
            if (entry?.type === "folder") props.onToggleDirectory(entry.path);
            else if (entry?.type === "file") {
                const wiring = props.fileWiring(entry.file, rows[current].depth);
                if (event.key === " ") wiring.onToggleCheck?.(entry.file.path);
                else (wiring.onActivate ?? wiring.onSelect)();
            }
            return;
        }
        const parent = scrollParent(root.current);
        const page = Math.max(1, Math.floor((parent.clientHeight || 400) / ROW_HEIGHT));
        const targets: Record<string, number> = {
            ArrowDown: current + 1,
            ArrowUp: current - 1,
            Home: 0,
            End: rows.length - 1,
            PageDown: current + page,
            PageUp: current - page,
        };
        if (!Object.hasOwn(targets, event.key)) return;
        const target = Math.min(rows.length - 1, Math.max(0, targets[event.key]));
        event.preventDefault();
        event.stopPropagation();
        const offset =
            root.current.getBoundingClientRect().top -
            parent.getBoundingClientRect().top +
            parent.scrollTop;
        parent.scrollTop = offset + target * ROW_HEIGHT;
        parent.dispatchEvent(new Event("scroll"));
        const focus = (attempt: number): void => {
            const row = root.current?.querySelector<HTMLElement>(
                `[data-virtual-row-index="${target}"]`,
            );
            if (row)
                (row.querySelector<HTMLElement>('[tabindex="0"], button, input') ?? row).focus();
            else if (attempt < 4) requestAnimationFrame(() => focus(attempt + 1));
        };
        requestAnimationFrame(() => focus(0));
    };
    return (
        <div
            ref={root}
            data-testid="virtual-commit-tree"
            style={{ height: rows.length * ROW_HEIGHT, position: "relative" }}
            onKeyDownCapture={onKeyDown}
        >
            {rows.slice(windowRange.start, windowRange.end).map(({ entry, depth }, offset) => {
                const index = windowRange.start + offset;
                const key =
                    entry.type === "file"
                        ? (props.fileRowKey?.(entry.file) ?? entry.file.path)
                        : entry.path;
                return (
                    <div
                        key={key}
                        data-virtual-row-index={index}
                        tabIndex={index === windowRange.start ? 0 : -1}
                        style={{
                            position: "absolute",
                            top: index * ROW_HEIGHT,
                            height: ROW_HEIGHT,
                            width: "100%",
                        }}
                    >
                        {entry.type === "file" ? (
                            <TreeFileRow
                                file={entry.file}
                                depth={depth}
                                showParentPath={props.showParentPath}
                                ariaLevel={
                                    props.ariaLevel === undefined
                                        ? undefined
                                        : props.ariaLevel + depth
                                }
                                indentMetrics={props.indentMetrics}
                                rowVariant={props.rowVariant}
                                wiring={fileWiringFor(entry.file, depth)}
                            />
                        ) : (
                            <TreeFolderRow
                                folder={entry}
                                depth={depth}
                                isExpanded={props.isDirectoryExpanded(entry.path)}
                                fileCount={fileCount(entry)}
                                folderIcon={props.folderIcon}
                                folderExpandedIcon={props.folderExpandedIcon}
                                folderIconsByName={props.folderIconsByName}
                                ariaLevel={
                                    props.ariaLevel === undefined
                                        ? undefined
                                        : props.ariaLevel + depth
                                }
                                indentMetrics={props.indentMetrics}
                                rowVariant={props.rowVariant}
                                onToggleDirectory={props.onToggleDirectory}
                                wiring={folderWiringFor(entry)}
                            />
                        )}
                    </div>
                );
            })}
        </div>
    );
}
