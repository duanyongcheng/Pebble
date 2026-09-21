import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Loader, MailOpen, RefreshCw, Trash2 } from "lucide-react";
import { useClickOutside } from "@/hooks/useClickOutside";

/**
 * One row of the folder menu.
 *
 * `disabled` is how an action states it has nothing to do — "mark all as read"
 * on a folder with no unread mail — rather than disappearing, which would leave
 * the menu a different height depending on the folder and hide the action from
 * anyone who has not seen it yet.
 */
export interface FolderMenuItem {
  id: string;
  label: string;
  icon: React.ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  /** Paints the row in the danger colour. Used by the empty-folder actions. */
  destructive?: boolean;
  /** Rendered at the trailing edge, e.g. the unread count being cleared. */
  badge?: number;
}

interface Props {
  /** Viewport coordinates of the press that opened the menu. */
  position: { x: number; y: number };
  /** Accessible name, e.g. "Inbox actions". */
  label: string;
  items: FolderMenuItem[];
  /** True while an action is running: every row is held disabled. */
  busy: boolean;
  onClose: () => void;
}

/** Keeps the panel off the window edges when the press lands near one. */
const EDGE_MARGIN = 8;

/**
 * The menu a folder row opens on right-click.
 *
 * It is rendered through a portal onto `document.body` and positioned with
 * `position: fixed`. Both are load-bearing: the sidebar sets `overflow: hidden`
 * to fold its rows away, and the app shell opens a stacking context, so a menu
 * drawn inside the row would be clipped at the panel's edge and would sort
 * under the message list.
 *
 * Keyboard behaviour is the minimum a `role="menu"` promises: focus moves into
 * the menu on open, the arrows and Home/End walk the rows, Enter and Space
 * activate, Escape closes and returns focus to the row that opened it. Escape is
 * claimed through `useClickOutside`, which also marks the node so the app's
 * global shortcut layer knows a popover owns this keystroke.
 */
export default function FolderContextMenu({
  position,
  label,
  items,
  busy,
  onClose,
}: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [placement, setPlacement] = useState(position);

  useClickOutside(ref, true, onClose);

  /**
   * Measure once the panel exists, then flip it back inside the window.
   *
   * A folder row can be the last thing above the status bar, so a menu that
   * always opened downwards would run off the bottom on exactly the folders at
   * the end of a long list. The first paint is at the press point and the
   * correction happens before the browser paints, so it never flashes in the
   * wrong place.
   */
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const { width, height } = node.getBoundingClientRect();
    const maxX = window.innerWidth - width - EDGE_MARGIN;
    const maxY = window.innerHeight - height - EDGE_MARGIN;
    setPlacement({
      x: Math.max(EDGE_MARGIN, Math.min(position.x, maxX)),
      y: Math.max(EDGE_MARGIN, Math.min(position.y, maxY)),
    });
  }, [position.x, position.y, items.length]);

  // Focus the first row so the menu is usable from the keyboard the moment it
  // opens. `preventScroll` matters because focusing a portalled node can
  // otherwise scroll the sidebar underneath it.
  useEffect(() => {
    const first = ref.current?.querySelector<HTMLButtonElement>(
      '[role="menuitem"]:not([disabled])',
    );
    first?.focus({ preventScroll: true });
  }, []);

  const enabledIndexes = items
    .map((item, index) => (item.disabled || busy ? -1 : index))
    .filter((index) => index !== -1);

  /** Walk the enabled rows only, so the arrows never land on a dead one. */
  function moveFocus(delta: number) {
    if (enabledIndexes.length === 0) return;
    const current = enabledIndexes.indexOf(activeIndex);
    const next = current === -1
      ? enabledIndexes[0]
      : enabledIndexes[(current + delta + enabledIndexes.length) % enabledIndexes.length];
    setActiveIndex(next);
    ref.current
      ?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')
      [next]?.focus({ preventScroll: true });
  }

  function handleKeyDown(event: React.KeyboardEvent) {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        moveFocus(1);
        break;
      case "ArrowUp":
        event.preventDefault();
        moveFocus(-1);
        break;
      case "Home":
        event.preventDefault();
        moveFocus(-enabledIndexes.length);
        break;
      case "End":
        event.preventDefault();
        moveFocus(enabledIndexes.length);
        break;
      case "Tab":
        // A menu is not a tab stop: leaving it means dismissing it.
        event.preventDefault();
        onClose();
        break;
      default:
        break;
    }
  }

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      aria-busy={busy}
      data-testid="folder-context-menu"
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={handleKeyDown}
      style={{
        position: "fixed",
        left: placement.x,
        top: placement.y,
        minWidth: "208px",
        padding: "4px",
        borderRadius: "8px",
        border: "1px solid var(--color-border)",
        backgroundColor: "var(--color-bg)",
        boxShadow: "0 8px 24px rgba(0,0,0,0.18)",
        zIndex: 1200,
        color: "var(--color-text-primary)",
      }}
    >
      {items.map((item, index) => {
        const disabled = busy || item.disabled;
        return (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            disabled={disabled}
            data-testid={`folder-context-menu-${item.id}`}
            aria-label={item.label}
            title={item.label}
            onClick={() => {
              if (disabled) return;
              item.onSelect();
            }}
            onMouseEnter={() => setActiveIndex(index)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
              width: "100%",
              padding: "7px 8px",
              border: "none",
              borderRadius: "6px",
              backgroundColor: "transparent",
              color: item.destructive
                ? "var(--color-danger)"
                : "var(--color-text-primary)",
              cursor: disabled ? "default" : "pointer",
              opacity: disabled ? 0.45 : 1,
              fontSize: "12.5px",
              fontFamily: "inherit",
              textAlign: "left",
            }}
          >
            <span style={{ display: "inline-flex", flexShrink: 0, width: 14 }}>
              {busy && index === activeIndex ? <Loader size={14} className="spinner" /> : item.icon}
            </span>
            <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {item.label}
            </span>
            {/* The count is what makes "mark all as read" a decision rather than
                a leap: it says how much mail the press will clear. */}
            {item.badge != null && item.badge > 0 && (
              <span
                aria-hidden="true"
                style={{
                  flexShrink: 0,
                  minWidth: "18px",
                  height: "18px",
                  padding: "0 5px",
                  boxSizing: "border-box",
                  borderRadius: "9px",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: "color-mix(in srgb, var(--color-accent) 12%, transparent)",
                  color: "var(--color-accent)",
                  fontSize: "10.5px",
                  fontWeight: 600,
                  fontVariantNumeric: "tabular-nums",
                  lineHeight: 1,
                }}
              >
                {item.badge > 99 ? "99+" : item.badge}
              </span>
            )}
          </button>
        );
      })}
    </div>,
    document.body,
  );
}

/** The glyphs the folder menu uses, exported so the sidebar names them once. */
export const FOLDER_MENU_ICONS = {
  markAllRead: <MailOpen size={14} />,
  sync: <RefreshCw size={14} />,
  emptyTrash: <Trash2 size={14} />,
  emptySpam: <AlertTriangle size={14} />,
};
