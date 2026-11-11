// Owns the CommitGraphPanel window-message bridge for extension-host events.
// The hook stays separate from render logic so the root component remains small.
// It preserves the existing VS Code webview message contract without changing dispatch behavior.

import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type React from "react";
import type { CommitGraphInbound } from "../../protocol/commitGraphTypes";
import { openChecksTab } from "../commit-info/checks/checksTabState";
import type { CommitGraphPanelAction } from "./types";
import type { VsCodeApi } from "../shared/vscodeApi";

/**
 * What triggered the next full page load, which decides the selected commit.
 *
 * - `refresh`: keeps the selected hash even when the page no longer lists it (#246).
 * - `branchScoped`: selects the tip of the branch the graph is now scoped to.
 * - `allBranches` and `searchResults`: keep the selected hash when the page lists it, so the list
 *   stays on that commit; otherwise select the first row.
 *
 * A branch change clears the host's commit detail, so after `branchScoped` and `allBranches` the
 * selection is posted again even when the hash is unchanged.
 */
type NextLoadTrigger = "refresh" | "branchScoped" | "allBranches" | "searchResults";

function pickSelectedHash(
    trigger: NextLoadTrigger,
    previousSelectedHash: string | null,
    commits: readonly { hash: string }[],
): string | null {
    const firstCommitHash = commits[0]?.hash ?? null;
    if (trigger === "branchScoped") return firstCommitHash;
    if (trigger === "refresh") return previousSelectedHash ?? firstCommitHash;
    const listed = commits.some((commit) => commit.hash === previousSelectedHash);
    return listed ? previousSelectedHash : firstCommitHash;
}

/**
 * Subscribes to extension-host commit graph messages and dispatches panel state updates.
 *
 * `loadingMore` remains caller-owned because the root component also controls pagination requests.
 * Returns `expectSearchResults`, which the caller invokes when it requests new search
 * results, so the selection follows the results instead of a commit they no longer list.
 */
export function useCommitGraphMessages(params: {
    vscode: VsCodeApi;
    dispatch: React.Dispatch<CommitGraphPanelAction>;
    sendReady: boolean;
    loadingMore: React.MutableRefObject<boolean>;
    selectedHash: string | null;
    /** Repository the Checks tab shows; an `openChecksTab` message for another one is dropped. */
    ciRepoKey?: string;
    setViewVisible: (visible: boolean) => void;
    onShowRebaseDialog: (dialog: Extract<CommitGraphInbound, { type: "showRebaseDialog" }>) => void;
    onShowReviewPrompt: (requestId: string) => void;
}): { expectSearchResults: () => void } {
    const {
        vscode,
        dispatch,
        sendReady,
        loadingMore,
        selectedHash,
        ciRepoKey,
        setViewVisible,
        onShowRebaseDialog,
        onShowReviewPrompt,
    } = params;
    const selectedHashRef = useRef<string | null>(selectedHash);
    const ciRepoKeyRef = useRef(ciRepoKey);
    const nextLoadTriggerRef = useRef<NextLoadTrigger>("refresh");
    useLayoutEffect(() => {
        selectedHashRef.current = selectedHash;
        ciRepoKeyRef.current = ciRepoKey;
    }, [selectedHash, ciRepoKey]);
    // Held in a ref for the same reason as `selectedHashRef`: this effect owns the single
    // `ready` post and the window subscription, so its dependency list must stay fixed. Naming
    // the callback as a dependency would re-post `ready` and re-subscribe whenever a host
    // re-created it.
    const onShowRebaseDialogRef = useRef(onShowRebaseDialog);
    const onShowReviewPromptRef = useRef(onShowReviewPrompt);
    useLayoutEffect(() => {
        onShowRebaseDialogRef.current = onShowRebaseDialog;
        onShowReviewPromptRef.current = onShowReviewPrompt;
    }, [onShowRebaseDialog, onShowReviewPrompt]);

    useEffect(() => {
        if (sendReady) {
            vscode.postMessage({ type: "ready" });
        }

        const handler = (event: MessageEvent<CommitGraphInbound>) => {
            const data = event.data;
            if (
                !data ||
                typeof data !== "object" ||
                typeof (data as { type?: unknown }).type !== "string"
            ) {
                return;
            }
            switch (data.type) {
                case "loadCommits": {
                    loadingMore.current = false;
                    const previousSelectedHash = selectedHashRef.current;
                    const trigger = data.append ? null : nextLoadTriggerRef.current;
                    const nextSelectedHash = trigger
                        ? pickSelectedHash(trigger, previousSelectedHash, data.commits)
                        : previousSelectedHash;
                    const branchChanged = trigger === "branchScoped" || trigger === "allBranches";
                    if (!data.append) {
                        nextLoadTriggerRef.current = "refresh";
                    }
                    selectedHashRef.current = nextSelectedHash;
                    dispatch({
                        type: "loadCommits",
                        commits: data.commits,
                        append: Boolean(data.append),
                        hasMore: data.hasMore,
                        selectedHash: nextSelectedHash,
                        unpushedHashes: data.unpushedHashes,
                    });
                    if (
                        !data.append &&
                        nextSelectedHash !== null &&
                        (branchChanged || nextSelectedHash !== previousSelectedHash)
                    ) {
                        vscode.postMessage({
                            type: "selectCommit",
                            hash: nextSelectedHash,
                        });
                    }
                    break;
                }
                case "setBranches":
                    dispatch({
                        type: "setBranches",
                        branches: data.branches,
                        worktrees: data.worktrees,
                        folderIcon: data.folderIcon,
                        folderExpandedIcon: data.folderExpandedIcon,
                        folderIconsByName: data.folderIconsByName,
                        iconFonts: data.iconFonts,
                        commitChecksEnabled: data.commitChecksEnabled,
                    });
                    break;
                case "setSelectedBranch":
                    nextLoadTriggerRef.current = data.branch ? "branchScoped" : "allBranches";
                    dispatch({ type: "setSelectedBranch", branch: data.branch ?? null });
                    break;
                case "setFilterText":
                    dispatch({ type: "setFilterText", text: data.text });
                    break;
                case "setCommitDetail":
                    // Every commit list receives the detail another list selected; ring that row.
                    selectedHashRef.current = data.detail.hash;
                    dispatch({ type: "selectCommit", hash: data.detail.hash });
                    dispatch({
                        type: "setCommitDetail",
                        detail: data.detail,
                        folderIcon: data.folderIcon,
                        folderExpandedIcon: data.folderExpandedIcon,
                        folderIconsByName: data.folderIconsByName,
                        iconFonts: data.iconFonts,
                        ciRepoKey: data.ciRepoKey,
                    });
                    break;
                case "clearCommitDetail":
                    dispatch({ type: "clearCommitDetail", loading: data.loading ?? false });
                    break;
                case "setCommitChecks":
                    dispatch({ type: "setCommitChecks", snapshot: data.snapshot });
                    break;
                case "setViewVisibility":
                    setViewVisible(data.visible);
                    break;
                case "showRebaseDialog":
                    onShowRebaseDialogRef.current(data);
                    break;
                case "showReviewPrompt":
                    onShowReviewPromptRef.current(data.requestId);
                    break;
                case "openChecksTab":
                    if (data.repoKey !== ciRepoKeyRef.current) break;
                    if (data.hash !== selectedHashRef.current) {
                        selectedHashRef.current = data.hash;
                        dispatch({ type: "selectCommit", hash: data.hash });
                        vscode.postMessage({ type: "selectCommit", hash: data.hash });
                    }
                    openChecksTab();
                    break;
                case "loadError":
                    nextLoadTriggerRef.current = "refresh";
                    dispatch({ type: "loadError", clearCommits: !loadingMore.current });
                    loadingMore.current = false;
                    console.error("[IntelliGit] Load error:", data.message);
                    break;
                case "error":
                    console.error("[IntelliGit] Extension error:", data);
                    break;
            }
        };

        window.addEventListener("message", handler);
        return () => window.removeEventListener("message", handler);
        // Keep the original root effect subscription lifetime; dispatch and loadingMore are stable.
        // react-doctor-disable-next-line react-doctor/exhaustive-deps
    }, [sendReady, vscode]); // eslint-disable-line react-hooks/exhaustive-deps

    const expectSearchResults = useCallback(() => {
        nextLoadTriggerRef.current = "searchResults";
    }, []);
    return { expectSearchResults };
}
