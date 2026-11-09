import { GRAPH_LANE_COLORS, JETBRAINS_UI } from "./shared/tokens";

/** Horizontal spacing between adjacent commit-graph lanes. */
export const LANE_WIDTH = JETBRAINS_UI.graph.laneWidth;

/** Radius used by canvas renderers for each commit dot. */
export const DOT_RADIUS = JETBRAINS_UI.graph.dotRadius;

/** Shared vertical row height that keeps commit rows and graph lanes aligned. */
export const ROW_HEIGHT = JETBRAINS_UI.size.rowHeight;

/**
 * Layout instructions for one visible commit row, including active lanes and
 * parent connections that the canvas renderer turns into graph strokes.
 */
export interface GraphRow {
    column: number;
    color: string;
    numColumns: number;
    passThroughLanes: Array<{ column: number; color: string }>;
    connectionsDown: Array<{ fromCol: number; toCol: number; color: string }>;
}

/** Commit fields consumed by {@link computeGraph} to assign lanes and parent connections. */
export interface GraphCommitInput {
    hash: string;
    parentHashes: string[];
    refs?: string[];
}

function isHeadRef(ref: string): boolean {
    const trimmed = ref.trim();
    return trimmed === "HEAD" || trimmed.startsWith("HEAD -> ");
}

function matchesHash(a: string, b: string): boolean {
    if (a === b) return true;
    const minLen = Math.min(a.length, b.length);
    return minLen >= 7 && (a.startsWith(b) || b.startsWith(a));
}

function normalizeBranchRef(raw: string): string | null {
    const ref = raw.trim();
    if (!ref || ref === "HEAD" || ref.startsWith("tag:") || ref.endsWith("/HEAD")) return null;
    const withoutHead = ref.startsWith("HEAD -> ") ? ref.slice("HEAD -> ".length).trim() : ref;
    if (withoutHead.startsWith("origin/")) return withoutHead.slice("origin/".length);
    if (withoutHead.startsWith("upstream/")) return withoutHead.slice("upstream/".length);
    return withoutHead || null;
}

function extractBaseBranches(refs?: string[]): Set<string> {
    const result = new Set<string>();
    if (!refs) return result;
    for (const raw of refs) {
        const normalized = normalizeBranchRef(raw);
        if (normalized) result.add(normalized);
    }
    return result;
}

function hasDisjointBranchRefs(
    laneBranchSet: Set<string> | null | undefined,
    parentBranchSet: Set<string>,
): boolean {
    if (!laneBranchSet || laneBranchSet.size === 0 || parentBranchSet.size === 0) return false;
    for (const branch of parentBranchSet) {
        if (laneBranchSet.has(branch)) return false;
    }
    return true;
}

function collectHeadTrunk(
    commits: GraphCommitInput[],
    indexByHash: Map<string, number>,
    currentBranchHeadHash?: string | null,
): Set<string> {
    const headCommit =
        commits.find((c) => c.refs?.some(isHeadRef)) ??
        (currentBranchHeadHash
            ? commits.find((c) => matchesHash(c.hash, currentBranchHeadHash))
            : undefined);
    const headTrunk = new Set<string>();
    let curr = headCommit?.hash;
    while (curr && !headTrunk.has(curr)) {
        const idx = indexByHash.get(curr);
        if (idx === undefined) break;
        headTrunk.add(curr);
        const next = commits[idx].parentHashes[0];
        const nextIdx = next ? indexByHash.get(next) : undefined;
        if (nextIdx === undefined || nextIdx <= idx) break;
        curr = next;
    }
    return headTrunk;
}

interface LaneState {
    lanes: (string | null)[];
    laneBranches: (Set<string> | null)[];
    reserveCol0: boolean;
    colors: string[];
    commits: GraphCommitInput[];
    indexByHash: Map<string, number>;
    headTrunk: Set<string>;
}

function findFreeLane(state: LaneState): number {
    const start = state.reserveCol0 ? 1 : 0;
    while (state.lanes.length < start) {
        state.lanes.push(null);
        state.laneBranches.push(null);
    }
    for (let i = start; i < state.lanes.length; i++) {
        if (state.lanes[i] === null) return i;
    }
    state.lanes.push(null);
    state.laneBranches.push(null);
    return state.lanes.length - 1;
}

function findExistingLane(state: LaneState, hash: string): number {
    const start = state.reserveCol0 ? 1 : 0;
    for (let i = start; i < state.lanes.length; i++) {
        if (state.lanes[i] === hash) return i;
    }
    return -1;
}

function resolveCommitColumn(state: LaneState, commit: GraphCommitInput, isTrunk: boolean): number {
    if (isTrunk) {
        if (state.lanes.length === 0) {
            state.lanes.push(null);
            state.laneBranches.push(null);
        }
        return 0;
    }
    const existing = findExistingLane(state, commit.hash);
    return existing >= 0 ? existing : findFreeLane(state);
}

function connectSingleParent(
    state: LaneState,
    rowIndex: number,
    col: number,
    isTrunk: boolean,
    activeLaneBranches: Set<string> | null,
    p: number,
    ph: string,
    connectionsDown: Array<{ fromCol: number; toCol: number; color: string }>,
): void {
    const { colors } = state;
    const parentIsTrunk = state.headTrunk.has(ph);
    if (isTrunk && p === 0) {
        state.lanes[0] = ph;
        state.laneBranches[0] = activeLaneBranches;
        connectionsDown.push({ fromCol: 0, toCol: 0, color: colors[0] });
        return;
    }
    if (parentIsTrunk && state.lanes[0] === ph) {
        const colorIdx = (p === 0 ? col : 0) % colors.length;
        connectionsDown.push({ fromCol: col, toCol: 0, color: colors[colorIdx] });
        return;
    }
    const pCol = findExistingLane(state, ph);
    if (pCol >= 0 && !(parentIsTrunk && state.commits[rowIndex + 1]?.hash === ph)) {
        const colorIdx = (p === 0 ? col : pCol) % colors.length;
        connectionsDown.push({ fromCol: col, toCol: pCol, color: colors[colorIdx] });
        return;
    }
    const parentIdx = state.indexByHash.get(ph);
    const parentBranches =
        parentIdx !== undefined
            ? extractBaseBranches(state.commits[parentIdx].refs)
            : new Set<string>();
    if (p === 0 && !parentIsTrunk && hasDisjointBranchRefs(activeLaneBranches, parentBranches)) {
        state.lanes[col] = "__occupied__";
        const nc = findFreeLane(state);
        state.lanes[col] = null;
        state.lanes[nc] = ph;
        state.laneBranches[nc] = parentBranches;
        connectionsDown.push({ fromCol: col, toCol: nc, color: colors[col % colors.length] });
        return;
    }
    if (p === 0) {
        state.lanes[col] = ph;
        state.laneBranches[col] = parentBranches.size > 0 ? parentBranches : activeLaneBranches;
        connectionsDown.push({ fromCol: col, toCol: col, color: colors[col % colors.length] });
        return;
    }
    const nc = findFreeLane(state);
    state.lanes[nc] = ph;
    state.laneBranches[nc] = parentBranches.size > 0 ? parentBranches : null;
    connectionsDown.push({ fromCol: col, toCol: nc, color: colors[nc % colors.length] });
}

function coalesceNextTrunkCommit(
    state: LaneState,
    nextHash: string | undefined,
    passThroughLanes: Array<{ column: number; color: string }>,
    connectionsDown: Array<{ fromCol: number; toCol: number; color: string }>,
): void {
    if (!nextHash || !state.headTrunk.has(nextHash)) return;
    for (let c = 1; c < state.lanes.length; c++) {
        if (state.lanes[c] !== nextHash) continue;
        state.lanes[c] = null;
        state.laneBranches[c] = null;
        state.lanes[0] = nextHash;
        const connFromRow = connectionsDown.find((conn) => conn.toCol === c);
        if (connFromRow) {
            connFromRow.toCol = 0;
        } else {
            const ptIdx = passThroughLanes.findIndex((l) => l.column === c);
            if (ptIdx >= 0) passThroughLanes.splice(ptIdx, 1);
            connectionsDown.push({
                fromCol: c,
                toCol: 0,
                color: state.colors[c % state.colors.length],
            });
        }
    }
}

/**
 * Computes lane assignments for commits in display order, reusing parent lanes
 * where possible and allocating side lanes for merge parents.
 *
 * When a HEAD commit is present (via `refs` or `currentBranchHeadHash`), Column 0
 * is reserved for HEAD's first-parent trunk so branches ahead of HEAD render on
 * side lanes and fork into HEAD rather than sharing Column 0's straight line.
 *
 * `palette` is supplied by the caller so lane colors can follow the active theme;
 * it defaults to the dark palette for callers that render on a known dark surface.
 */
export function computeGraph(
    commits: GraphCommitInput[],
    palette: string[] = GRAPH_LANE_COLORS,
    currentBranchHeadHash?: string | null,
): GraphRow[] {
    const colors = palette.length > 0 ? palette : GRAPH_LANE_COLORS;
    const indexByHash = new Map<string, number>();
    for (let i = 0; i < commits.length; i++) {
        indexByHash.set(commits[i].hash, i);
    }
    const headTrunk = collectHeadTrunk(commits, indexByHash, currentBranchHeadHash);
    const state: LaneState = {
        lanes: [],
        laneBranches: [],
        reserveCol0: headTrunk.size > 0,
        colors,
        commits,
        indexByHash,
        headTrunk,
    };
    const rows: GraphRow[] = [];

    for (let rowIndex = 0; rowIndex < commits.length; rowIndex++) {
        const commit = commits[rowIndex];
        const isTrunk = headTrunk.has(commit.hash);
        const col = resolveCommitColumn(state, commit, isTrunk);

        const commitBranches = extractBaseBranches(commit.refs);
        const activeLaneBranches =
            commitBranches.size > 0 ? commitBranches : (state.laneBranches[col] ?? null);

        const passThroughLanes: Array<{ column: number; color: string }> = [];
        for (let i = 0; i < state.lanes.length; i++) {
            if (i !== col && state.lanes[i] !== null) {
                passThroughLanes.push({ column: i, color: colors[i % colors.length] });
            }
        }

        state.lanes[col] = null;
        state.laneBranches[col] = null;

        const connectionsDown: Array<{ fromCol: number; toCol: number; color: string }> = [];
        for (let p = 0; p < commit.parentHashes.length; p++) {
            connectSingleParent(
                state,
                rowIndex,
                col,
                isTrunk,
                activeLaneBranches,
                p,
                commit.parentHashes[p],
                connectionsDown,
            );
        }

        coalesceNextTrunkCommit(
            state,
            commits[rowIndex + 1]?.hash,
            passThroughLanes,
            connectionsDown,
        );

        while (state.lanes.length > 0 && state.lanes[state.lanes.length - 1] === null) {
            state.lanes.pop();
            state.laneBranches.pop();
        }

        rows.push({
            column: col,
            color: colors[col % colors.length],
            numColumns: Math.max(state.lanes.length, col + 1),
            passThroughLanes,
            connectionsDown,
        });
    }

    return rows;
}
