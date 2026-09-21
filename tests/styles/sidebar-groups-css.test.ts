import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The mailbox column's geometry.
 *
 * These are the rules that make the sidebar read as one list of mailboxes with
 * folders nested under each, rather than three blocks stacked. They are pinned
 * as source because the numbers are the contract: a folder row and a mailbox
 * row have to put their labels on one left edge and their unread counts in one
 * trailing column, and nothing else in the suite would notice if a padding
 * changed by a few pixels and the columns drifted apart.
 */
function sidebarCss(): string {
  return readFileSync(join(process.cwd(), "src", "styles", "index.css"), "utf8");
}

describe("sidebar mailbox group CSS", () => {
  it("indents a folder under the mailbox it belongs to", () => {
    const css = sidebarCss();

    // The indent is spent on the leading edge only. The trailing edge keeps the
    // row's own 8px, which is what holds every count in one column.
    expect(css).toMatch(/\.sidebar-row--nested\s*\{[^}]*padding-left\s*:\s*30px/i);
    expect(css).not.toMatch(/\.sidebar-row--nested\s*\{[^}]*padding-right/i);
  });

  it("reserves the disclosure column whether or not a mailbox has folders", () => {
    const css = sidebarCss();

    // A spacer stands in for the triangle, so a mailbox whose first sync has not
    // finished still lines its avatar up with the ones that have folders.
    expect(css).toMatch(
      /\.sidebar-group-toggle,\s*\.sidebar-group-toggle-spacer\s*\{[^}]*width\s*:\s*18px/i,
    );
    expect(css).toMatch(
      /\.sidebar-group-toggle,\s*\.sidebar-group-toggle-spacer\s*\{[^}]*flex-shrink\s*:\s*0/i,
    );
  });

  it("gives the mailbox row the same trailing inset as a folder row", () => {
    const css = sidebarCss();

    // A folder row is its own button and spends 8px of its own padding on the
    // trailing edge; the mailbox row carries the surface instead, so it has to
    // spend the same 8px to land its count in the same column.
    expect(css).toMatch(/\.sidebar-account-row\s*\{[^}]*padding\s*:\s*0\s+8px\s+0\s+2px/i);
  });

  it("turns the disclosure triangle rather than swapping the glyph", () => {
    const css = sidebarCss();

    // One element that rotates keeps the row's width fixed while it opens and
    // closes, so the label beside it never shifts.
    expect(css).toMatch(/\.sidebar-group-chevron\s*\{[^}]*transition\s*:\s*transform/i);
    expect(css).toMatch(/\.sidebar-group-chevron\[data-open="true"\]\s*\{[^}]*transform\s*:\s*rotate\(90deg\)/i);
  });

  it("draws the nesting rule in the gutter the indent opens up", () => {
    const css = sidebarCss();

    // The hairline is what says the rows below belong to the mailbox above, and
    // it is absolutely positioned so it costs the rows no layout.
    expect(css).toMatch(/\.sidebar-group-children\s*\{[^}]*position\s*:\s*relative/i);
    expect(css).toMatch(/\.sidebar-group-children::before\s*\{[^}]*position\s*:\s*absolute/i);
    expect(css).toMatch(/\.sidebar-group-children::before\s*\{[^}]*width\s*:\s*1px/i);
  });

  it("centres every icon when the rail is folded away", () => {
    const css = sidebarCss();

    // Folded, the rail is a column of icons: the label gutters and the stable
    // scrollbar gutter all have to go, or a 60px rail pushes its own contents
    // off centre. The scrollbar is left to overlay instead.
    expect(css).toMatch(/\.sidebar--collapsed\s+\.sidebar-mailboxes\s*\{[^}]*padding\s*:\s*0\b/i);
    expect(css).toMatch(/\.sidebar--collapsed\s+\.sidebar-account-row\s*\{[^}]*padding\s*:\s*0\b/i);
    expect(css).toMatch(/\.sidebar--collapsed\s+\.sidebar-mail-scroll\s*\{[^}]*scrollbar-gutter\s*:\s*auto/i);
  });

  it("keeps the mailbox column as the only part that scrolls", () => {
    const css = sidebarCss();

    // The search field and the tools stay put while a long folder list moves
    // under them, which is what the column owning the leftover height buys.
    expect(css).toMatch(/\.sidebar-mail-scroll\s*\{[^}]*flex\s*:\s*1/i);
    expect(css).toMatch(/\.sidebar-mail-scroll\s*\{[^}]*overflow-y\s*:\s*auto/i);
  });
});
