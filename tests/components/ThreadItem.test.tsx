import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ThreadSummary } from "../../src/lib/api";
import ThreadItem from "../../src/components/ThreadItem";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}));

function makeThread(overrides: Partial<ThreadSummary> = {}): ThreadSummary {
  return {
    thread_id: "thread-1",
    account_id: "account-1",
    subject: "Thread subject",
    snippet: "Thread snippet",
    last_date: 1_700_000_000,
    message_count: 2,
    unread_count: 0,
    is_starred: false,
    participants: ["Sender"],
    has_attachments: false,
    ...overrides,
  };
}

describe("ThreadItem", () => {
  it("marks unread rows with a row class", () => {
    render(
      <ThreadItem
        thread={makeThread({ unread_count: 2 })}
        isSelected={false}
        onClick={vi.fn()}
      />,
    );

    expect(screen.getByRole("option").className).toContain("thread-list-row--unread");
  });

  it("does not add unread row treatment when every thread message is read", () => {
    render(
      <ThreadItem
        thread={makeThread({ unread_count: 0 })}
        isSelected={false}
        onClick={vi.fn()}
      />,
    );

    expect(screen.getByRole("option").className).not.toContain("thread-list-row--unread");
  });

  it("says how much of an unread thread is waiting", () => {
    render(
      <ThreadItem
        thread={makeThread({ unread_count: 3 })}
        isSelected={false}
        onClick={vi.fn()}
      />,
    );

    const count = screen.getByRole("option").querySelector(".thread-row-unread-count") as HTMLElement;

    // A dot says "something is unread"; the count says whether opening the
    // thread is worth the interruption.
    expect(count.textContent).toBe("3");
    expect(count.getAttribute("aria-hidden")).toBe("true");
  });

  it("caps the unread count so the badge keeps its width", () => {
    render(
      <ThreadItem
        thread={makeThread({ unread_count: 128 })}
        isSelected={false}
        onClick={vi.fn()}
      />,
    );

    expect(
      (screen.getByRole("option").querySelector(".thread-row-unread-count") as HTMLElement).textContent,
    ).toBe("99+");
  });

  it("shows no unread count on a fully read thread", () => {
    render(
      <ThreadItem
        thread={makeThread({ unread_count: 0 })}
        isSelected={false}
        onClick={vi.fn()}
      />,
    );

    const row = screen.getByRole("option");

    expect(row.querySelector(".thread-row-unread-count")).toBeNull();
    expect(row.querySelector(".thread-row-unread-dot")).toBeNull();
  });

  it("carries the classes that let read threads recede behind unread ones", () => {
    render(
      <ThreadItem
        thread={makeThread({ unread_count: 2 })}
        isSelected={false}
        onClick={vi.fn()}
      />,
    );

    const row = screen.getByRole("option");
    const dot = row.querySelector(".thread-row-unread-dot");

    expect(row.querySelector(".thread-row-participants")).toBeTruthy();
    expect(row.querySelector(".thread-row-subject")).toBeTruthy();
    expect(row.querySelector(".thread-row-date")).toBeTruthy();
    // The marker sits in the row's gutter, pinned to the head.
    expect(dot?.parentElement?.className).toContain("thread-row-head");
  });

  it("names the source mailbox when the combined inbox supplies a badge", () => {
    render(
      <ThreadItem
        thread={makeThread()}
        isSelected={false}
        onClick={vi.fn()}
        accountBadge={{ color: "#0ea5e9", label: "Personal", title: "Personal · me@example.com" }}
      />,
    );

    const badge = screen.getByTestId("account-badge");

    expect(badge.textContent).toBe("Personal");
    expect(badge.getAttribute("title")).toBe("Personal · me@example.com");
    expect(screen.getByTestId("account-badge-dot").style.backgroundColor).toBe("rgb(14, 165, 233)");
  });

  it("leaves a thread from a single mailbox unlabelled", () => {
    render(
      <ThreadItem
        thread={makeThread()}
        isSelected={false}
        onClick={vi.fn()}
      />,
    );

    expect(screen.queryByTestId("account-badge")).toBeNull();
    expect(screen.queryByTestId("account-color-bar")).toBeNull();
  });
});
