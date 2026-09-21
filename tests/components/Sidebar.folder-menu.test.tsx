import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The sidebar's folder context menu.
 *
 * The menu reaches the backend through three commands, so those are the seams
 * stubbed here: `markFolderAllRead` (the action the menu exists for),
 * `triggerSync`, and `emptyTrash`. Everything else — the right-click wiring, the
 * role-dependent item list, the unread count that decides whether the mark-read
 * row is usable, and the confirmation in front of a permanent delete — is the
 * real code.
 */
const mocks = vi.hoisted(() => ({
  folderCounts: {} as Record<string, number>,
  invalidateUnreadViews: vi.fn(),
  markFolderAllRead: vi.fn(),
  triggerSync: vi.fn(),
  emptyTrash: vi.fn(),
  getFolderUnreadCounts: vi.fn(),
  confirm: vi.fn(),
  addToast: vi.fn(),
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
      return template.replace(/\{\{(\w+)\}\}/g, (_match, name: string) =>
        String(values[name] ?? ""),
      );
    },
  }),
}));

vi.mock("../../src/hooks/queries", () => ({
  useAccountsQuery: () => ({
    data: [
      {
        id: "account-1",
        email: "user@example.com",
        display_name: "User",
        provider: "imap",
        created_at: 1,
        updated_at: 1,
      },
    ],
  }),
  useFoldersForAccountsQuery: () => ({
    data: [
      {
        id: "folder-inbox",
        account_id: "account-1",
        remote_id: "INBOX",
        name: "Inbox",
        folder_type: "folder",
        role: "inbox",
        parent_id: null,
        color: null,
        is_system: true,
        sort_order: 0,
      },
      {
        id: "folder-trash",
        account_id: "account-1",
        remote_id: "Trash",
        name: "Trash",
        folder_type: "folder",
        role: "trash",
        parent_id: null,
        color: null,
        is_system: true,
        sort_order: 4,
      },
      {
        id: "folder-spam",
        account_id: "account-1",
        remote_id: "Spam",
        name: "Spam",
        folder_type: "folder",
        role: "spam",
        parent_id: null,
        color: null,
        is_system: true,
        sort_order: 5,
      },
      {
        id: "folder-nested",
        account_id: "account-1",
        remote_id: "Work/Reports",
        name: "Work/Reports",
        folder_type: "folder",
        role: null,
        parent_id: null,
        color: null,
        is_system: true,
        sort_order: 6,
      },
    ],
    isFetched: true,
  }),
  invalidateUnreadViews: mocks.invalidateUnreadViews,
}));

vi.mock("../../src/hooks/queries/useAccountUnreadCounts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/hooks/queries/useAccountUnreadCounts")>();
  return { ...actual, useAccountUnreadCounts: () => ({}) };
});

vi.mock("../../src/hooks/queries/useFolderUnreadCounts", () => ({
  useFolderUnreadCountsForAccounts: () => ({ data: mocks.folderCounts }),
}));

vi.mock("../../src/lib/api", () => ({
  markFolderAllRead: mocks.markFolderAllRead,
  triggerSync: mocks.triggerSync,
  emptyTrash: mocks.emptyTrash,
  getFolderUnreadCounts: mocks.getFolderUnreadCounts,
}));

vi.mock("../../src/stores/toast.store", () => ({
  useToastStore: (selector: (state: { addToast: typeof mocks.addToast }) => unknown) =>
    selector({ addToast: mocks.addToast }),
}));

import Sidebar from "../../src/components/Sidebar";
import { useComposeStore } from "../../src/stores/compose.store";
import { useConfirmStore } from "../../src/stores/confirm.store";
import { useMailStore } from "../../src/stores/mail.store";
import { useUIStore } from "../../src/stores/ui.store";

function renderSidebar() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return render(<Sidebar />, { wrapper });
}

/** Right-click a folder row and return the menu it opened. */
function openFolderMenu(folderId: string) {
  fireEvent.contextMenu(screen.getByTestId(`folder-row-${folderId}`), {
    clientX: 120,
    clientY: 240,
  });
  return screen.getByTestId("folder-context-menu");
}

describe("Sidebar folder context menu", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.folderCounts = {};
    mocks.confirm.mockResolvedValue(true);
    mocks.markFolderAllRead.mockResolvedValue(0);
    mocks.triggerSync.mockResolvedValue(undefined);
    mocks.emptyTrash.mockResolvedValue(0);
    mocks.getFolderUnreadCounts.mockResolvedValue({});
    useUIStore.setState({
      sidebarCollapsed: false,
      activeView: "inbox",
      previousView: "inbox",
      // On, so the menu's unread count comes from the folder query rather than
      // from the group total.
      showFolderUnreadCount: true,
    });
    useMailStore.setState({
      activeAccountId: "account-1",
      activeFolderId: "folder-inbox",
    });
    useComposeStore.setState({
      composeMode: null,
      composeReplyTo: null,
      composeDirty: false,
      showComposeLeaveConfirm: false,
      pendingView: null,
    });
    useConfirmStore.setState({ confirm: mocks.confirm });
  });

  it("opens on right-click and closes on Escape", async () => {
    renderSidebar();
    expect(screen.queryByTestId("folder-context-menu")).toBeNull();

    openFolderMenu("folder-inbox");
    expect(screen.getByTestId("folder-context-menu")).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => expect(screen.queryByTestId("folder-context-menu")).toBeNull());
  });

  it("closes when the press lands outside it", async () => {
    renderSidebar();
    openFolderMenu("folder-inbox");

    fireEvent.mouseDown(document.body);

    await waitFor(() => expect(screen.queryByTestId("folder-context-menu")).toBeNull());
  });

  it("keeps the native menu out of the way of its own", () => {
    renderSidebar();

    const row = screen.getByTestId("folder-row-folder-inbox");
    // `fireEvent.contextMenu` returns false when the handler called
    // preventDefault, which is how the app suppresses the browser's menu.
    const notPrevented = fireEvent.contextMenu(row, { clientX: 10, clientY: 10 });

    expect(notPrevented).toBe(false);
  });

  it("marks the whole folder read and refreshes the unread views", async () => {
    mocks.folderCounts = { "folder-inbox": 7 };
    mocks.markFolderAllRead.mockResolvedValueOnce(7);
    renderSidebar();

    const menu = openFolderMenu("folder-inbox");
    fireEvent.click(within(menu).getByTestId("folder-context-menu-mark-all-read"));

    await waitFor(() =>
      expect(mocks.markFolderAllRead).toHaveBeenCalledWith("account-1", ["folder-inbox"]),
    );
    expect(mocks.invalidateUnreadViews).toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByTestId("folder-context-menu")).toBeNull());
  });

  it("disables mark-all-read when the folder has no unread mail", () => {
    mocks.folderCounts = { "folder-inbox": 0 };
    renderSidebar();

    const menu = openFolderMenu("folder-inbox");

    expect(
      within(menu).getByTestId("folder-context-menu-mark-all-read").getAttribute("disabled"),
    ).not.toBeNull();
  });

  it("shows the unread count the press will clear", () => {
    mocks.folderCounts = { "folder-inbox": 12 };
    renderSidebar();

    const menu = openFolderMenu("folder-inbox");

    expect(within(menu).getByTestId("folder-context-menu-mark-all-read").textContent).toContain(
      "12",
    );
  });

  it("offers Empty Trash on a trash row and not on the inbox", () => {
    renderSidebar();

    const inboxMenu = openFolderMenu("folder-inbox");
    expect(within(inboxMenu).queryByTestId("folder-context-menu-empty-trash")).toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });

    const trashMenu = openFolderMenu("folder-trash");
    expect(within(trashMenu).getByTestId("folder-context-menu-empty-trash")).toBeTruthy();
    expect(within(trashMenu).queryByTestId("folder-context-menu-empty-spam")).toBeNull();
  });

  it("offers Empty Spam on a spam row", () => {
    renderSidebar();

    const menu = openFolderMenu("folder-spam");

    expect(within(menu).getByTestId("folder-context-menu-empty-spam")).toBeTruthy();
  });

  it("asks before emptying a junk folder and does nothing when refused", async () => {
    mocks.confirm.mockResolvedValueOnce(false);
    renderSidebar();

    const menu = openFolderMenu("folder-trash");
    fireEvent.click(within(menu).getByTestId("folder-context-menu-empty-trash"));

    await waitFor(() => expect(mocks.confirm).toHaveBeenCalled());
    expect(mocks.emptyTrash).not.toHaveBeenCalled();
  });

  it("empties the junk folder once the delete is confirmed", async () => {
    mocks.emptyTrash.mockResolvedValueOnce(3);
    renderSidebar();

    const menu = openFolderMenu("folder-trash");
    fireEvent.click(within(menu).getByTestId("folder-context-menu-empty-trash"));

    await waitFor(() => expect(mocks.emptyTrash).toHaveBeenCalledWith("account-1"));
    expect(mocks.invalidateUnreadViews).toHaveBeenCalled();
  });

  it("syncs the mailbox that owns the folder", async () => {
    renderSidebar();

    const menu = openFolderMenu("folder-inbox");
    fireEvent.click(within(menu).getByTestId("folder-context-menu-sync"));

    await waitFor(() => expect(mocks.triggerSync).toHaveBeenCalledWith("account-1", "manual"));
  });

  it("moves focus into the menu so it can be driven from the keyboard", async () => {
    mocks.folderCounts = { "folder-inbox": 3 };
    renderSidebar();

    openFolderMenu("folder-inbox");

    await waitFor(() =>
      expect(document.activeElement?.getAttribute("data-testid")).toBe(
        "folder-context-menu-mark-all-read",
      ),
    );
  });

  it("focuses the first enabled row when the leading action is disabled", async () => {
    // Nothing unread: the mark-read row is disabled, and focus must land on the
    // next usable row rather than on a dead one.
    mocks.folderCounts = { "folder-inbox": 0 };
    renderSidebar();

    openFolderMenu("folder-inbox");

    await waitFor(() =>
      expect(document.activeElement?.getAttribute("data-testid")).toBe(
        "folder-context-menu-sync",
      ),
    );
  });

  it("reports a failed mark-all-read instead of closing silently", async () => {
    mocks.folderCounts = { "folder-inbox": 2 };
    mocks.markFolderAllRead.mockRejectedValueOnce(new Error("offline"));
    renderSidebar();

    const menu = openFolderMenu("folder-inbox");
    fireEvent.click(within(menu).getByTestId("folder-context-menu-mark-all-read"));

    await waitFor(() =>
      expect(mocks.addToast).toHaveBeenCalledWith(
        expect.objectContaining({ type: "error" }),
      ),
    );
  });

  it("still offers a usable action when the unread badges are switched off", async () => {
    // With the badges off the sidebar never loads per-folder counts, so the menu
    // has to read them itself — otherwise the action would claim zero unread and
    // sit permanently disabled for exactly the people who turned badges off.
    useUIStore.setState({ showFolderUnreadCount: false });
    mocks.getFolderUnreadCounts.mockResolvedValue({ "folder-inbox": 5 });
    renderSidebar();

    const menu = openFolderMenu("folder-inbox");

    await waitFor(() =>
      expect(within(menu).getByTestId("folder-context-menu-mark-all-read").textContent).toContain(
        "5",
      ),
    );
    expect(
      within(menu).getByTestId("folder-context-menu-mark-all-read").getAttribute("disabled"),
    ).toBeNull();
  });

  it("names the folder in its own menu the way the row does", () => {
    renderSidebar();

    // A nested folder is stored as its whole path, but the row and the menu both
    // name the folder itself — a menu that announced "Work/Reports actions"
    // would be naming something the reader never saw on screen.
    const menu = openFolderMenu("folder-nested");

    expect(menu.getAttribute("aria-label")).toBe("Reports actions");
  });

  it("leaves the action enabled when the count cannot be read", async () => {
    // A count that failed to load is not evidence of an empty folder, so the
    // action must stay available and let the backend decide.
    useUIStore.setState({ showFolderUnreadCount: false });
    mocks.getFolderUnreadCounts.mockRejectedValue(new Error("offline"));
    renderSidebar();

    const menu = openFolderMenu("folder-inbox");

    // Wait for the failed read to settle, so the assertion below is about the
    // state after it rather than during it.
    await waitFor(() => expect(mocks.getFolderUnreadCounts).toHaveBeenCalled());
    await waitFor(() =>
      expect(
        within(menu).getByTestId("folder-context-menu-mark-all-read").getAttribute("disabled"),
      ).toBeNull(),
    );
  });
});
