import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  accounts: [] as Array<Record<string, unknown>>,
  counts: {} as Record<string, number>,
  /** An account whose first sync has not finished has no folders at all. */
  withFolders: true,
  /** Folders a test needs beyond the one inbox per account built below. */
  extraFolders: [] as Array<Record<string, unknown>>,
}));

vi.mock("react-i18next", () => ({
  initReactI18next: {
    type: "3rdParty",
    init: vi.fn(),
  },
  useTranslation: () => ({
    // Interpolates, so a test can assert the wording a reader actually gets
    // ("3 unread") rather than the raw placeholder.
    t: (key: string, fallback?: string, options?: Record<string, unknown>) => {
      const text = fallback ?? key;
      if (!options) return text;
      return text.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(options[name] ?? ""));
    },
  }),
}));

vi.mock("../../src/hooks/queries", () => ({
  useAccountsQuery: () => ({ data: mocks.accounts }),
  // One inbox per account, so a test can prove the folder list follows the
  // account that is selected.
  useFoldersForAccountsQuery: (accountIds: string[]) => ({
    data: mocks.withFolders
      ? [
          ...(accountIds ?? []).map((accountId) => ({
            id: `folder-inbox-${accountId}`,
            account_id: accountId,
            remote_id: "INBOX",
            name: "Inbox",
            folder_type: "folder",
            role: "inbox",
            parent_id: null,
            color: null,
            is_system: true,
            sort_order: 0,
          })),
          ...mocks.extraFolders,
        ]
      : [],
    isFetched: true,
  }),
  invalidateUnreadViews: vi.fn(),
}));

// Keep the real `unreadCountForAccount` so the badge wiring is exercised, and
// only stub the data source.
vi.mock("../../src/hooks/queries/useAccountUnreadCounts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/hooks/queries/useAccountUnreadCounts")>();
  return {
    ...actual,
    useAccountUnreadCounts: () => mocks.counts,
  };
});

vi.mock("../../src/hooks/queries/useFolderUnreadCounts", () => ({
  useFolderUnreadCountsForAccounts: () => ({ data: {} }),
}));

vi.mock("../../src/lib/api", () => ({
  markAccountAllRead: vi.fn(),
}));

import Sidebar from "../../src/components/Sidebar";
import { useComposeStore } from "../../src/stores/compose.store";
import { useConfirmStore } from "../../src/stores/confirm.store";
import { useMailStore } from "../../src/stores/mail.store";
import { useUIStore, readShowUnreadCountPreference } from "../../src/stores/ui.store";

const WORK = {
  id: "account-work",
  email: "me@work.example",
  account_label: "Work",
  provider: "imap",
  created_at: 1,
  updated_at: 1,
};

const PERSONAL = {
  id: "account-personal",
  email: "me@icloud.com",
  provider: "imap",
  created_at: 2,
  updated_at: 2,
};

function renderSidebar() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return render(<Sidebar />, { wrapper });
}

/**
 * The button that opens a mailbox. The row also carries a disclosure triangle
 * for folding its folders, so the two are told apart by test id rather than by
 * their position among the row's buttons.
 */
function accountButton(accountId: string): HTMLElement {
  return screen.getByTestId(`account-select-${accountId}`);
}

function allAccountsButton(): HTMLElement {
  return screen.getByTestId("account-select-all");
}

describe("Sidebar account list", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.accounts = [WORK, PERSONAL];
    mocks.counts = {};
    mocks.withFolders = true;
    mocks.extraFolders = [];
    useUIStore.setState({
      sidebarCollapsed: false,
      activeView: "inbox",
      previousView: "inbox",
      showFolderUnreadCount: false,
      collapsedAccountGroups: [],
    });
    useMailStore.setState({
      activeAccountId: "account-work",
      activeFolderId: null,
    });
    useComposeStore.setState({
      composeMode: null,
      composeReplyTo: null,
      composeDirty: false,
      showComposeLeaveConfirm: false,
      pendingView: null,
    });
    useConfirmStore.setState({ confirm: vi.fn().mockResolvedValue(true) });
  });

  it("lists every account at once instead of hiding them behind a picker", () => {
    renderSidebar();

    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByTestId("account-row-account-work")).toBeTruthy();
    expect(screen.getByTestId("account-row-account-personal")).toBeTruthy();
  });

  it("shows a custom label and the address it belongs to", () => {
    renderSidebar();

    const row = screen.getByTestId("account-row-account-work");
    expect(row.textContent).toContain("Work");
    expect(row.textContent).toContain("me@work.example");

    // An account without a label shows the address once, not twice.
    const personal = screen.getByTestId("account-row-account-personal");
    expect(personal.textContent?.match(/me@icloud\.com/g)).toHaveLength(1);
  });

  it("marks the selected account and moves the folders with it", () => {
    renderSidebar();

    expect(accountButton("account-work").getAttribute("aria-current")).toBe("true");
    expect(accountButton("account-personal").getAttribute("aria-current")).toBeNull();
    expect(useMailStore.getState().activeFolderId).toBe("folder-inbox-account-work");

    fireEvent.click(accountButton("account-personal"));

    expect(useMailStore.getState().activeAccountId).toBe("account-personal");
    // The previous account's folder must not survive the switch.
    expect(useMailStore.getState().activeFolderId).toBe("folder-inbox-account-personal");
  });

  it("nests each mailbox's folders under that mailbox", () => {
    renderSidebar();

    // Both groups are open at once, so every mailbox shows what it holds
    // without having to be selected first — which is the point of grouping.
    const work = screen.getByTestId("account-folders-account-work");
    const personal = screen.getByTestId("account-folders-account-personal");

    expect(within(work).getByTestId("folder-row-folder-inbox-account-work")).toBeTruthy();
    expect(within(personal).getByTestId("folder-row-folder-inbox-account-personal")).toBeTruthy();
    // A folder belongs to exactly one group.
    expect(within(work).queryByTestId("folder-row-folder-inbox-account-personal")).toBeNull();

    // Each folder row opens its own account's folder, so the two same-named
    // rows are told apart by the group they live in rather than by their label.
    fireEvent.click(within(personal).getByTestId("folder-row-folder-inbox-account-personal"));

    expect(useMailStore.getState().activeAccountId).toBe("account-personal");
    expect(useMailStore.getState().activeFolderId).toBe("folder-inbox-account-personal");
  });

  it("switches to the combined mailbox from the all-accounts row", () => {
    renderSidebar();

    expect(allAccountsButton().getAttribute("aria-current")).toBeNull();
    fireEvent.click(allAccountsButton());

    expect(useMailStore.getState().activeAccountId).toBeNull();
    expect(allAccountsButton().getAttribute("aria-current")).toBe("true");
  });

  it("omits the combined row when only one mailbox is configured", () => {
    mocks.accounts = [WORK];
    renderSidebar();

    expect(screen.queryByTestId("account-row-all")).toBeNull();
    expect(screen.getByTestId("account-row-account-work")).toBeTruthy();
  });

  it("hides per-account counts unless count badges are enabled", () => {
    mocks.counts = { "account-work": 3, "account-personal": 7 };
    renderSidebar();

    expect(screen.queryByTestId("account-unread-account-work")).toBeNull();
    expect(screen.queryByTestId("account-unread-account-personal")).toBeNull();
    expect(screen.queryByTestId("account-unread-all")).toBeNull();
  });

  it("shows a per-account unread count when count badges are enabled", () => {
    mocks.counts = { "account-work": 3, "account-personal": 7 };
    useUIStore.setState({ showFolderUnreadCount: true });
    renderSidebar();

    expect(screen.getByTestId("account-unread-account-work").textContent).toBe("3");
    expect(screen.getByTestId("account-unread-account-personal").textContent).toBe("7");
  });

  it("shows the counts when the stored preference says nothing", () => {
    mocks.counts = { "account-work": 3 };
    // The `beforeEach` above forces the flag off to keep the other cases
    // readable; this one asks what a fresh install gets, which is the reader's
    // answer for a key that was never written.
    localStorage.removeItem("pebble-show-unread-count");
    useUIStore.setState({ showFolderUnreadCount: readShowUnreadCountPreference() });

    renderSidebar();

    expect(screen.getByTestId("account-unread-account-work").textContent).toBe("3");
  });

  it("totals the unread count on the combined row", () => {
    mocks.counts = { "account-work": 3, "account-personal": 7 };
    useUIStore.setState({ showFolderUnreadCount: true });
    useMailStore.setState({ activeAccountId: null });
    renderSidebar();

    expect(screen.getByTestId("account-unread-all").textContent).toBe("10");
  });

  it("keeps a mailbox selected even when it has no folders yet", () => {
    // Regression: an account whose sync never finished has no folders, and the
    // sidebar used to advance to the next account, making it unselectable.
    mocks.withFolders = false;
    useMailStore.setState({ activeAccountId: null, activeFolderId: null });
    renderSidebar();

    fireEvent.click(accountButton("account-personal"));

    expect(useMailStore.getState().activeAccountId).toBe("account-personal");
    expect(accountButton("account-personal").getAttribute("aria-current")).toBe("true");
  });

  it("leaves Settings for the mail view when a mailbox is picked", () => {
    useUIStore.setState({ activeView: "settings" });
    renderSidebar();

    fireEvent.click(accountButton("account-personal"));

    expect(useMailStore.getState().activeAccountId).toBe("account-personal");
    expect(useUIStore.getState().activeView).toBe("inbox");
  });

  it("stays put in a view that already follows the selected account", () => {
    useUIStore.setState({ activeView: "starred" });
    renderSidebar();

    fireEvent.click(accountButton("account-personal"));

    expect(useMailStore.getState().activeAccountId).toBe("account-personal");
    expect(useUIStore.getState().activeView).toBe("starred");
  });

  it("keeps every account reachable while the sidebar is collapsed", () => {
    useUIStore.setState({ sidebarCollapsed: true });
    renderSidebar();

    // Labels are gone, so each row is identified by its accessible name.
    expect(screen.queryByText("Work")).toBeNull();
    expect(screen.getByLabelText("Work · me@work.example")).toBeTruthy();
    expect(screen.getByLabelText("me@icloud.com")).toBeTruthy();
  });

  it("keeps the unread count in the sidebar's trailing column", () => {
    mocks.counts = { "account-work": 3 };
    useUIStore.setState({ showFolderUnreadCount: true });
    renderSidebar();

    const badge = screen.getByTestId("account-unread-account-work");
    // Laid out in the same slot the folder counts use, so the numbers line up
    // down the sidebar and a count arriving never re-flows the address beside
    // it — the slot is reserved whether or not it holds a number.
    expect(badge.className).toContain("sidebar-count");
    expect(badge.closest(".sidebar-count-slot")).toBeTruthy();
    expect(badge.style.position).not.toBe("absolute");

    const row = screen.getByTestId("account-row-account-work");
    const avatar = row.querySelector("span[aria-hidden='true']") as HTMLElement;
    expect(avatar.style.borderRadius).toBe("50%");

    // Stated once: the avatar no longer repeats the number.
    expect(row.textContent?.match(/3/g)).toHaveLength(1);
    // A mailbox with nothing waiting gets no badge at all.
    expect(screen.queryByTestId("account-unread-account-personal")).toBeNull();
  });

  it("pins the count to the avatar once the rail has no trailing column", () => {
    mocks.counts = { "account-work": 3 };
    useUIStore.setState({ showFolderUnreadCount: true, sidebarCollapsed: true });
    renderSidebar();

    const badge = screen.getByTestId("account-unread-account-work");
    // The collapsed rail is too narrow for a trailing count, so it rides the
    // avatar instead of disappearing.
    expect(badge.style.position).toBe("absolute");
    const avatar = badge.parentElement?.firstElementChild as HTMLElement;
    expect(avatar.style.borderRadius).toBe("50%");
  });

  it("keeps counting while the sidebar is collapsed", () => {
    // Collapsed rows show no label and no folder list, so the badge is the only
    // remaining signal that a mailbox has mail waiting.
    mocks.counts = { "account-personal": 7 };
    useUIStore.setState({ showFolderUnreadCount: true, sidebarCollapsed: true });
    renderSidebar();

    expect(screen.getByTestId("account-unread-account-personal").textContent).toBe("7");
  });

  it("spells the count out in a collapsed row's name", () => {
    mocks.counts = { "account-work": 3 };
    useUIStore.setState({ showFolderUnreadCount: true, sidebarCollapsed: true });
    renderSidebar();

    expect(screen.getByLabelText("Work · me@work.example · 3 unread")).toBeTruthy();
  });

  it("caps a large count so the badge keeps its width", () => {
    mocks.counts = { "account-work": 128, "account-personal": 4 };
    useUIStore.setState({ showFolderUnreadCount: true });
    renderSidebar();

    expect(screen.getByTestId("account-unread-account-work").textContent).toBe("99+");
    // The combined row is capped the same way, even though its total is 132.
    expect(screen.getByTestId("account-unread-all").textContent).toBe("99+");
  });

  it("folds a mailbox's folders away from its own disclosure control", () => {
    renderSidebar();

    const toggle = screen.getByTestId("account-toggle-account-work");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("account-folders-account-work")).toBeTruthy();

    fireEvent.click(toggle);

    expect(screen.queryByTestId("account-folders-account-work")).toBeNull();
    expect(screen.getByTestId("account-toggle-account-work").getAttribute("aria-expanded")).toBe("false");
    // Folding one mailbox leaves the other one open.
    expect(screen.getByTestId("account-folders-account-personal")).toBeTruthy();
    // The mailbox is still selectable while its folders are hidden.
    expect(screen.getByTestId("account-select-account-work")).toBeTruthy();
  });

  it("remembers which mailboxes were folded shut", () => {
    renderSidebar();

    fireEvent.click(screen.getByTestId("account-toggle-account-work"));

    expect(useUIStore.getState().collapsedAccountGroups).toEqual(["account-work"]);
    expect(localStorage.getItem("pebble-collapsed-account-groups")).toBe('["account-work"]');
  });

  it("opens a mailbox that has no folders to fold", () => {
    // An account whose first sync has not finished has nothing to nest, so it
    // offers no triangle rather than one that would do nothing.
    mocks.withFolders = false;
    renderSidebar();

    expect(screen.queryByTestId("account-toggle-account-work")).toBeNull();
    expect(screen.getByTestId("account-select-account-work")).toBeTruthy();
  });

  it("keeps every mailbox's folders visible while the rail is folded away", () => {
    // The rail has no room for children at all, so no group may claim to be
    // open or closed — the triangles are gone with the labels.
    useUIStore.setState({ sidebarCollapsed: true });
    renderSidebar();

    expect(screen.queryByTestId("account-toggle-account-work")).toBeNull();
    expect(screen.queryByTestId("account-folders-account-work")).toBeNull();
  });

  it("keeps the cross-mailbox views reachable while the rail is folded away", () => {
    // Starred and Snoozed belong to no mailbox, so folding the rail must not
    // take them with it: their icons are the only way to reach them from here.
    useUIStore.setState({ sidebarCollapsed: true });
    renderSidebar();

    expect(screen.getByRole("button", { name: "Starred" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Snoozed" })).toBeTruthy();
  });

  it("shows the combined mailbox as a group with the roles every account shares", () => {
    useMailStore.setState({ activeAccountId: null });
    renderSidebar();

    // The combined view is a group like any other, so it says what it holds
    // rather than only naming itself.
    const combined = screen.getByTestId("account-folders-all");
    expect(within(combined).getByTestId("folder-row-all:inbox")).toBeTruthy();

    // One Inbox for the whole column, not one per account.
    expect(screen.getAllByTestId(/^folder-row-all:inbox$/)).toHaveLength(1);
    // And the mailboxes keep their own separate rows.
    expect(screen.getByTestId("folder-row-folder-inbox-account-work")).toBeTruthy();
    expect(screen.getByTestId("folder-row-folder-inbox-account-personal")).toBeTruthy();
  });

  it("opens the combined mailbox from a row under the combined group", () => {
    useMailStore.setState({ activeAccountId: "account-work" });
    renderSidebar();

    fireEvent.click(screen.getByTestId("folder-row-all:inbox"));

    // A shared role belongs to no single account, so the scope widens to all of
    // them rather than staying on whichever mailbox happened to be selected.
    expect(useMailStore.getState().activeAccountId).toBeNull();
    expect(useMailStore.getState().activeFolderId).toBe("all:inbox");
  });

  it("does not repeat a custom folder under the combined group", () => {
    // A custom folder belongs to exactly one mailbox and is already listed under
    // it, so the combined group shows only the roles every account shares.
    mocks.accounts = [WORK, PERSONAL];
    renderSidebar();

    const combined = screen.getByTestId("account-folders-all");
    const combinedRows = within(combined).getAllByRole("button");

    // Two accounts with one inbox each still contribute a single combined Inbox.
    expect(combinedRows).toHaveLength(1);
    expect(combinedRows[0].getAttribute("data-testid")).toBe("folder-row-all:inbox");
  });

  it("names a nested folder by its last segment, not by its path", () => {
    // IMAP hands a nested folder over as one path joined by the server's own
    // delimiter, and a Gmail label keeps whatever slashes its owner typed. The
    // row is one line and answers "which folder is this" — the level above it is
    // the mailbox already named on the group.
    mocks.extraFolders = [
      {
        id: "folder-nested",
        account_id: "account-work",
        remote_id: "Work/Reports",
        name: "Work/Reports",
        folder_type: "folder",
        role: null,
        parent_id: null,
        color: null,
        is_system: true,
        sort_order: 1,
      },
      {
        id: "folder-gmail",
        account_id: "account-work",
        remote_id: "[Gmail]/All Mail",
        name: "[Gmail]/All Mail",
        folder_type: "folder",
        role: null,
        parent_id: null,
        color: null,
        is_system: true,
        sort_order: 2,
      },
    ];
    renderSidebar();

    const nested = screen.getByTestId("folder-row-folder-nested");
    expect(within(nested).getByText("Reports")).toBeTruthy();
    expect(nested.textContent).not.toContain("Work/Reports");

    expect(within(screen.getByTestId("folder-row-folder-gmail")).getByText("All Mail")).toBeTruthy();

    // The path is not thrown away: it is what the row explains itself with.
    expect(nested.getAttribute("title")).toBe("Work/Reports");
    // A folder whose name was never a path has nothing extra to say.
    expect(
      screen.getByTestId("folder-row-folder-inbox-account-work").getAttribute("title"),
    ).toBeNull();
  });
});
