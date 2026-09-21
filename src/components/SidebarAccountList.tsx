import { useTranslation } from "react-i18next";
import { ChevronRight, Layers } from "lucide-react";
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import MarkAllReadButton from "./MarkAllReadButton";
import { folderIcon, folderLabel } from "./folderIcon";
import { useReorderAccounts } from "../hooks/mutations";
import { folderLeafName, unreadCountForFolder } from "../lib/folderAggregation";
import type { Account, Folder as FolderType } from "../lib/api";

/**
 * One entry in the mailbox column: a mailbox, or the combined view.
 *
 * The combined view is modelled as a group too, because it answers the same
 * question in the same shape — a heading with destinations under it. What
 * differs is only that it owns no mailbox: its children are the role folders
 * every account contributes to, and it cannot be reordered or marked read.
 */
export interface MailboxGroup {
  /** An account id, or `ALL_ACCOUNTS_ID` for the combined view. */
  id: string;
  /** `null` for the combined view. */
  account: Account | null;
  label: string;
  /** Second line, shown only for an account that carries its own label. */
  secondary: string | null;
  /** Full identity, for tooltips and accessible names. */
  full: string;
  unread: number;
  /** The rows nested under this group, already in display order. */
  folders: FolderType[];
  /** Avatar tint, or `null` for the combined view's own neutral avatar. */
  color: string | null;
  selected: boolean;
  /** The combined view takes no part in the mailbox order. */
  sortable: boolean;
  /** Nor does it have one mailbox for "mark all read" to clear. */
  canMarkAllRead: boolean;
  /**
   * A child row stands for every account's copy of its role, so its count is a
   * sum across mailboxes rather than the single folder's own number.
   */
  childrenAreCombined: boolean;
}

interface Props {
  groups: MailboxGroup[];
  collapsed: boolean;
  /** Mirrors the "show unread count badges in sidebar" setting. */
  showUnread: boolean;
  /** Unread mail per folder id, used by the groups that own real folders. */
  folderUnreadCounts: Record<string, number>;
  /** Every folder listed here, so a combined role can be totalled. */
  allFolders: FolderType[];
  /** The folder currently open, so its row can be marked. */
  activeFolderId: string | null;
  /** True while the mail view is the one showing the selected folder. */
  mailViewActive: boolean;
  onSelectGroup: (groupId: string) => void;
  onFolderSelect: (folderId: string, groupId: string) => void;
  /**
   * A folder row was right-clicked. The group travels with the folder because a
   * combined row (`all:inbox`) stands for every account's copy of its role, and
   * only the group says which expansion the menu should act on.
   */
  onFolderContextMenu?: (
    folder: FolderType,
    group: MailboxGroup,
    position: { x: number; y: number },
  ) => void;
  /** Account ids whose group is folded shut. */
  collapsedGroupIds: string[];
  onToggleGroup: (groupId: string) => void;
  /**
   * Views that belong to no single mailbox. They sit above the groups, the way
   * macOS Mail keeps its favorites above the accounts.
   */
  pinnedRows?: React.ReactNode;
}

const AVATAR_SIZE = 26;

/** The collapsed rail is wider than the avatar needs, so the avatar grows with it. */
const COLLAPSED_AVATAR_SIZE = 30;

/** Counts above this read as `99+`, so the pill never grows past two digits. */
const BADGE_CAP = 99;

/** The same idea for the collapsed rail, where only one digit fits. */
const COMPACT_BADGE_CAP = 9;

/**
 * How far the pointer must travel before a press becomes a drag.
 *
 * The row is also the button that selects a mailbox, so the two gestures share
 * one press: below this distance nothing moves and the click lands, above it
 * the row is picked up. Five pixels is the same threshold the kanban board uses
 * for its cards.
 */
const DRAG_ACTIVATION_DISTANCE = 5;

/**
 * One draggable mailbox: the account row plus the folders nested under it.
 *
 * The transform covers the whole group, so a mailbox that is moved carries its
 * folders with it, while the drag listeners sit on the header alone — a press
 * that starts on a folder row is a click on that folder, never the beginning of
 * a mailbox reorder.
 *
 * The gesture is pointer-only on purpose: dnd-kit's keyboard sensor needs
 * `role="button"` and a tab stop on this wrapper, which would nest the row's own
 * buttons inside a second button, and a keyboard user already has the arrows in
 * Settings › Accounts. dnd-kit also swallows the click that follows a drag, so a
 * row that was moved is not also selected on release.
 */
function SortableAccountGroup({
  id,
  disabled,
  header,
  children,
}: {
  id: string;
  disabled: boolean;
  header: React.ReactNode;
  children: React.ReactNode;
}) {
  const { setNodeRef, listeners, transform, transition, isDragging } = useSortable({ id, disabled });

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.6 : 1,
        position: "relative",
        zIndex: isDragging ? 1 : undefined,
      }}
    >
      {/* The header is the handle: the list is short and the label is the
          obvious thing to grab. */}
      <div {...listeners} style={{ cursor: "grab" }}>
        {header}
      </div>
      {children}
    </div>
  );
}

function initialOf(text: string): string {
  const trimmed = text.trim();
  return trimmed ? trimmed.charAt(0).toUpperCase() : "?";
}

function formatUnread(count: number, compact = false): string {
  // The collapsed rail has no room for three digits, so the badge trades the
  // exact number for staying inside the row. The full count is still in the
  // row's accessible name and in the badge's tooltip.
  const cap = compact ? COMPACT_BADGE_CAP : BADGE_CAP;
  return count > cap ? `${cap}+` : String(count);
}

/**
 * The mailbox monogram, tinted with the colour that account already carries in
 * the message list. The tint is a mix rather than a solid fill so the avatar
 * stays translucent over a wallpaper and the letter keeps its contrast.
 */
function avatarStyle(color: string, isActive: boolean, collapsed: boolean): React.CSSProperties {
  const size = collapsed ? COLLAPSED_AVATAR_SIZE : AVATAR_SIZE;
  return {
    width: size,
    height: size,
    borderRadius: "50%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    fontSize: collapsed ? 12 : 10.5,
    fontWeight: 700,
    backgroundColor: `color-mix(in srgb, ${color} ${isActive ? 26 : 14}%, transparent)`,
    color,
    boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${color} ${isActive ? 40 : 22}%, transparent)`,
  };
}

/**
 * Wraps an avatar so the unread badge can be pinned to its corner without
 * taking part in the row's layout — a badge that reserves space would push the
 * address sideways every time mail arrives.
 */
function avatarStackStyle(): React.CSSProperties {
  return { position: "relative", display: "inline-flex", flexShrink: 0 };
}

/**
 * The unread count for a collapsed sidebar, as a pill on the avatar.
 *
 * A collapsed row has no trailing edge to put a count on, and a mailbox's state
 * is hardest to read there. Pinning the count to the avatar keeps it attached
 * to the mailbox it belongs to. The ring lifts the pill off the monogram
 * underneath it.
 */
function unreadBadgeStyle(): React.CSSProperties {
  return {
    position: "absolute",
    bottom: "-2px",
    right: "-3px",
    minWidth: "15px",
    height: "15px",
    padding: "0 4px",
    boxSizing: "border-box",
    borderRadius: "8px",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "var(--color-accent)",
    color: "#ffffff",
    fontSize: "9.5px",
    fontWeight: 700,
    lineHeight: 1,
    fontVariantNumeric: "tabular-nums",
    pointerEvents: "none",
    boxShadow: "0 0 0 2px var(--color-sidebar-bg)",
  };
}

/**
 * The count is hidden from assistive tech on purpose: the row's own accessible
 * name already spells out "3 unread", so announcing the pill as well would say
 * the same thing twice.
 *
 * This badge only ever rides a collapsed row, so it is always drawn compact.
 */
function UnreadBadge({
  count,
  testId,
  title,
}: {
  count: number;
  testId: string;
  title: string;
}) {
  return (
    <span data-testid={testId} title={title} aria-hidden="true" style={unreadBadgeStyle()}>
      {formatUnread(count, true)}
    </span>
  );
}

/**
 * The mailbox column.
 *
 * Every configured mailbox is its own group with its folders nested underneath —
 * the shape macOS Mail uses, and the one that answers the question a mail
 * sidebar is actually asked: *which mailbox does this folder belong to?* The
 * previous layout stacked an account picker on top of a single flat folder list,
 * so the column read as two lists rather than one, and once two accounts shared
 * a folder name there was no way to tell which mailbox a row belonged to.
 *
 * A group is folded by pressing its disclosure triangle; the account row itself
 * still opens the mailbox, because that is the more common gesture. The two
 * actions get their own targets rather than sharing one press.
 *
 * While the rail is folded there is no room for children, so the groups reduce
 * to avatars and no triangle is drawn.
 */
export default function SidebarAccountList({
  groups,
  collapsed,
  showUnread,
  folderUnreadCounts,
  allFolders,
  activeFolderId,
  mailViewActive,
  onSelectGroup,
  onFolderSelect,
  onFolderContextMenu,
  collapsedGroupIds,
  onToggleGroup,
  pinnedRows,
}: Props) {
  const { t } = useTranslation();
  const { reorder, isReordering } = useReorderAccounts();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: DRAG_ACTIVATION_DISTANCE } }),
  );

  const sortableGroups = groups.filter((group) => group.sortable);

  /**
   * Collapsed rows lose their label, so the accessible name is the only place a
   * reader can learn how much mail is waiting. The badge itself is decorative.
   */
  function accessibleLabelOf(label: string, unreadText: string | null): string {
    return unreadText ? `${label} · ${unreadText}` : label;
  }

  function unreadTextOf(unread: number): string | null {
    return showUnread && unread > 0
      ? t("sidebar.unreadCount", "{{count}} unread", { count: unread })
      : null;
  }

  /** Hand the new order to the same command the Settings arrows use. */
  function handleDragEnd({ active, over }: DragEndEvent) {
    if (!over || active.id === over.id) return;
    const from = sortableGroups.findIndex((group) => group.id === active.id);
    const to = sortableGroups.findIndex((group) => group.id === over.id);
    if (from === -1 || to === -1) return;
    // The groups that can be dragged are exactly the accounts, in display order,
    // and each carries its own record — so the new order is written from the
    // same objects the rest of the app reads rather than from bare ids.
    const reordered = arrayMove(sortableGroups, from, to)
      .map((group) => group.account)
      .filter((account): account is Account => account !== null);
    void reorder(reordered);
  }

  const roleLabels: Record<string, string> = {
    inbox: t("sidebar.inbox"),
    sent: t("sidebar.sent"),
    drafts: t("sidebar.drafts"),
    trash: t("sidebar.trash"),
    archive: t("sidebar.archive"),
    spam: t("sidebar.spam"),
  };

  /**
   * One folder row inside a group.
   *
   * A real folder shows its own unread mail. A combined role shows the total
   * across every account, because that row stands for all of their copies at
   * once — the same expansion the message list performs when the row is opened.
   */
  function renderFolderRow(folder: FolderType, group: MailboxGroup): React.ReactNode {
    const isActive = mailViewActive && folder.id === activeFolderId;
    const unread = !showUnread
      ? 0
      : group.childrenAreCombined
        ? unreadCountForFolder(folder.id, allFolders, folderUnreadCounts)
        : folderUnreadCounts[folder.id] ?? 0;
    const label = folderLabel(folder, roleLabels);

    return (
      <button
        key={folder.id}
        type="button"
        className="sidebar-row sidebar-row--nested"
        onClick={() => onFolderSelect(folder.id, group.id)}
        onContextMenu={(event) => {
          if (!onFolderContextMenu) return;
          // The native menu would cover the app's own, and on a folder row it
          // offers nothing this app can honour anyway.
          event.preventDefault();
          onFolderContextMenu(folder, group, { x: event.clientX, y: event.clientY });
        }}
        aria-current={isActive ? "page" : undefined}
        data-selected={isActive ? "true" : undefined}
        data-testid={`folder-row-${folder.id}`}
        // The row shows the folder's own name; a nested one is stored as its
        // whole path, and the tooltip is where the levels above it stay
        // readable. A name that was never a path carries no tooltip at all,
        // because a tooltip that repeats the label is only noise.
        title={folderLeafName(folder.name) === folder.name ? undefined : folder.name}
      >
        <span className="sidebar-row-icon">{folderIcon(folder.role, 16)}</span>
        <span className="sidebar-row-label">{label}</span>
        <span className="sidebar-count-slot">
          {unread > 0 && <span className="sidebar-count">{formatUnread(unread)}</span>}
        </span>
      </button>
    );
  }

  function renderGroupHeader(group: MailboxGroup): React.ReactNode {
    const unreadText = unreadTextOf(group.unread);
    const isOpen = !collapsedGroupIds.includes(group.id);
    // A group with nothing inside cannot be opened, so it is drawn as a plain
    // row rather than offering a triangle that would do nothing.
    const canToggle = !collapsed && group.folders.length > 0;

    return (
      <div
        data-testid={`account-row-${group.id}`}
        className="sidebar-account-row"
        data-selected={group.selected ? "true" : undefined}
      >
        {/* The leading column belongs to the disclosure triangle and is
            reserved whether or not this mailbox has folders to fold, so every
            avatar in the column sits on one left edge. */}
        {!collapsed && (canToggle ? (
          <button
            type="button"
            className="sidebar-group-toggle"
            onClick={() => onToggleGroup(group.id)}
            aria-expanded={isOpen}
            data-testid={`account-toggle-${group.id}`}
            aria-label={t("sidebar.toggleMailbox", "{{name}} folders", { name: group.full })}
            title={t("sidebar.toggleMailbox", "{{name}} folders", { name: group.full })}
          >
            <ChevronRight
              size={13}
              className="sidebar-group-chevron"
              data-open={isOpen ? "true" : "false"}
            />
          </button>
        ) : (
          <span className="sidebar-group-toggle-spacer" aria-hidden="true" />
        ))}
        <button
          type="button"
          onClick={() => onSelectGroup(group.id)}
          aria-current={group.selected ? "true" : undefined}
          aria-label={collapsed ? accessibleLabelOf(group.full, unreadText) : undefined}
          title={collapsed ? accessibleLabelOf(group.full, unreadText) : undefined}
          data-testid={`account-select-${group.id}`}
          className={`sidebar-account-button${collapsed ? " sidebar-account-button--collapsed" : ""}`}
        >
          <span style={avatarStackStyle()}>
            <span
              style={avatarStyle(group.color ?? "var(--color-accent)", group.selected, collapsed)}
              data-testid={`account-avatar-${group.id}`}
              aria-hidden="true"
            >
              {group.account ? initialOf(group.label) : <Layers size={collapsed ? 14 : 12} />}
            </span>
            {collapsed && unreadText && (
              <UnreadBadge
                count={group.unread}
                testId={`account-unread-${group.id}`}
                title={unreadText}
              />
            )}
          </span>
          {!collapsed && (
            <span className="sidebar-account-name">
              <span className="sidebar-account-title" title={group.full}>
                {group.label}
              </span>
              {group.secondary && (
                <span className="sidebar-account-address">{group.secondary}</span>
              )}
            </span>
          )}
        </button>
        {/* Rendered even at zero unread so the action stays discoverable; the
            button disables itself. It is absent for the combined view, where
            "mark all read" has no single mailbox to clear. */}
        {!collapsed && group.selected && group.canMarkAllRead && group.account && (
          // A press on the action must not be read as picking up the row.
          <span className="sidebar-row-action" onPointerDown={(event) => event.stopPropagation()}>
            <MarkAllReadButton
              accountId={group.account.id}
              accountLabel={group.full}
              unread={group.unread}
              style={{ width: 22, height: 22, padding: 0, borderRadius: 6 }}
            />
          </span>
        )}
        {!collapsed && (
          <span className="sidebar-count-slot">
            {unreadText && (
              <span
                className="sidebar-count"
                data-testid={`account-unread-${group.id}`}
                title={unreadText}
              >
                {formatUnread(group.unread)}
              </span>
            )}
          </span>
        )}
      </div>
    );
  }

  function renderChildren(group: MailboxGroup): React.ReactNode {
    const isOpen = !collapsedGroupIds.includes(group.id);
    if (collapsed || group.folders.length === 0 || !isOpen) return null;

    return (
      <div
        className="sidebar-group-children"
        data-testid={`account-folders-${group.id}`}
        role="group"
        aria-label={t("sidebar.mailFolders", "Mail folders")}
      >
        {group.folders.map((folder) => renderFolderRow(folder, group))}
      </div>
    );
  }

  return (
    <div className="sidebar-mailboxes" data-testid="account-list">
      {/* Views that belong to no mailbox sit above the groups, the way macOS
          Mail keeps its favorites above the accounts. They survive the folded
          rail too: with the labels gone they are still the only way to reach
          Starred and Snoozed from the sidebar. */}
      {pinnedRows}

      <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
        <SortableContext
          items={sortableGroups.map((group) => group.id)}
          strategy={verticalListSortingStrategy}
        >
          {groups.map((group) =>
            group.sortable ? (
              <SortableAccountGroup
                key={group.id}
                id={group.id}
                disabled={isReordering}
                header={renderGroupHeader(group)}
              >
                {renderChildren(group)}
              </SortableAccountGroup>
            ) : (
              // The combined view is a destination rather than a mailbox, so it
              // is not draggable and owns no account.
              <div key={group.id}>
                {renderGroupHeader(group)}
                {renderChildren(group)}
              </div>
            ),
          )}
        </SortableContext>
      </DndContext>
    </div>
  );
}
