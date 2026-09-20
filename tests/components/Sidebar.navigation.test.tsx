import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Sidebar from "../../src/components/Sidebar";
import { useComposeStore } from "../../src/stores/compose.store";
import { useConfirmStore } from "../../src/stores/confirm.store";
import { useMailStore } from "../../src/stores/mail.store";
import { useUIStore } from "../../src/stores/ui.store";

/**
 * Dragging an account row saves through react-query, so the sidebar needs a
 * client even in a test that stubs the queries themselves.
 */
function renderSidebar() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return render(<Sidebar />, { wrapper });
}

vi.mock("react-i18next", () => ({
  initReactI18next: {
    type: "3rdParty",
    init: vi.fn(),
  },
  useTranslation: () => ({
    t: (key: string, fallback?: string) => {
      const labels: Record<string, string> = {
        "search.title": "Search",
        "sidebar.navigation": "Sidebar",
        "sidebar.search": "Search",
        "sidebar.mail": "Mail",
        "sidebar.mailFolders": "Mail folders",
        "sidebar.tools": "Tools",
        "sidebar.inbox": "Inbox",
        "sidebar.sent": "Sent",
        "sidebar.drafts": "Drafts",
        "sidebar.trash": "Trash",
        "sidebar.archive": "Archive",
        "sidebar.spam": "Spam",
        "sidebar.starred": "Starred",
        "sidebar.contacts": "Contacts",
        "sidebar.snoozed": "Snoozed",
        "sidebar.kanban": "Kanban",
        "sidebar.settings": "Settings",
      };
      return labels[key] ?? fallback ?? key;
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
    ],
    isFetched: true,
  }),
}));

// Sidebar reads account unread counts through this module directly (not the
// `hooks/queries` barrel), so it needs its own mock.
vi.mock("../../src/hooks/queries/useAccountUnreadCounts", () => ({
  useAccountUnreadCounts: () => ({}),
  unreadCountForAccount: () => 0,
}));

vi.mock("../../src/hooks/queries/useFolderUnreadCounts", () => ({
  useFolderUnreadCountsForAccounts: () => ({ data: {} }),
}));

// This suite covers sidebar navigation only; the mark-all-read button and its
// data dependencies are covered by Sidebar.markAllRead.test.tsx.
vi.mock("../../src/components/MarkAllReadButton", () => ({
  default: () => null,
}));

describe("Sidebar navigation", () => {
  beforeEach(() => {
    useUIStore.setState({
      sidebarCollapsed: false,
      activeView: "compose",
      previousView: "inbox",
      showFolderUnreadCount: false,
    });
    useMailStore.setState({
      activeAccountId: "account-1",
      activeFolderId: "folder-inbox",
    });
    useComposeStore.setState({
      composeMode: "new",
      composeReplyTo: null,
      composeDirty: true,
      showComposeLeaveConfirm: false,
      pendingView: null,
    });
    useConfirmStore.setState({
      confirm: vi.fn().mockResolvedValue(true),
    });
  });

  it.each([
    ["Contacts", "contacts"],
    ["Snoozed", "snoozed"],
    ["Kanban", "kanban"],
    ["Settings", "settings"],
  ] as const)("switches to the %s view from the bottom navigation", async (label, view) => {
    useUIStore.setState({ activeView: "inbox" });
    useComposeStore.setState({ composeDirty: false, composeMode: null });

    renderSidebar();

    fireEvent.click(screen.getByRole("button", { name: label }));

    await waitFor(() => {
      expect(useUIStore.getState().activeView).toBe(view);
    });
  });

  it("keeps the sidebar from shrinking under wide message content", () => {
    renderSidebar();

    const sidebar = screen.getByLabelText("Sidebar");

    expect(sidebar.style.flexShrink).toBe("0");
  });

  it("folds and unfolds the sidebar from the row that names the state", () => {
    useUIStore.setState({ sidebarCollapsed: false });
    const { unmount } = renderSidebar();

    // The label states what the press will do, so the control is findable by
    // name in both states — the rail keeps no room for a tooltip-only icon.
    fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    expect(useUIStore.getState().sidebarCollapsed).toBe(true);

    unmount();
    renderSidebar();
    fireEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));
    expect(useUIStore.getState().sidebarCollapsed).toBe(false);
  });

  it("uses non-submit buttons for bottom navigation actions", () => {
    renderSidebar();

    expect(screen.getByRole("button", { name: "Snoozed" }).getAttribute("type")).toBe("button");
    expect(screen.getByRole("button", { name: "Contacts" }).getAttribute("type")).toBe("button");
    expect(screen.getByRole("button", { name: "Kanban" }).getAttribute("type")).toBe("button");
    expect(screen.getByRole("button", { name: "Settings" }).getAttribute("type")).toBe("button");
  });

  it("leaves a dirty compose draft after confirming sidebar navigation", async () => {
    renderSidebar();

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));

    await waitFor(() => {
      expect(useUIStore.getState().activeView).toBe("settings");
    });
    expect(useComposeStore.getState().composeDirty).toBe(false);
    expect(useComposeStore.getState().showComposeLeaveConfirm).toBe(false);
    expect(useComposeStore.getState().pendingView).toBe(null);
  });
});
