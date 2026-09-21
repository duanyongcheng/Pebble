import { useMutation, useQueryClient } from "@tanstack/react-query";
import { updateMessageFlags } from "@/lib/api";
import type { Message } from "@/lib/api";
import {
  invalidateUnreadViews,
  patchMessagesCache,
  snapshotMessagesCache,
  restoreMessagesCache,
} from "@/hooks/queries";

interface UpdateFlagsParams {
  messageId: string;
  isRead?: boolean;
  isStarred?: boolean;
}

interface MutationContext {
  previousMessage: Message | null | undefined;
  previousLists: ReturnType<typeof snapshotMessagesCache>;
}

export function useUpdateFlagsMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (params: UpdateFlagsParams) =>
      updateMessageFlags(params.messageId, params.isRead, params.isStarred),
    onMutate: async (params): Promise<MutationContext> => {
      await queryClient.cancelQueries({ queryKey: ["messages"] });
      await queryClient.cancelQueries({
        queryKey: ["message", params.messageId],
      });

      const previousMessage = queryClient.getQueryData<Message | null>([
        "message",
        params.messageId,
      ]);

      const previousLists = snapshotMessagesCache(queryClient);

      if (previousMessage) {
        queryClient.setQueryData<Message | null>(
          ["message", params.messageId],
          {
            ...previousMessage,
            ...(params.isRead !== undefined && { is_read: params.isRead }),
            ...(params.isStarred !== undefined && {
              is_starred: params.isStarred,
            }),
          },
        );
      }

      patchMessagesCache(queryClient, (page) =>
        page.map((m) =>
          m.id === params.messageId
            ? {
                ...m,
                ...(params.isRead !== undefined && { is_read: params.isRead }),
                ...(params.isStarred !== undefined && { is_starred: params.isStarred }),
              }
            : m,
        ),
      );

      return { previousMessage, previousLists };
    },
    onError: (_err, params, context) => {
      if (context?.previousMessage) {
        queryClient.setQueryData(
          ["message", params.messageId],
          context.previousMessage,
        );
      }
      if (context?.previousLists) {
        restoreMessagesCache(queryClient, context.previousLists);
      }
    },
    onSettled: (_data, err, params) => {
      queryClient.invalidateQueries({ queryKey: ["message", params.messageId] });

      // A read-state change moves a message in or out of both unread surfaces:
      // the folder rows and the sidebar's per-mailbox badge. They are separate
      // queries with their own 30s polls, and refreshing only the folder rows
      // leaves the badge showing the old number until its poll happens to fire —
      // which reads as "no folder has unread mail, but the mailbox still does".
      // Opening a message is the commonest way to mark mail read, so this is
      // where that window is most visible.
      if (!err && params.isRead !== undefined) {
        invalidateUnreadViews(queryClient);
        return;
      }

      // Starring and a failed read change move no unread mail.
      queryClient.invalidateQueries({ queryKey: ["messages"] });
      queryClient.invalidateQueries({ queryKey: ["threads"] });
      queryClient.invalidateQueries({ queryKey: ["starred-messages"] });
    },
  });
}
