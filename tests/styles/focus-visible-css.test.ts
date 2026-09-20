import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("focus-visible CSS", () => {
  it("does not suppress the Tiptap editor focus outline", () => {
    const css = readFileSync(join(process.cwd(), "src", "styles", "index.css"), "utf8");

    expect(css).not.toMatch(/\.tiptap\s*\{[^}]*outline\s*:\s*none/i);
    expect(css).not.toMatch(/\.tiptap:focus\s*\{[^}]*outline\s*:\s*none/i);
  });

  it("uses a custom themed checkbox for batch selection", () => {
    const css = readFileSync(join(process.cwd(), "src", "styles", "index.css"), "utf8");

    expect(css).toMatch(/\.batch-checkbox\s*\{[^}]*appearance\s*:\s*none/i);
    expect(css).toMatch(/\.batch-checkbox:checked\s*\{[^}]*background\s*:\s*var\(--color-accent\)/i);
    expect(css).toMatch(/\.batch-checkbox::before\s*\{[^}]*border-left\s*:/i);
  });

  it("keeps native form controls aligned with the app theme", () => {
    const css = readFileSync(join(process.cwd(), "src", "styles", "index.css"), "utf8");

    expect(css).toMatch(/input,\s*textarea,\s*select,\s*option\s*\{[^}]*color-scheme\s*:\s*light/i);
    expect(css).not.toMatch(/input,\s*textarea,\s*select,\s*option\s*\{[^}]*color-scheme\s*:\s*light dark/i);
    expect(css).toMatch(/input\[type="checkbox"\],\s*input\[type="radio"\]\s*\{[^}]*accent-color\s*:\s*var\(--color-accent\)/i);
    expect(css).toMatch(/\[data-theme="dark"\]\s*input,\s*\[data-theme="dark"\]\s*textarea,\s*\[data-theme="dark"\]\s*select,\s*\[data-theme="dark"\]\s*option\s*\{[^}]*color-scheme\s*:\s*dark/i);
    expect(css).toMatch(/\[data-theme="dark"\]\s*select,\s*\[data-theme="dark"\]\s*option\s*\{[^}]*background-color\s*:\s*var\(--color-bg\)/i);
    expect(css).toMatch(/\[data-theme="dark"\]\s*select,\s*\[data-theme="dark"\]\s*option\s*\{[^}]*color\s*:\s*var\(--color-text-primary\)/i);
    expect(css).toMatch(/\[data-theme="dark"\]\s*input\[type="date"\]::-webkit-calendar-picker-indicator\s*\{[^}]*filter\s*:\s*invert\(1\)/i);
  });

  it("makes unread message and thread rows visually distinct in dark mode", () => {
    const css = readFileSync(join(process.cwd(), "src", "styles", "index.css"), "utf8");

    expect(css).toMatch(/\.message-list-row--unread\[aria-selected="false"\]:hover/i);
  });

  it("gives unread rows a wash, a gutter marker and a stronger date", () => {
    const css = readFileSync(join(process.cwd(), "src", "styles", "index.css"), "utf8");

    // The wash is what separates an unread row from a read one at a glance, and
    // it has to be answered in dark mode rather than left to a light tint.
    expect(css).toMatch(
      /\.message-list-row--unread\[aria-selected="false"\],\s*\.thread-list-row--unread\[aria-selected="false"\]\s*\{[^}]*background:\s*color-mix\(in srgb, var\(--color-accent\)/i,
    );
    expect(css).toMatch(
      /\[data-theme="dark"\]\s*\.message-list-row--unread\[aria-selected="false"\],\s*\[data-theme="dark"\]\s*\.thread-list-row--unread\[aria-selected="false"\]\s*\{[^}]*background:\s*color-mix/i,
    );
    // Scoped to the unselected row on purpose: unscoped, the dark-mode wash
    // would tie with the selection rule on specificity and win by source order,
    // so a selected unread row would lose its selection fill.
    expect(css).not.toMatch(/^\.message-list-row--unread,\s*$/m);
    expect(css).not.toMatch(/^\[data-theme="dark"\]\s*\.message-list-row--unread,\s*$/m);

    // The marker is positioned into the row's padding, so it costs no layout and
    // forms a column at a fixed x down the list.
    expect(css).toMatch(/\.message-row-unread-dot,\s*\.thread-row-unread-dot\s*\{[^}]*position:\s*absolute/i);
    expect(css).toMatch(/\.message-row-unread-dot,\s*\.thread-row-unread-dot\s*\{[^}]*left:\s*-\d+px/i);
    expect(css).toMatch(/\.message-row-head,\s*\.thread-row-head\s*\{[^}]*position:\s*relative/i);

    // Read mail steps back so unread mail can step forward.
    expect(css).toMatch(
      /\.message-row-sender-name,\s*\.message-row-subject[^{]*\{[^}]*color:\s*var\(--color-text-secondary\)/i,
    );
    expect(css).toMatch(
      /\.message-list-row--unread\s*\.message-row-sender-name[^{]*\{[^}]*color:\s*var\(--color-text-primary\)/i,
    );

    // Hover deepens the wash instead of replacing it, so an unread row stays
    // visibly unread under the pointer.
    expect(css).toMatch(
      /\.message-list-row--unread\[aria-selected="false"\]:hover[^{]*\{[^}]*background:\s*color-mix\(in srgb, var\(--color-accent\)/i,
    );
  });
});
