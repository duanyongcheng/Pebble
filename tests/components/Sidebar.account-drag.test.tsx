import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  accounts: [] as Array<Record<string, unknown>>,
}));

vi.mock("react-i18next", () => ({
  initReactI18next: {
    type: "3rdParty",
    init: vi.fn(),
  },
  useTranslation: () => ({
    t: (key: string, fallback?: string, values?: Record<string, unknown>) => {
      const template = fallback ?? key;
      if (!values) return template;
      return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(values[name] ?? ""));
    },
  }),
}));

vi.mock("../../src/hooks/queries", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/hooks/queries")>();
  return {
    // The real key, so the hook's optimistic write lands on the same cache
    // entry the rest of the app reads.
    accountsQueryKey: actual.accountsQueryKey,
    useAccountsQuery: () => ({ data: mocks.accounts }),
    useFoldersForAccountsQuery: () => ({ data: [], isFetched: true }),
    useAccountUnreadCounts: () => ({}),
    invalidateUnreadViews: vi.fn(),
  };
});

vi.mock("../../src/hooks/queries/useFolderUnreadCounts", () => ({
  useFolderUnreadCountsForAccounts: () => ({ data: {} }),
}));

vi.mock("../../src/hooks/queries/useAccountUnreadCounts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/hooks/queries/useAccountUnreadCounts")>();
  return { ...actual, useAccountUnreadCounts: () => ({}) };
});

vi.mock("../../src/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/api")>();
  return { ...actual, reorderAccounts: vi.fn() };
});

import Sidebar from "../../src/components/Sidebar";
import { reorderAccounts } from "../../src/lib/api";
import { accountsQueryKey } from "../../src/hooks/queries";
import { useMailStore } from "../../src/stores/mail.store";
import { useUIStore } from "../../src/stores/ui.store";

/**
 * jsdom has no `PointerEvent`, and dnd-kit's sensor reads `isPrimary` on the
 * event — a property `MouseEvent` cannot carry. This is the smallest thing that
 * satisfies both: the mouse event a browser would have sent, plus the two
 * pointer fields the sensor looks at.
 */
class TestPointerEvent extends MouseEvent {
  readonly isPrimary = true;
  readonly pointerId = 1;
  readonly pointerType = "mouse";
}

window.PointerEvent = TestPointerEvent as unknown as typeof PointerEvent;

const ROW_IDS = ["work", "personal", "school"];
const ROW_HEIGHT = 40;
const ACTIVATION_DISTANCE = 5;

function account(id: string, label: string) {
  return {
    id,
    email: `${id}@example.com`,
    account_label: label,
    display_name: label,
    color: null,
    provider: "imap",
    created_at: 1,
    updated_at: 1,
  };
}

/**
 * Lay the rows out for the collision detection.
 *
 * dnd-kit measures every candidate through `getBoundingClientRect`, and jsdom
 * answers zero for all of them — which stacks every row on one point and leaves
 * `rectIntersection` with nothing to choose between. The sortable node is the
 * row's wrapper, so the wrapper is what has to report a position.
 */
function mockRowGeometry() {
  const empty = {
    x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0,
    toJSON: () => ({}),
  } as DOMRect;

  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    const row = this.matches('[data-testid^="account-row-"]')
      ? this
      : this.querySelector<HTMLElement>('[data-testid^="account-row-"]');
    const index = ROW_IDS.findIndex(
      (id) => row?.getAttribute("data-testid") === `account-row-${id}`,
    );
    if (index === -1) return empty;

    const top = index * ROW_HEIGHT;
    return {
      x: 0, y: top, top, bottom: top + ROW_HEIGHT, left: 0, right: 200, width: 200,
      height: ROW_HEIGHT, toJSON: () => ({}),
    } as DOMRect;
  });
}

function renderSidebar() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(accountsQueryKey, mocks.accounts);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return render(<Sidebar />, { wrapper });
}

/**
 * The press, the travel and the release a pointer drag is made of.
 *
 * Two moves, not one: dnd-kit spends the move that crosses the activation
 * distance on starting the drag, and only the moves after it carry the row.
 */
async function dragRow(testId: string, deltaY: number) {
  const handle = screen.getByTestId(testId).parentElement as HTMLElement;
  // Well inside the viewport, so a drag upwards still has somewhere to go.
  const startY = 100;
  // A move that crosses the distance in the direction of travel, then the move
  // that carries the row; a drag upwards has to cross upwards too.
  const crossed = Math.abs(deltaY) > ACTIVATION_DISTANCE
    ? startY + Math.sign(deltaY) * (ACTIVATION_DISTANCE + 1)
    : startY + deltaY;

  fireEvent.pointerDown(handle, { clientX: 10, clientY: startY, button: 0 });
  fireEvent.pointerMove(document, { clientX: 10, clientY: crossed });
  if (crossed !== startY + deltaY) {
    fireEvent.pointerMove(document, { clientX: 10, clientY: startY + deltaY });
  }
  fireEvent.pointerUp(document, { clientX: 10, clientY: startY + deltaY });

  // The save settles on a microtask; letting it land here keeps React from
  // being updated outside act() once the test has moved on.
  await act(async () => {});
}

describe("Sidebar account drag", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRowGeometry();
    mocks.accounts = [
      account("work", "Work"),
      account("personal", "Personal"),
      account("school", "School"),
    ];
    useMailStore.setState({ activeAccountId: null });
    useUIStore.setState({ sidebarCollapsed: false, showUnreadCounts: true });
  });

  afterEach(async () => {
    // dnd-kit keeps swallowing clicks for 50ms after a drag, because the click a
    // browser delivers trails the release. Waiting it out keeps one test's drag
    // from eating the next test's click.
    await new Promise((resolve) => setTimeout(resolve, 60));
    vi.restoreAllMocks();
  });

  it("saves the new order when a row is dragged past its neighbour", async () => {
    renderSidebar();

    await dragRow("account-row-work", ROW_HEIGHT + 10);

    expect(reorderAccounts).toHaveBeenCalledWith(["personal", "work", "school"]);
  });

  it("saves the order a row is dragged up into", async () => {
    renderSidebar();

    await dragRow("account-row-school", -(ROW_HEIGHT + 10));

    expect(reorderAccounts).toHaveBeenCalledWith(["work", "school", "personal"]);
  });

  it("does not select the mailbox it just moved", async () => {
    renderSidebar();

    await dragRow("account-row-work", ROW_HEIGHT + 10);
    // The click a browser delivers after the release; dnd-kit swallows that one
    // so that moving a row does not also open it.
    fireEvent.click(screen.getByRole("button", { name: /Work/ }));

    expect(useMailStore.getState().activeAccountId).toBeNull();
  });

  it("still selects a mailbox from a press that barely moves", async () => {
    renderSidebar();

    // Two pixels is under the activation distance, so this is a click that
    // wobbled rather than a drag.
    await dragRow("account-row-work", 2);
    fireEvent.click(screen.getByRole("button", { name: /Work/ }));

    expect(useMailStore.getState().activeAccountId).toBe("work");
    expect(reorderAccounts).not.toHaveBeenCalled();
  });

  it("leaves the combined row out of the order", async () => {
    renderSidebar();

    await dragRow("account-row-all", ROW_HEIGHT + 10);

    expect(reorderAccounts).not.toHaveBeenCalled();
  });
});
