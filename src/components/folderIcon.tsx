import {
  Inbox,
  Send,
  FileEdit,
  Trash2,
  Archive,
  AlertTriangle,
  Folder,
  type LucideIcon,
} from "lucide-react";
import type { Folder as FolderType } from "../lib/api";
import { folderLeafName } from "../lib/folderAggregation";

/**
 * The glyph a folder wears, chosen by the role the provider assigned it.
 *
 * A custom folder has no role and falls back to the generic folder. Shared by
 * the sidebar's account groups and by anything else that lists a folder, so a
 * mailbox's Inbox cannot end up with one icon in the sidebar and another
 * somewhere else.
 */
const ROLE_ICONS: Record<string, LucideIcon> = {
  inbox: Inbox,
  sent: Send,
  drafts: FileEdit,
  trash: Trash2,
  archive: Archive,
  spam: AlertTriangle,
};

export function folderIcon(role: FolderType["role"], size: number): React.ReactNode {
  const Icon = (role && ROLE_ICONS[role]) || Folder;
  return <Icon size={size} />;
}

/**
 * The translated name for a system folder, or the folder's own last segment for
 * a custom one.
 *
 * Providers name system folders in their own language and often in their own
 * spelling (`[Gmail]/All Mail`), so a role is what gets translated. A custom
 * folder keeps the name its owner gave it, shortened to the segment that names
 * it: a nested folder is stored as its whole path (`Work/Reports`) and a row
 * that says `Reports` is the one a reader recognises. The full path stays on
 * the folder itself and is what the row offers as its tooltip.
 */
export function folderLabel(
  folder: FolderType,
  roleLabels: Record<string, string>,
): string {
  return (folder.role && roleLabels[folder.role]) || folderLeafName(folder.name);
}
