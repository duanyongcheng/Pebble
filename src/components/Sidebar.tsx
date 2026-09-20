import { useEffect, useMemo } from "react";
import {
  Inbox,
  Send,
  FileEdit,
  Trash2,
  Archive,
  AlertTriangle,
  Folder,
  LayoutGrid,
  Settings,
  Search,
  Clock,
  Star,
  ContactRound,
  PanelLeftClose,
  PanelLeftOpen,
  type LucideIcon,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { useUIStore } from "../stores/ui.store";
import type { ActiveView } from "../stores/ui.store";
import { isComposeDirty, useComposeStore } from "../stores/compose.store";
import { useConfirmStore } from "../stores/confirm.store";
import { useMailStore } from "../stores/mail.store";
import { useShortcutStore } from "../stores/shortcut.store";
import { useAccountsQuery, useFoldersForAccountsQuery } from "../hooks/queries";
import { useFolderUnreadCountsForAccounts } from "../hooks/queries/useFolderUnreadCounts";
import { useAccountUnreadCounts } from "../hooks/queries/useAccountUnreadCounts";
import SidebarAccountList from "./SidebarAccountList";
import {
  buildAllAccountsFolders,
  sortFoldersForSidebar,
  unreadCountForFolder,
} from "../lib/folderAggregation";
import type { Account, Folder as FolderType } from "../lib/api";

const EMPTY_ACCOUNTS: Account[] = [];
const EMPTY_FOLDERS: FolderType[] = [];

const EXPANDED_WIDTH = 216;
const COLLAPSED_WIDTH = 60;

const ROLE_ICONS: Record<string, LucideIcon> = {
  inbox: Inbox,
  sent: Send,
  drafts: FileEdit,
  trash: Trash2,
  archive: Archive,
  spam: AlertTriangle,
};

/** The rail has no labels, so its icons carry a little more of the row. */
const ICON_SIZE = 16;
const COLLAPSED_ICON_SIZE = 18;

function folderIcon(role: FolderType["role"], size: number): React.ReactNode {
  const Icon = (role && ROLE_ICONS[role]) || Folder;
  return <Icon size={size} />;
}

// Default folders shown when no account is configured
const DEFAULT_FOLDERS: { role: string; labelKey: string }[] = [
  { role: "inbox", labelKey: "sidebar.inbox" },
  { role: "sent", labelKey: "sidebar.sent" },
  { role: "archive", labelKey: "sidebar.archive" },
  { role: "drafts", labelKey: "sidebar.drafts" },
  { role: "trash", labelKey: "sidebar.trash" },
  { role: "spam", labelKey: "sidebar.spam" },
];

/**
 * Views that show nothing about a particular mailbox. Selecting an account while
 * one of these is open has to move back to the mail view, otherwise the click
 * appears to do nothing.
 */
const MAILBOX_AGNOSTIC_VIEWS: ActiveView[] = ["settings", "contacts"];

export default function Sidebar() {
  const { t } = useTranslation();
  const activeView = useUIStore((s) => s.activeView);
  const setActiveView = useUIStore((s) => s.setActiveView);
  const sidebarCollapsed = useUIStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const searchShortcut = useShortcutStore((s) => s.bindings["focus-search"]);
  const activeFolderId = useMailStore((s) => s.activeFolderId);
  const activeAccountId = useMailStore((s) => s.activeAccountId);
  const setActiveAccountId = useMailStore((s) => s.setActiveAccountId);
  const setActiveFolderId = useMailStore((s) => s.setActiveFolderId);

  const showUnread = useUIStore((s) => s.showFolderUnreadCount);
  const { data: accounts = EMPTY_ACCOUNTS } = useAccountsQuery();
  const allAccountsMode = accounts.length > 1 && !activeAccountId;
  const folderAccountIds = useMemo(
    () => activeAccountId ? [activeAccountId] : accounts.map((account) => account.id),
    [accounts, activeAccountId],
  );
  const { data: folders = EMPTY_FOLDERS } = useFoldersForAccountsQuery(folderAccountIds);
  const { data: unreadCounts = {} } = useFolderUnreadCountsForAccounts(folderAccountIds);
  const accountUnreadCounts = useAccountUnreadCounts();
  const ROLE_LABELS: Record<string, string> = {
    inbox: t("sidebar.inbox"),
    sent: t("sidebar.sent"),
    drafts: t("sidebar.drafts"),
    trash: t("sidebar.trash"),
    archive: t("sidebar.archive"),
    spam: t("sidebar.spam"),
  };
  const folderLabel = (folder: FolderType) => (folder.role && ROLE_LABELS[folder.role]) || folder.name;

  const displayedFolders = useMemo(
    () => allAccountsMode ? buildAllAccountsFolders(folders) : folders,
    [allAccountsMode, folders],
  );
  const hasRealFolders = displayedFolders.length > 0;

  // Keep system folders stable across all-account and single-account views.
  const dedupedFolders = useMemo(() => {
    return sortFoldersForSidebar(displayedFolders);
  }, [displayedFolders]);

  // Auto-select the only account. With multiple accounts, null means the
  // combined "all accounts" mailbox.
  useEffect(() => {
    if (accounts.length === 1 && !activeAccountId) {
      setActiveAccountId(accounts[0].id);
    }
  }, [accounts, activeAccountId, setActiveAccountId]);

  // Auto-select inbox folder when folders load.
  //
  // A mailbox with no folders is left selected on purpose. The previous version
  // advanced to the next account, which made any account whose first sync had not
  // finished impossible to select at all: clicking it bounced the selection away.
  // InboxView shows a sync prompt for that case instead.
  useEffect(() => {
    if (displayedFolders.length > 0 && !activeFolderId) {
      const inbox = displayedFolders.find((f) => f.role === "inbox");
      setActiveFolderId((inbox ?? displayedFolders[0]).id);
    }
  }, [displayedFolders, activeFolderId, setActiveFolderId]);

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

  async function handleFolderClick(folderId: string) {
    if (isComposeDirty()) {
      const confirmed = await confirmDiscardDraft();
      if (!confirmed) return;
      useComposeStore.getState().discardComposeAndSetActiveView("inbox");
      setActiveFolderId(folderId);
      return;
    }
    setActiveView("inbox");
    setActiveFolderId(folderId);
  }

  async function handleAccountSelect(accountId: string | null) {
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

  const iconSize = sidebarCollapsed ? COLLAPSED_ICON_SIZE : ICON_SIZE;

  const collapseLabel = sidebarCollapsed
    ? t("sidebar.expand", "Expand sidebar")
    : t("sidebar.collapse", "Collapse sidebar");

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

      {/* Section label */}
      {!sidebarCollapsed && (
        <div className="sidebar-section-label">{t("sidebar.mail", "Mail")}</div>
      )}

      {/* Account list. Every mailbox is listed at once, with its own unread
          count, so accounts can be told apart and switched between at a glance.
          The mark-all-read action rides on the selected row, because clearing a
          mailbox only has a target when one account is selected. */}
      {accounts.length > 0 && (
        <SidebarAccountList
          accounts={accounts}
          activeAccountId={activeAccountId}
          unreadCounts={accountUnreadCounts}
          collapsed={sidebarCollapsed}
          showUnread={showUnread}
          onSelect={handleAccountSelect}
        />
      )}

      {/* Folders section */}
      <nav
        className="scroll-region sidebar-folders"
        aria-label={t("sidebar.mailFolders", "Mail folders")}
        style={{
          flex: 1,
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          gap: "1px",
        }}
      >
        {hasRealFolders
          ? dedupedFolders.flatMap((folder) => {
              const items: React.ReactNode[] = [];
              if (folder.role === "drafts") {
                items.push(
                  <SidebarButton
                    key="__starred__"
                    icon={<Star size={iconSize} />}
                    label={t("sidebar.starred", "Starred")}
                    isActive={activeView === "starred"}
                    collapsed={sidebarCollapsed}
                    onClick={() => safeSetActiveView("starred")}
                  />
                );
              }
              const isActive = folder.id === activeFolderId && activeView === "inbox";
              items.push(
                <SidebarButton
                  key={folder.id}
                  icon={folderIcon(folder.role, iconSize)}
                  label={folderLabel(folder)}
                  badge={showUnread ? unreadCountForFolder(folder.id, folders, unreadCounts) : undefined}
                  isActive={isActive}
                  collapsed={sidebarCollapsed}
                  onClick={() => handleFolderClick(folder.id)}
                />
              );
              return items;
            })
          : DEFAULT_FOLDERS.flatMap((df, index) => {
              const items: React.ReactNode[] = [];
              if (df.role === "drafts") {
                items.push(
                  <SidebarButton
                    key="__starred__"
                    icon={<Star size={iconSize} />}
                    label={t("sidebar.starred", "Starred")}
                    isActive={activeView === "starred"}
                    collapsed={sidebarCollapsed}
                    onClick={() => safeSetActiveView("starred")}
                  />
                );
              }
              items.push(
                <SidebarButton
                  key={df.role}
                  icon={folderIcon(df.role as FolderType["role"], iconSize)}
                  label={t(df.labelKey)}
                  isActive={index === 0 && activeView === "inbox"}
                  collapsed={sidebarCollapsed}
                  onClick={() => safeSetActiveView("inbox")}
                />
              );
              return items;
            })}
      </nav>

      <div className="sidebar-divider" />

      {/* Bottom nav: Contacts + Snoozed + Kanban + Settings, then the control
          that folds the sidebar away. That control lives here rather than in a
          header so it is still reachable once the labels are gone. */}
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
          icon={<Clock size={iconSize} />}
          label={t("sidebar.snoozed", "Snoozed")}
          isActive={activeView === "snoozed"}
          collapsed={sidebarCollapsed}
          onClick={() => safeSetActiveView("snoozed")}
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
