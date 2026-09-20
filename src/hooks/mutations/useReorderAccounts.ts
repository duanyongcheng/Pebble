import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { reorderAccounts } from "@/lib/api";
import type { Account } from "@/lib/api";
import { accountsQueryKey } from "@/hooks/queries";
import { extractErrorMessage } from "@/lib/extractErrorMessage";
import { useToastStore } from "@/stores/toast.store";

/**
 * Save a new account order, painting it before the round trip.
 *
 * Both places that reorder accounts — the arrows in Settings and dragging a row
 * in the sidebar — go through here so they cannot disagree about what a failed
 * save does: the previous order comes back and the reason is reported. A row
 * that waits for IPC before moving reads as unresponsive, so the new order is
 * written to the cache first and only a rejection undoes it.
 *
 * `isReordering` is true while a write is in flight. Callers lock their own
 * control with it, because two overlapping writes could land out of order and
 * leave the list disagreeing with the backend.
 */
export function useReorderAccounts() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const [isReordering, setIsReordering] = useState(false);

  const reorder = useCallback(
    async (next: Account[]) => {
      const previous = queryClient.getQueryData<Account[]>(accountsQueryKey);

      setIsReordering(true);
      queryClient.setQueryData(accountsQueryKey, next);
      try {
        await reorderAccounts(next.map((account) => account.id));
      } catch (err) {
        if (previous) {
          queryClient.setQueryData(accountsQueryKey, previous);
        }
        useToastStore.getState().addToast({
          message: t(
            "common.accountOrderSaveFailed",
            "Failed to save the account order: {{error}}",
            { error: extractErrorMessage(err) },
          ),
          type: "error",
        });
      } finally {
        setIsReordering(false);
      }
    },
    [queryClient, t],
  );

  return { reorder, isReordering };
}
