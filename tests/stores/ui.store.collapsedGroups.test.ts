import { beforeEach, describe, expect, it } from "vitest";
import {
  COLLAPSED_ACCOUNT_GROUPS_KEY,
  readCollapsedAccountGroups,
  useUIStore,
} from "../../src/stores/ui.store";

/**
 * Which mailbox groups are folded shut.
 *
 * The preference is what keeps a folded column folded across a restart, so it
 * has to survive a value it did not write — a settings file that was edited, or
 * one written by an older release. The rule is that a group opens unless the
 * reader was told otherwise, because a collapsed group hides the folders that
 * are the reason it exists.
 */
describe("UIStore collapsed mailbox groups", () => {
  beforeEach(() => {
    localStorage.clear();
    useUIStore.setState({ collapsedAccountGroups: [] });
  });

  it("folds and unfolds one group at a time", () => {
    useUIStore.getState().toggleAccountGroup("account-work");
    expect(useUIStore.getState().collapsedAccountGroups).toEqual(["account-work"]);

    useUIStore.getState().toggleAccountGroup("account-personal");
    expect(useUIStore.getState().collapsedAccountGroups).toEqual([
      "account-work",
      "account-personal",
    ]);

    useUIStore.getState().toggleAccountGroup("account-work");
    expect(useUIStore.getState().collapsedAccountGroups).toEqual(["account-personal"]);
  });

  it("stores only the groups that are folded", () => {
    useUIStore.getState().toggleAccountGroup("account-work");

    // A list of the closed ones rather than a flag per account, so a mailbox
    // added later starts open instead of inheriting a default of "closed".
    expect(JSON.parse(localStorage.getItem(COLLAPSED_ACCOUNT_GROUPS_KEY) ?? "null")).toEqual([
      "account-work",
    ]);
  });

  it("opens every group on a fresh install", () => {
    expect(readCollapsedAccountGroups()).toEqual([]);
  });

  it("reads back the groups that were folded", () => {
    localStorage.setItem(COLLAPSED_ACCOUNT_GROUPS_KEY, JSON.stringify(["account-work"]));

    expect(readCollapsedAccountGroups()).toEqual(["account-work"]);
  });

  it("opens every group when the stored value cannot be read", () => {
    // A damaged preference must not be able to leave a mailbox unreachable, so
    // anything unreadable means "nothing is folded" rather than a repair.
    for (const stored of ["not json", "{}", "null", '{"account-work":true}']) {
      localStorage.setItem(COLLAPSED_ACCOUNT_GROUPS_KEY, stored);
      expect(readCollapsedAccountGroups()).toEqual([]);
    }
  });

  it("ignores entries that are not usable account ids", () => {
    localStorage.setItem(
      COLLAPSED_ACCOUNT_GROUPS_KEY,
      JSON.stringify(["account-work", 7, null, ""]),
    );

    expect(readCollapsedAccountGroups()).toEqual(["account-work"]);
  });
});
