import { render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Sidebar from "../../src/components/Sidebar";
import { useComposeStore } from "../../src/stores/compose.store";
import { useMailStore } from "../../src/stores/mail.store";
import { useUIStore } from "../../src/stores/ui.store";
import type { Folder } from "../../src/lib/api";

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

const mocks = vi.hoisted(() => ({
  accounts: [{
    id: "account-1",
    email: "user@example.com",
    display_name: "User",
    provider: "imap",
    color: null,
    created_at: 1,
    updated_at: 1,
  }],
  folders: [] as Folder[],
}));

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
    data: mocks.accounts,
  }),
  useFoldersForAccountsQuery: () => ({
    data: mocks.folders,
    isFetched: true,
  }),
}));

// Sidebar reads account unread counts through this module directly (not the
// `hooks/queries` barrel), so it needs its own mock.
vi.mock("../../src/hooks/queries/useAccountUnreadCounts", () => ({
  useAccountUnreadCounts: () => ({}),
  unreadCountForAccount: () => 0,
}));

// Folder ordering does not depend on the mark-all-read button, which has its own
// suite (Sidebar.markAllRead.test.tsx).
vi.mock("../../src/components/MarkAllReadButton", () => ({
  default: () => null,
}));

vi.mock("../../src/hooks/queries/useFolderUnreadCounts", () => ({
  useFolderUnreadCountsForAccounts: () => ({ data: {} }),
}));

function folder(id: string, role: Folder["role"], sortOrder: number): Folder {
  return {
    id,
    account_id: "account-1",
    remote_id: id,
    name: id,
    folder_type: "folder",
    role,
    parent_id: null,
    color: null,
    is_system: true,
    sort_order: sortOrder,
  };
}

describe("Sidebar folder order", () => {
  beforeEach(() => {
    useUIStore.setState({
      sidebarCollapsed: false,
      activeView: "inbox",
      previousView: "inbox",
      showFolderUnreadCount: false,
      backgroundImage: null,
    });
    useMailStore.setState({
      activeAccountId: "account-1",
      activeFolderId: "inbox",
    });
    useComposeStore.setState({
      composeMode: null,
      composeReplyTo: null,
      composeDirty: false,
      showComposeLeaveConfirm: false,
      pendingView: null,
    });
    mocks.folders = [
      folder("drafts", "drafts", 1),
      folder("spam", "spam", 2),
      folder("inbox", "inbox", 3),
      folder("trash", "trash", 4),
      folder("archive", "archive", 5),
      folder("sent", "sent", 6),
    ];
    mocks.accounts = [{
      id: "account-1",
      email: "user@example.com",
      display_name: "User",
      provider: "imap",
      color: null,
      created_at: 1,
      updated_at: 1,
    }];
  });

  it("keeps the system folders in one order inside a mailbox", () => {
    renderSidebar();

    // The system folders are ordered the same way whether the sidebar shows one
    // mailbox or several, so the row a reader reaches for stays in the same
    // place as accounts are added. Starred and Snoozed are cross-mailbox views
    // and now sit above the groups rather than between Drafts and Trash.
    const group = screen.getByTestId("account-folders-account-1");
    const labels = within(group).getAllByRole("button").map((button) => button.textContent);

    expect(labels).toEqual([
      "Inbox",
      "Sent",
      "Archive",
      "Drafts",
      "Trash",
      "Spam",
    ]);
  });

  it("keeps the account list translucent when an app background is active", () => {
    mocks.accounts = [
      {
        id: "account-1",
        email: "user@example.com",
        display_name: "User",
        provider: "imap",
        color: null,
        created_at: 1,
        updated_at: 1,
      },
      {
        id: "account-2",
        email: "second@example.com",
        display_name: "Second",
        provider: "imap",
        color: null,
        created_at: 2,
        updated_at: 2,
      },
    ];
    useMailStore.setState({ activeAccountId: null });
    useUIStore.setState({
      backgroundImage: {
        path: "/tmp/backgrounds/background.png",
        filename: "background.png",
        fit: "cover",
        opacity: 1,
        updatedAt: 1,
      },
    });

    renderSidebar();

    // Nothing here may paint an opaque panel over the wallpaper: the list keeps
    // its own background off and every row takes its surface from
    // `.sidebar-account-row`, which is transparent unless selected and themed
    // via `--color-sidebar-active` — a token `.app-shell--with-background`
    // already makes translucent for the sidebar as a whole.
    const list = screen.getByTestId("account-list");
    expect(list.getAttribute("style") ?? "").not.toContain("--color-bg");

    const row = screen.getByTestId("account-row-account-1");
    const rowStyle = row.getAttribute("style") ?? "";
    expect(row.className).toContain("sidebar-account-row");
    expect(rowStyle).not.toContain("background");
    expect(rowStyle).not.toContain("--color-bg");

    // The avatar is the account's own colour mixed with transparent, so the
    // wallpaper still reads through it.
    const avatar = row.querySelector("span[aria-hidden='true']");
    const avatarStyle = avatar?.getAttribute("style") ?? "";
    expect(avatarStyle).toContain("color-mix");
    expect(avatarStyle).toContain("14%, transparent");
    expect(avatarStyle).not.toContain("--color-bg");
  });
});
