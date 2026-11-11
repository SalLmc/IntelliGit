// @vitest-environment jsdom

import React, { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CommitList } from "../../../src/webviews/react/CommitList";
import { initReactDomTestEnvironment, mount, unmount } from "../../helpers/reactDomTestUtils";
import { installWebviewI18n } from "../../helpers/webviewI18nTestUtils";

vi.mock("../../../src/webviews/react/shared/vscodeApi", () => ({
    getVsCodeApi: () => ({ postMessage: vi.fn(), getState: () => undefined, setState: vi.fn() }),
}));

initReactDomTestEnvironment();

function renderList(selectedBranch: string | null, onShowAllBranches = vi.fn()) {
    return mount(
        <CommitList
            commits={[]}
            selectedHash={null}
            filterText=""
            hasMore={false}
            unpushedHashes={new Set()}
            selectedBranch={selectedBranch}
            onSelectCommit={vi.fn()}
            onFilterText={vi.fn()}
            onShowAllBranches={onShowAllBranches}
            onLoadMore={vi.fn()}
            onCommitAction={vi.fn()}
        />,
    );
}

const clearButton = (container: HTMLElement) =>
    container.querySelector<HTMLButtonElement>('[data-testid="commit-branch-scope-clear"]');

beforeEach(() => {
    installWebviewI18n();
});

describe("commit list branch scope", () => {
    it("clears a branch scope back to all branches", () => {
        const onShowAllBranches = vi.fn();
        const { root, container } = renderList("main", onShowAllBranches);

        const button = clearButton(container);
        expect(button?.getAttribute("aria-label")).toBe("All branches");
        act(() => {
            button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        });
        expect(onShowAllBranches).toHaveBeenCalledTimes(1);

        unmount(root, container);
    });

    it("hides the clear control while already showing all branches", () => {
        const { root, container } = renderList(null);

        expect(clearButton(container)).toBeNull();

        unmount(root, container);
    });
});
