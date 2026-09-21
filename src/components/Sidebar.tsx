import { useEffect, useMemo, useState } from "react";
import {
  FileEdit,
  Trash2,
  Archive,
  AlertTriangle,
  LayoutGrid,
  Settings,
  Search,
  Clock,
  Star,
  ContactRound,
  PanelLeftClose,
  PanelLeftOpen,
  Inbox,
  Send,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { useUIStore } from "../stores/ui.store";
import type { ActiveView } from "../stores/ui.store";
import { isComposeDirty, useComposeStore } from "../stores/compose.store";
import { useConfirmStore } from "../stores/confirm.store";
import { useMailStore } from "../stores/mail.store";
import { useShortcutStore } from "../stores/shortcut.store";
import { useToastStore } from "../stores/toast.store";
import { useAccountsQuery, useFoldersForAccountsQuery, invalidateUnreadViews } from "../hooks/queries";
import { useFolderUnreadCountsForAccounts } from "../hooks/queries/useFolderUnreadCounts";
import { useAccountUnreadCounts } from "../hooks/queries/useAccountUnreadCounts";
import SidebarAccountList, { type MailboxGroup } from "./SidebarAccountList";
import { folderLabel } from "./folderIcon";
import FolderContextMenu, {
  FOLDER_MENU_ICONS,
  type FolderMenuItem,
} from "./FolderContextMenu";
import { accountLabel, accountOptionLabel } from "../lib/accountIdentity";
import { assignAccountColors } from "../lib/accountColors";
import {
  ALL_ACCOUNTS_ID,
  buildAllAccountsFolders,
  folderIdsForSelection,
  sortFoldersForSidebar,
} from "../lib/folderAggregation";
import { emptyTrash, getFolderUnreadCounts, markFolderAllRead, triggerSync } from "../lib/api";
import { extractErrorMessage } from "../lib/extractErrorMessage";
import type { Account, Folder as FolderType } from "../lib/api";

const EMPTY_ACCOUNTS: Account[] = [];
const EMPTY_FOLDERS: FolderType[] = [];

const EXPANDED_WIDTH = 216;
const COLLAPSED_WIDTH = 60;

/** The rail has no labels, so its icons carry a little more of the row. */
const ICON_SIZE = 16;
const COLLAPSED_ICON_SIZE = 18;

// Default folders shown when no account is configured. They are placeholders
// rather than destinations: with no mailbox there is nothing to open, so they
// only keep the column from reading as an empty panel behind the welcome state.
const DEFAULT_FOLDERS: { role: string; labelKey: string; icon: React.ReactNode }[] = [
  { role: "inbox", labelKey: "sidebar.inbox", icon: <Inbox size={15} /> },
  { role: "sent", labelKey: "sidebar.sent", icon: <Send size={15} /> },
  { role: "archive", labelKey: "sidebar.archive", icon: <Archive size={15} /> },
  { role: "drafts", labelKey: "sidebar.drafts", icon: <FileEdit size={15} /> },
  { role: "trash", labelKey: "sidebar.trash", icon: <Trash2 size={15} /> },
  { role: "spam", labelKey: "sidebar.spam", icon: <AlertTriangle size={15} /> },
];

/**
 * Views that show nothing about a particular mailbox. Selecting an account while
 * one of these is open has to move back to the mail view, otherwise the click
 * appears to do nothing.
 */
const MAILBOX_AGNOSTIC_VIEWS: ActiveView[] = ["settings", "contacts"];

/**
 * A folder row's context menu, held as the row it belongs to plus where the
 * press landed.
 *
 * The folder and its group are kept rather than pre-computed actions, because
 * what the menu can offer depends on state that moves — the unread count is
 * read when the menu opens, not when the row was drawn.
 */
interface FolderMenuTarget {
  folder: FolderType;
  group: MailboxGroup;
  position: { x: number; y: number };
}

export default function Sidebar() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const addToast = useToastStore((s) => s.addToast);
  const activeView = useUIStore((s) => s.activeView);
  const setActiveView = useUIStore((s) => s.setActiveView);
  const sidebarCollapsed = useUIStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const collapsedAccountGroups = useUIStore((s) => s.collapsedAccountGroups);
  const toggleAccountGroup = useUIStore((s) => s.toggleAccountGroup);
  const searchShortcut = useShortcutStore((s) => s.bindings["focus-search"]);
  const activeFolderId = useMailStore((s) => s.activeFolderId);
  const activeAccountId = useMailStore((s) => s.activeAccountId);
  const setActiveAccountId = useMailStore((s) => s.setActiveAccountId);
  const setActiveFolderId = useMailStore((s) => s.setActiveFolderId);

  const showUnread = useUIStore((s) => s.showFolderUnreadCount);
  const { data: accounts = EMPTY_ACCOUNTS } = useAccountsQuery();

  // Every mailbox's folders are read at once, because every mailbox is drawn at
  // once: a group that only filled in once its account was selected could not
  // show what it holds, which is the reason to group in the first place.
  const folderAccountIds = useMemo(() => accounts.map((account) => account.id), [accounts]);
  const { data: folders = EMPTY_FOLDERS } = useFoldersForAccountsQuery(folderAccountIds);
  const { data: unreadCounts = {} } = useFolderUnreadCountsForAccounts(folderAccountIds);
  const accountUnreadCounts = useAccountUnreadCounts();
  const [folderMenu, setFolderMenu] = useState<FolderMenuTarget | null>(null);
  const [folderMenuBusy, setFolderMenuBusy] = useState(false);
  /**
   * Per-folder unread counts fetched for the open menu, used only while the
   * sidebar's own counts are switched off and therefore never loaded.
   *
   * `null` means "not read yet", which is a different thing from "nothing
   * unread" — the menu keeps the action enabled until the number is actually
   * known, so a slow or failed read can never leave a working action disabled.
   */
  const [menuCounts, setMenuCounts] = useState<Record<string, number> | null>(null);

  const allAccountsMode = accounts.length > 1 && !activeAccountId;

  /**
   * Each mailbox's folders, in the order the sidebar shows them.
   *
   * Built here rather than in the list component because the auto-selection
   * below needs the same mapping, and the two have to agree about which mailbox
   * a folder belongs to.
   */
  const foldersByAccountId = useMemo(() => {
    const byAccount = new Map<string, FolderType[]>();
    for (const account of accounts) {
      byAccount.set(account.id, []);
    }
    for (const folder of folders) {
      byAccount.get(folder.account_id)?.push(folder);
    }
    for (const [accountId, list] of byAccount) {
      byAccount.set(accountId, sortFoldersForSidebar(list));
    }
    return byAccount;
  }, [accounts, folders]);

  /**
   * The column's groups: the combined mailbox first when there is more than one
   * account, then every mailbox with its own folders.
   *
   * The combined group is built from the role folders the accounts contribute,
   * so it shows Inbox, Sent, Archive and the rest as one entry each — the same
   * expansion the message list performs when one of those rows is opened.
   */
  const groups = useMemo((): MailboxGroup[] => {
    const colors = assignAccountColors(accounts);
    const built: MailboxGroup[] = [];

    if (accounts.length > 1) {
      // Only the roles every mailbox contributes. A custom folder belongs to one
      // account and is already listed under it, so repeating it here would draw
      // the same destination twice — and opening it from this group would have
      // to guess which mailbox it meant.
      const combined = buildAllAccountsFolders(folders).filter((folder) => folder.role);
      const totalUnread = accounts.reduce(
        (sum, account) => sum + (accountUnreadCounts[account.id] ?? 0),
        0,
      );
      built.push({
        id: ALL_ACCOUNTS_ID,
        account: null,
        label: t("sidebar.allAccounts", "All accounts"),
        secondary: null,
        full: t("sidebar.allAccounts", "All accounts"),
        unread: totalUnread,
        folders: combined,
        color: null,
        selected: allAccountsMode,
        sortable: false,
        canMarkAllRead: false,
        childrenAreCombined: true,
      });
    }

    for (const account of accounts) {
      built.push({
        id: account.id,
        account,
        label: accountLabel(account),
        // Only repeat the address on a second line when it differs from the label.
        secondary: account.account_label?.trim() ? account.email : null,
        full: accountOptionLabel(account),
        unread: accountUnreadCounts[account.id] ?? 0,
        folders: foldersByAccountId.get(account.id) ?? [],
        color: colors.get(account.id) ?? null,
        selected: !allAccountsMode && account.id === activeAccountId,
        sortable: true,
        canMarkAllRead: true,
        childrenAreCombined: false,
      });
    }

    return built;
  }, [
    accounts,
    folders,
    foldersByAccountId,
    accountUnreadCounts,
    allAccountsMode,
    activeAccountId,
    t,
  ]);

  // Auto-select the only account. With multiple accounts, null means the
  // combined "all accounts" mailbox.
  useEffect(() => {
    if (accounts.length === 1 && !activeAccountId) {
      setActiveAccountId(accounts[0].id);
    }
  }, [accounts, activeAccountId, setActiveAccountId]);

  // Auto-select a folder when folders load.
  //
  // The pool comes from whichever group is selected, because a group's rows are
  // the destinations it actually offers: under the combined mailbox that is the
  // shared `all:*` roles, and under a mailbox it is that account's own folders.
  // Picking from the wrong pool would mark a row in a group that is not the one
  // selected, and open a folder the combined view does not list.
  //
  // A mailbox with no folders is left selected on purpose. The previous version
  // advanced to the next account, which made any account whose first sync had not
  // finished impossible to select at all: clicking it bounced the selection away.
  // InboxView shows a sync prompt for that case instead.
  useEffect(() => {
    if (activeFolderId) return;
    const pool = groups.find((group) => group.selected)?.folders ?? [];
    if (pool.length === 0) return;
    const inbox = pool.find((folder) => folder.role === "inbox");
    setActiveFolderId((inbox ?? pool[0]).id);
  }, [groups, activeFolderId, setActiveFolderId]);

  async function confirmDiscardDraft() {
    if (isComposeDirty()) {
      const confirmed = await useConfirmStore.getState().confirm({
        title: t("compose.discardDraft", "Discard draft"),
        message: t("compose.discardDraftConfirm", "You have an unsaved draft. Discard and leave?"),
        destructive: true,
      });
      return confirmed;
    }
    return true;
  }

  async function safeSetActiveView(view: Parameters<typeof setActiveView>[0]) {
    if (isComposeDirty()) {
      const confirmed = await confirmDiscardDraft();
      if (!confirmed) return;
      useComposeStore.getState().discardComposeAndSetActiveView(view);
      return;
    }
    setActiveView(view);
  }

  /**
   * Open a folder, and with it the mailbox that owns it.
   *
   * A folder row lives inside its group, so pressing one is also a statement
   * about which mailbox to read. The account is moved first — selecting an
   * account clears the open folder — and the folder is restored after it.
   */
  async function handleFolderClick(folderId: string, groupId: string) {
    // A row under the combined group stands for every account's copy of its
    // role, so opening it means opening the combined mailbox, not one account.
    const ownerAccountId = groupId === ALL_ACCOUNTS_ID ? null : groupId;

    if (isComposeDirty()) {
      const confirmed = await confirmDiscardDraft();
      if (!confirmed) return;
      useComposeStore.getState().discardComposeAndSetActiveView("inbox");
      setActiveAccountId(ownerAccountId);
      setActiveFolderId(folderId);
      return;
    }
    setActiveView("inbox");
    setActiveAccountId(ownerAccountId);
    setActiveFolderId(folderId);
  }

  async function handleGroupSelect(groupId: string) {
    const accountId = groupId === ALL_ACCOUNTS_ID ? null : groupId;

    if (isComposeDirty()) {
      const confirmed = await confirmDiscardDraft();
      if (!confirmed) return;
      useComposeStore.getState().discardComposeAndSetActiveView("inbox");
      setActiveAccountId(accountId);
      return;
    }
    // Settings and Contacts are not tied to a mailbox, so staying on them after
    // picking a different account looks like the click did nothing. The mail
    // views (inbox, starred, search, snoozed, kanban) already follow the
    // selected account, so those are left alone.
    if (MAILBOX_AGNOSTIC_VIEWS.includes(activeView)) {
      setActiveView("inbox");
    }
    setActiveAccountId(accountId);
  }

  /**
   * The mailboxes a folder row acts on, with the folder ids to reach it in each.
   *
   * A row under the combined group is a *role*, not a folder: `all:inbox` is
   * every mailbox's inbox at once, which is what the message list already shows
   * when that row is open. The menu therefore expands the same way the list
   * does, through `folderIdsForSelection` — so "mark all as read" on the
   * combined Inbox clears every inbox, and the count it shows is the same sum
   * the row displays.
   */
  function folderScopeOf(target: FolderMenuTarget): { accountId: string; folderIds: string[] }[] {
    if (target.group.id === ALL_ACCOUNTS_ID) {
      return accounts
        .map((account) => ({
          accountId: account.id,
          folderIds: folderIdsForSelection(target.folder.id, folders).filter((folderId) =>
            folders.some((folder) => folder.id === folderId && folder.account_id === account.id),
          ),
        }))
        .filter((scope) => scope.folderIds.length > 0);
    }

    const accountId = target.group.account?.id;
    if (!accountId) return [];
    // A real folder belongs to exactly one mailbox, so there is nothing to
    // expand — and going through the same resolver keeps a role row under an
    // account consistent with the combined one above it.
    return [{ accountId, folderIds: [target.folder.id] }];
  }

  /**
   * How much unread mail the menu's "mark all as read" would clear, or `null`
   * while that is not known yet.
   *
   * `menuCounts` is the live per-folder map when the unread badges are on. When
   * they are off the app never fetches that map, so the menu loads it on open
   * instead — the alternative is an action that always claims zero and is
   * therefore always disabled, which is how a feature becomes invisible to
   * exactly the people who turned the badges off.
   */
  function unreadForScope(
    target: FolderMenuTarget,
    counts: Record<string, number> | null,
  ): number | null {
    if (!counts) return null;
    return target.group.childrenAreCombined
      ? folderScopeOf(target).reduce(
          (sum, scope) =>
            sum + scope.folderIds.reduce((inner, id) => inner + (counts[id] ?? 0), 0),
          0,
        )
      : counts[target.folder.id] ?? 0;
  }

  /** The per-folder counts the open menu should read from. */
  function menuFolderCounts(): Record<string, number> | null {
    return showUnread ? unreadCounts : menuCounts;
  }

  /**
   * Load the per-folder counts for a menu that was opened with the sidebar's
   * badges switched off.
   *
   * Keyed on the target so opening a second folder re-reads rather than reusing
   * the previous folder's numbers, and guarded so a failure leaves the menu
   * usable — an unread count that could not be read must not disable an action
   * the backend would happily perform.
   */
  useEffect(() => {
    if (!folderMenu || showUnread) return;
    const accountIds = [...new Set(folderScopeOf(folderMenu).map((scope) => scope.accountId))];
    if (accountIds.length === 0) return;
    let cancelled = false;
    void (async () => {
      try {
        const perAccount = await Promise.all(
          accountIds.map((accountId) => getFolderUnreadCounts(accountId)),
        );
        if (!cancelled) setMenuCounts(Object.assign({}, ...perAccount));
      } catch {
        // Leave the counts unknown rather than empty. An empty map reads as
        // "nothing unread", which would disable the very action this menu
        // exists for on the strength of a failed read.
        if (!cancelled) setMenuCounts(null);
      }
    })();
    return () => {
      cancelled = true;
    };
    // `folderScopeOf` reads `accounts` and `folders`, both of which change far
    // less often than the menu opens; re-running on them is harmless.
  }, [folderMenu, showUnread, accounts, folders]);

  /**
   * Close the menu and forget the counts it fetched.
   *
   * Clearing `menuCounts` matters because the next open must not decide whether
   * its action is usable from the previous folder's numbers.
   */
  function closeFolderMenu() {
    setFolderMenu(null);
    setMenuCounts(null);
  }

  /** Run a menu action, closing the menu and reporting the outcome. */
  async function runFolderMenuAction(action: () => Promise<void>) {
    setFolderMenuBusy(true);
    try {
      await action();
    } finally {
      setFolderMenuBusy(false);
      closeFolderMenu();
    }
  }

  function handleFolderMenuMarkAllRead(target: FolderMenuTarget) {
    void runFolderMenuAction(async () => {
      const scopes = folderScopeOf(target);
      try {
        const cleared = (
          await Promise.all(
            scopes.map((scope) => markFolderAllRead(scope.accountId, scope.folderIds)),
          )
        ).reduce((sum, count) => sum + count, 0);
        invalidateUnreadViews(queryClient);
        addToast({
          message: t("folderMenu.markAllReadSuccess", "Marked {{count}} messages as read in {{folder}}", {
            count: cleared,
            folder: folderMenuLabel(target),
          }),
          type: "success",
        });
      } catch (error) {
        addToast({
          message: t("folderMenu.markAllReadFailed", "Failed to mark messages as read: {{error}}", {
            error: extractErrorMessage(error),
          }),
          type: "error",
        });
      }
    });
  }

  function handleFolderMenuSync(target: FolderMenuTarget) {
    void runFolderMenuAction(async () => {
      const accountIds = folderScopeOf(target).map((scope) => scope.accountId);
      try {
        for (const accountId of accountIds) {
          await triggerSync(accountId, "manual");
        }
        addToast({
          message: t("folderMenu.syncStarted", "Syncing {{folder}}...", {
            folder: folderMenuLabel(target),
          }),
          type: "info",
        });
      } catch (error) {
        addToast({
          message: t("folderMenu.syncFailed", "Sync failed: {{error}}", {
            error: extractErrorMessage(error),
          }),
          type: "error",
        });
      }
    });
  }

  /**
   * Permanently empty a junk folder, after asking.
   *
   * The confirmation is not ceremony: unlike marking read, this cannot be undone
   * and it reaches the provider. The dialog names the folder, because the row
   * that opened it is behind the menu by the time it appears.
   */
  function handleFolderMenuEmpty(target: FolderMenuTarget, isSpam: boolean) {
    void runFolderMenuAction(async () => {
      const scopes = folderScopeOf(target);
      const confirmed = await useConfirmStore.getState().confirm({
        title: isSpam
          ? t("folderMenu.emptySpam", "Empty Spam")
          : t("folderMenu.emptyTrash", "Empty Trash"),
        message: isSpam
          ? t("folderMenu.emptySpamConfirm", "Permanently delete all messages in Spam?")
          : t("folderMenu.emptyTrashConfirm", "Permanently delete all messages in Trash?"),
        destructive: true,
      });
      if (!confirmed) return;

      try {
        const deleted = (
          await Promise.all(scopes.map((scope) => emptyTrash(scope.accountId)))
        ).reduce((sum, count) => sum + count, 0);
        invalidateUnreadViews(queryClient);
        addToast({
          message: t("folderMenu.emptySuccess", "Deleted {{count}} messages", { count: deleted }),
          type: "success",
        });
      } catch (error) {
        addToast({
          message: t("folderMenu.emptyFailed", "Failed to empty folder: {{error}}", {
            error: extractErrorMessage(error),
          }),
          type: "error",
        });
      }
    });
  }

  /** The folder's own name, translated for a system folder. */
  function folderMenuLabel(target: FolderMenuTarget): string {
    const roleLabels: Record<string, string> = {
      inbox: t("sidebar.inbox"),
      sent: t("sidebar.sent"),
      drafts: t("sidebar.drafts"),
      trash: t("sidebar.trash"),
      archive: t("sidebar.archive"),
      spam: t("sidebar.spam"),
    };
    // The same rule the row's own label follows, so the menu names the folder
    // the reader right-clicked rather than a path the row never showed.
    return folderLabel(target.folder, roleLabels);
  }

  /**
   * What the menu offers for one folder.
   *
   * The list is deliberately short and role-aware. "Mark all as read" is the
   * action this menu exists for; "Sync now" is the answer to a folder that looks
   * stale; and the two empty actions appear only where the provider actually
   * supports a permanent delete, which is the trash and spam roles. Renaming and
   * deleting a folder are absent because no layer below offers them.
   *
   * The unread count is computed here, at open time, and only the mark-read row
   * carries it — a count beside "Sync now" would read as work to be done.
   */
  function folderMenuItems(target: FolderMenuTarget): FolderMenuItem[] {
    const unread = unreadForScope(target, menuFolderCounts());
    const role = target.folder.role;
    const items: FolderMenuItem[] = [
      {
        id: "mark-all-read",
        label: t("folderMenu.markAllRead", "Mark all as read"),
        icon: FOLDER_MENU_ICONS.markAllRead,
        badge: unread ?? undefined,
        // Only a *known* zero disables the row; a count still in flight leaves
        // the action usable, because the backend is what decides.
        disabled: unread === 0,
        onSelect: () => handleFolderMenuMarkAllRead(target),
      },
      {
        id: "sync",
        label: t("folderMenu.syncFolder", "Sync this folder"),
        icon: FOLDER_MENU_ICONS.sync,
        onSelect: () => handleFolderMenuSync(target),
      },
    ];

    if (role === "trash") {
      items.push({
        id: "empty-trash",
        label: t("folderMenu.emptyTrash", "Empty Trash"),
        icon: FOLDER_MENU_ICONS.emptyTrash,
        destructive: true,
        onSelect: () => handleFolderMenuEmpty(target, false),
      });
    }
    if (role === "spam") {
      items.push({
        id: "empty-spam",
        label: t("folderMenu.emptySpam", "Empty Spam"),
        icon: FOLDER_MENU_ICONS.emptySpam,
        destructive: true,
        onSelect: () => handleFolderMenuEmpty(target, true),
      });
    }

    return items;
  }

  const iconSize = sidebarCollapsed ? COLLAPSED_ICON_SIZE : ICON_SIZE;

  const collapseLabel = sidebarCollapsed
    ? t("sidebar.expand", "Expand sidebar")
    : t("sidebar.collapse", "Collapse sidebar");

  /**
   * Destinations that belong to no single mailbox, so they cannot live inside a
   * group. macOS Mail calls this area Favorites; here it is simply the rows that
   * span every account.
   */
  const pinnedMailRows = (
    <>
      <SidebarButton
        icon={<Star size={iconSize} />}
        label={t("sidebar.starred", "Starred")}
        isActive={activeView === "starred"}
        collapsed={sidebarCollapsed}
        onClick={() => safeSetActiveView("starred")}
      />
      <SidebarButton
        icon={<Clock size={iconSize} />}
        label={t("sidebar.snoozed", "Snoozed")}
        isActive={activeView === "snoozed"}
        collapsed={sidebarCollapsed}
        onClick={() => safeSetActiveView("snoozed")}
      />
    </>
  );

  return (
    <aside
      aria-label={t("sidebar.navigation", "Sidebar")}
      className={`sidebar${sidebarCollapsed ? " sidebar--collapsed" : ""}`}
      style={{
        width: sidebarCollapsed ? `${COLLAPSED_WIDTH}px` : `${EXPANDED_WIDTH}px`,
        flexShrink: 0,
        backgroundColor: "var(--color-sidebar-bg)",
        borderRight: "1px solid var(--color-border)",
        transition: "width 150ms ease",
        display: "flex",
        flexDirection: "column",
        height: "100%",
        overflow: "hidden",
      }}
    >
      {/* Search. It reads as a field because it opens a view rather than
          filtering the list in place, and it names the key that gets there. */}
      <nav className="sidebar-nav sidebar-nav--top" aria-label={t("sidebar.search", "Search")}>
        <SidebarButton
          icon={<Search size={iconSize} />}
          label={t("search.title", "Search")}
          isActive={activeView === "search"}
          collapsed={sidebarCollapsed}
          className="sidebar-search"
          trailing={!sidebarCollapsed && searchShortcut ? (
            <kbd className="sidebar-kbd">{searchShortcut}</kbd>
          ) : null}
          onClick={() => safeSetActiveView("search")}
        />
      </nav>

      {/* The mailboxes, each with its folders nested underneath. This is the
          only part of the rail that scrolls, so it owns the leftover height. */}
      <nav
        className="scroll-region sidebar-mail-scroll"
        aria-label={t("sidebar.mailFolders", "Mail folders")}
      >
        {accounts.length > 0 ? (
          <SidebarAccountList
            groups={groups}
            collapsed={sidebarCollapsed}
            showUnread={showUnread}
            folderUnreadCounts={unreadCounts}
            allFolders={folders}
            activeFolderId={activeFolderId}
            mailViewActive={activeView === "inbox"}
            onSelectGroup={handleGroupSelect}
            onFolderSelect={handleFolderClick}
            onFolderContextMenu={(folder, group, position) =>
              setFolderMenu({ folder, group, position })
            }
            collapsedGroupIds={collapsedAccountGroups}
            onToggleGroup={toggleAccountGroup}
            pinnedRows={pinnedMailRows}
          />
        ) : (
          // No mailbox yet. The rows are drawn from the roles a real account
          // would bring, so the column still shows the shape of the app while
          // the welcome state in the main pane asks for an account. They are not
          // indented: there is no group above them to belong to.
          <div className="sidebar-mailboxes">
            {pinnedMailRows}
            {DEFAULT_FOLDERS.map((folder) => (
              <SidebarButton
                key={folder.role}
                icon={folder.icon}
                label={t(folder.labelKey)}
                isActive={false}
                collapsed={sidebarCollapsed}
                onClick={() => safeSetActiveView("inbox")}
              />
            ))}
          </div>
        )}
      </nav>

      <div className="sidebar-divider" />

      {/* Bottom nav: the app's own destinations, then the control that folds the
          sidebar away. That control lives here rather than in a header so it is
          still reachable once the labels are gone. */}
      <nav
        className="sidebar-nav sidebar-nav--bottom"
        aria-label={t("sidebar.tools", "Tools")}
      >
        <SidebarButton
          icon={<ContactRound size={iconSize} />}
          label={t("sidebar.contacts", "Contacts")}
          isActive={activeView === "contacts"}
          collapsed={sidebarCollapsed}
          onClick={() => safeSetActiveView("contacts")}
        />
        <SidebarButton
          icon={<LayoutGrid size={iconSize} />}
          label={t("sidebar.kanban", "Kanban")}
          isActive={activeView === "kanban"}
          collapsed={sidebarCollapsed}
          onClick={() => safeSetActiveView("kanban")}
        />
        <SidebarButton
          icon={<Settings size={iconSize} />}
          label={t("sidebar.settings", "Settings")}
          isActive={activeView === "settings"}
          collapsed={sidebarCollapsed}
          onClick={() => safeSetActiveView("settings")}
        />
        <SidebarButton
          icon={sidebarCollapsed ? <PanelLeftOpen size={iconSize} /> : <PanelLeftClose size={iconSize} />}
          label={collapseLabel}
          isActive={false}
          collapsed={sidebarCollapsed}
          onClick={toggleSidebar}
        />
      </nav>

      {/* The folder menu is portalled out of this subtree, but it is mounted
          here so it can only exist while there is a sidebar to open it from. */}
      {folderMenu && (
        <FolderContextMenu
          position={folderMenu.position}
          label={t("folderMenu.actions", "{{folder}} actions", {
            folder: folderMenuLabel(folderMenu),
          })}
          items={folderMenuItems(folderMenu)}
          busy={folderMenuBusy}
          onClose={closeFolderMenu}
        />
      )}
    </aside>
  );
}

// Reusable sidebar row. Hover, selection and focus come from `.sidebar-row`, so
// every destination in the sidebar behaves the same way.
function SidebarButton({
  icon, label, badge, isActive, collapsed, onClick, disabled, className, trailing,
}: {
  icon: React.ReactNode;
  label: string;
  badge?: number;
  isActive: boolean;
  collapsed: boolean;
  onClick: () => void;
  disabled?: boolean;
  /** Extra class for rows that need their own surface, such as search. */
  className?: string;
  /** Rendered after the label, before the count. */
  trailing?: React.ReactNode;
}) {
  const classes = ["sidebar-row"];
  if (collapsed) classes.push("sidebar-row--collapsed");
  if (className) classes.push(className);

  return (
    <button
      type="button"
      className={classes.join(" ")}
      onClick={onClick}
      aria-label={collapsed ? label : undefined}
      aria-current={isActive ? "page" : undefined}
      data-selected={isActive ? "true" : undefined}
      title={collapsed ? label : undefined}
      disabled={disabled}
    >
      <span className="sidebar-row-icon">
        {icon}
        {/* With the labels gone the count has nowhere to go, so a dot carries
            the one bit that still matters: this folder has mail waiting. */}
        {collapsed && badge != null && badge > 0 && <span className="sidebar-unread-dot" />}
      </span>
      {!collapsed && <span className="sidebar-row-label">{label}</span>}
      {!collapsed && trailing}
      {!collapsed && !trailing && (
        <span className="sidebar-count-slot">
          {badge != null && badge > 0 && <span className="sidebar-count">{badge}</span>}
        </span>
      )}
    </button>
  );
}
