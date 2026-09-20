import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  initReactI18next: {
    type: "3rdParty",
    init: vi.fn(),
  },
  useTranslation: () => ({
    // Interpolates, so a test asserts the label a screen reader actually gets
    // ("Move Work down") rather than the raw placeholder.
    t: (key: string, fallback?: string, options?: Record<string, unknown>) => {
      const text = fallback ?? key;
      if (!options) return text;
      return text.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(options[name] ?? ""));
    },
  }),
}));

vi.mock("../../src/hooks/queries", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/hooks/queries")>();
  return {
    ...actual,
    // The real account query stays in place: the optimistic cache write is what
    // has to repaint the list, so stubbing the hook would test nothing.
    useAccountUnreadCounts: () => ({}),
  };
});

vi.mock("../../src/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/api")>();
  return { ...actual, reorderAccounts: vi.fn() };
});

import AccountsTab from "../../src/features/settings/AccountsTab";
import { reorderAccounts } from "../../src/lib/api";
import { accountsQueryKey } from "../../src/hooks/queries";
import { useToastStore } from "../../src/stores/toast.store";
import type { Account } from "../../src/lib/api";

function account(id: string, label: string): Account {
  return {
    id,
    email: `${id}@example.com`,
    account_label: label,
    display_name: label,
    color: null,
    provider: "imap",
    created_at: 1,
    updated_at: 1,
  };
}

const WORK = account("work", "Work");
const PERSONAL = account("personal", "Personal");
const SCHOOL = account("school", "School");

function renderTab(accounts: Account[]) {
  const queryClient = new QueryClient({
    // Nothing should refetch behind the test's back: the order under test is
    // the one in the cache.
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  queryClient.setQueryData(accountsQueryKey, accounts);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return render(<AccountsTab />, { wrapper });
}

/** The addresses in the order the rows are painted. */
function renderedOrder(): string[] {
  return screen
    .getAllByText(/@example\.com$/)
    .map((element) => element.textContent ?? "");
}

function moveButton(accountLabel: string, direction: "up" | "down"): HTMLButtonElement {
  return screen.getByRole("button", {
    name: `Move ${accountLabel} ${direction}`,
  }) as HTMLButtonElement;
}

describe("AccountsTab account order", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useToastStore.setState({ toasts: [] });
  });

  it("lists accounts in the stored order and locks the arrows at the ends", () => {
    renderTab([WORK, PERSONAL, SCHOOL]);

    expect(renderedOrder()).toEqual([
      "work@example.com",
      "personal@example.com",
      "school@example.com",
    ]);

    expect(moveButton("Work", "up").disabled).toBe(true);
    expect(moveButton("Work", "down").disabled).toBe(false);
    expect(moveButton("School", "up").disabled).toBe(false);
    expect(moveButton("School", "down").disabled).toBe(true);
  });

  it("saves the whole list in the new order when a row moves down", async () => {
    renderTab([WORK, PERSONAL, SCHOOL]);

    fireEvent.click(moveButton("Work", "down"));

    // The row moves before the round trip finishes: a click is a direct
    // manipulation, and waiting for IPC reads as a stuck list.
    await waitFor(() =>
      expect(renderedOrder()).toEqual([
        "personal@example.com",
        "work@example.com",
        "school@example.com",
      ]),
    );
    expect(reorderAccounts).toHaveBeenCalledWith([
      "personal",
      "work",
      "school",
    ]);
  });

  it("moves a row up as well, not just down", async () => {
    renderTab([WORK, PERSONAL, SCHOOL]);

    fireEvent.click(moveButton("School", "up"));

    await waitFor(() =>
      expect(reorderAccounts).toHaveBeenCalledWith([
        "work",
        "school",
        "personal",
      ]),
    );
  });

  it("puts the old order back and reports it when the save fails", async () => {
    vi.mocked(reorderAccounts).mockRejectedValueOnce(new Error("disk is full"));
    renderTab([WORK, PERSONAL, SCHOOL]);

    fireEvent.click(moveButton("Work", "down"));

    await waitFor(() =>
      expect(renderedOrder()).toEqual([
        "work@example.com",
        "personal@example.com",
        "school@example.com",
      ]),
    );
    expect(useToastStore.getState().toasts).toHaveLength(1);
    expect(useToastStore.getState().toasts[0].type).toBe("error");
    expect(useToastStore.getState().toasts[0].message).toContain("disk is full");
  });
});
