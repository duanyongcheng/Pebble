import { useTranslation } from "react-i18next";
import { Layers } from "lucide-react";
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
import { accountLabel, accountOptionLabel } from "../lib/accountIdentity";
import { assignAccountColors, getAccountColor } from "../lib/accountColors";
import { unreadCountForAccount } from "../hooks/queries/useAccountUnreadCounts";
import { useReorderAccounts } from "../hooks/mutations";
import { ALL_ACCOUNTS_SELECT_VALUE } from "../lib/folderAggregation";
import type { Account } from "../lib/api";

interface Props {
  accounts: Account[];
  /** `null` means the combined "all accounts" mailbox. */
  activeAccountId: string | null;
  /** Unread mail per account, keyed by account id. */
  unreadCounts: Record<string, number>;
  collapsed: boolean;
  /** Mirrors the "show unread count badges in sidebar" setting. */
  showUnread: boolean;
  /** `null` selects the combined mailbox. */
  onSelect: (accountId: string | null) => void;
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
 * One draggable account row.
 *
 * The whole row is the drag surface rather than a handle, because the list is
 * short and the label is the obvious thing to grab. The gesture is pointer-only
 * on purpose: dnd-kit's keyboard sensor needs `role="button"` and a tab stop on
 * this wrapper, which would nest the row's own select button inside a second
 * button, and a keyboard user already has the arrows in Settings › Accounts.
 *
 * dnd-kit also swallows the click that follows a drag, so a row that was moved
 * is not also selected on release.
 */
function SortableAccountRow({
  id,
  disabled,
  children,
}: {
  id: string;
  disabled: boolean;
  children: React.ReactNode;
}) {
  const { setNodeRef, listeners, transform, transition, isDragging } = useSortable({ id, disabled });

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.6 : 1,
        // Only the row's own padding shows this; the select button keeps its
        // pointer cursor, so a press still reads as "open this mailbox".
        cursor: "grab",
        position: "relative",
        zIndex: isDragging ? 1 : undefined,
      }}
    >
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
 * The account picker in the sidebar.
 *
 * Every configured mailbox is listed at once — with its own unread count — so
 * accounts can be told apart and switched between without opening a dropdown.
 * Rows for accounts that carry a custom label show the label and the address on
 * two lines; unlabelled accounts show the address alone. The selected row also
 * carries the mark-all-read action, because that work belongs to one mailbox and
 * has no meaning for the combined view.
 *
 * Counts land in the same trailing column the folder list uses, so the two
 * blocks read as one list and the numbers line up.
 */
export default function SidebarAccountList({
  accounts,
  activeAccountId,
  unreadCounts,
  collapsed,
  showUnread,
  onSelect,
}: Props) {
  const { t } = useTranslation();
  const { reorder, isReordering } = useReorderAccounts();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: DRAG_ACTIVATION_DISTANCE } }),
  );

  // The sentinel is what the old `<select>` posted for the combined mailbox;
  // the store normally holds `null` for it, so accept both.
  const allSelected = !activeAccountId || activeAccountId === ALL_ACCOUNTS_SELECT_VALUE;
  const showAllRow = accounts.length > 1;
  const totalUnread = accounts.reduce(
    (sum, account) => sum + unreadCountForAccount(unreadCounts, account.id),
    0,
  );

  /**
   * Colours are handed out across the whole list, so two mailboxes never end up
   * with the same one and the avatar matches the badge on the account's mail.
   */
  const colorsByAccountId = assignAccountColors(accounts);

  function accountColorOf(account: Account): string {
    return colorsByAccountId.get(account.id) ?? getAccountColor(account, account.id);
  }

  function buttonClass(collapsedRow: boolean): string {
    return collapsedRow ? "sidebar-account-button sidebar-account-button--collapsed" : "sidebar-account-button";
  }

  /**
   * Collapsed rows lose their label, so the accessible name is the only place a
   * reader can learn how much mail is waiting. The badge itself is decorative.
   */
  function accessibleLabelOf(label: string, unreadText: string | null): string {
    return unreadText ? `${label} · ${unreadText}` : label;
  }

  function handleSelect(accountId: string | null) {
    onSelect(accountId);
  }

  /** Hand the new order to the same command the Settings arrows use. */
  function handleDragEnd({ active, over }: DragEndEvent) {
    if (!over || active.id === over.id) return;
    const from = accounts.findIndex((account) => account.id === active.id);
    const to = accounts.findIndex((account) => account.id === over.id);
    if (from === -1 || to === -1) return;
    void reorder(arrayMove(accounts, from, to));
  }

  const allUnreadText = showUnread && totalUnread > 0
    ? t("sidebar.unreadCount", "{{count}} unread", { count: totalUnread })
    : null;
  const allLabel = accessibleLabelOf(t("sidebar.allAccounts", "All accounts"), allUnreadText);

  return (
    <div
      className="scroll-region"
      data-testid="account-list"
      role="group"
      aria-label={t("settings.emailAccounts", "Email Accounts")}
      style={{
        padding: collapsed ? "4px 8px 6px" : "0 8px 2px",
        display: "flex",
        flexDirection: "column",
        gap: "2px",
        maxHeight: "34vh",
        overflowY: "auto",
      }}
    >
      {showAllRow && (
        <div
          data-testid="account-row-all"
          className="sidebar-account-row"
          data-selected={allSelected ? "true" : undefined}
        >
          <button
            type="button"
            onClick={() => handleSelect(null)}
            aria-current={allSelected ? "true" : undefined}
            aria-label={collapsed ? allLabel : undefined}
            title={collapsed ? allLabel : undefined}
            className={buttonClass(collapsed)}
          >
            <span style={avatarStackStyle()}>
              <span style={avatarStyle("var(--color-accent)", allSelected, collapsed)} aria-hidden="true">
                <Layers size={collapsed ? 14 : 12} />
              </span>
              {collapsed && allUnreadText && (
                <UnreadBadge
                  count={totalUnread}
                  testId="account-unread-all"
                  title={allUnreadText}
                />
              )}
            </span>
            {!collapsed && (
              <span className="sidebar-row-label">
                {t("sidebar.allAccounts", "All accounts")}
              </span>
            )}
          </button>
          {!collapsed && (
            <span className="sidebar-count-slot">
              {allUnreadText && <span className="sidebar-count" data-testid="account-unread-all">{formatUnread(totalUnread)}</span>}
            </span>
          )}
        </div>
      )}

      {/* The combined row above stays put: it is a view, not a mailbox, so it
          takes no part in the order. */}
      <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
        <SortableContext
          items={accounts.map((account) => account.id)}
          strategy={verticalListSortingStrategy}
        >
          {accounts.map((account) => {
            const isActive = !allSelected && account.id === activeAccountId;
            const unread = unreadCountForAccount(unreadCounts, account.id);
            const label = accountLabel(account);
            // Only repeat the address on a second line when it differs from the label.
            const secondary = account.account_label?.trim() ? account.email : null;
            const full = accountOptionLabel(account);
            const unreadText = showUnread && unread > 0
              ? t("sidebar.unreadCount", "{{count}} unread", { count: unread })
              : null;

            return (
              <SortableAccountRow
                key={account.id}
                id={account.id}
                disabled={isReordering}
              >
                <div
                  data-testid={`account-row-${account.id}`}
                  className="sidebar-account-row"
                  data-selected={isActive ? "true" : undefined}
                >
                  <button
                    type="button"
                    onClick={() => handleSelect(account.id)}
                    aria-current={isActive ? "true" : undefined}
                    aria-label={collapsed ? accessibleLabelOf(full, unreadText) : undefined}
                    title={collapsed ? accessibleLabelOf(full, unreadText) : undefined}
                    className={buttonClass(collapsed)}
                  >
                    <span style={avatarStackStyle()}>
                      <span style={avatarStyle(accountColorOf(account), isActive, collapsed)} aria-hidden="true">
                        {initialOf(label)}
                      </span>
                      {collapsed && unreadText && (
                        <UnreadBadge
                          count={unread}
                          testId={`account-unread-${account.id}`}
                          title={unreadText}
                        />
                      )}
                    </span>
                    {!collapsed && (
                      <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: "1px" }}>
                        <span
                          title={full}
                          style={{
                            fontSize: "12.5px",
                            fontWeight: isActive ? 600 : 500,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {label}
                        </span>
                        {secondary && (
                          <span
                            style={{
                              fontSize: "11px",
                              color: "var(--color-text-secondary)",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {secondary}
                          </span>
                        )}
                      </span>
                    )}
                  </button>
                  {/* Rendered even at zero unread so the action stays discoverable; the
                      button disables itself. It is absent for the combined mailbox,
                      where "mark all read" has no single target. */}
                  {!collapsed && isActive && (
                    // A press on the action must not be read as picking up the row.
                    <span
                      className="sidebar-row-action"
                      onPointerDown={(event) => event.stopPropagation()}
                    >
                      <MarkAllReadButton
                        accountId={account.id}
                        accountLabel={full}
                        unread={unread}
                        style={{ width: 22, height: 22, padding: 0, borderRadius: 6 }}
                      />
                    </span>
                  )}
                  {!collapsed && (
                    <span className="sidebar-count-slot">
                      {unreadText && (
                        <span
                          className="sidebar-count"
                          data-testid={`account-unread-${account.id}`}
                          title={unreadText}
                        >
                          {formatUnread(unread)}
                        </span>
                      )}
                    </span>
                  )}
                </div>
              </SortableAccountRow>
            );
          })}
        </SortableContext>
      </DndContext>
    </div>
  );
}
