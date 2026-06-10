// Right-click context menu template builder. Pure (no Electron runtime) so it's
// unit-testable; index.ts wires it to webContents 'context-menu' and pops the
// result. See test/contextMenu.test.ts.
import type { MenuItemConstructorOptions } from 'electron';

/** The subset of Electron's context-menu params we decide the menu from. */
export interface ContextMenuParams {
  isEditable: boolean;
  selectionText: string;
  editFlags: {
    canCut: boolean;
    canCopy: boolean;
    canPaste: boolean;
    canSelectAll: boolean;
  };
}

/**
 * Build the menu template from a context-menu hit-test: editable targets get
 * Cut/Paste, any non-empty text selection gets Copy, and either gets Select All.
 * Each item honors the reported editFlags (so e.g. Paste greys out with an empty
 * clipboard). Returns [] when nothing is actionable — a plain right-click on
 * non-editable, unselected content — so the caller can skip popping a menu.
 */
export function buildContextMenuTemplate(params: ContextMenuParams): MenuItemConstructorOptions[] {
  const { isEditable, editFlags } = params;
  const hasSelection = params.selectionText.trim().length > 0;
  const items: MenuItemConstructorOptions[] = [];
  if (isEditable) items.push({ role: 'cut', enabled: editFlags.canCut });
  if (isEditable || hasSelection) items.push({ role: 'copy', enabled: editFlags.canCopy });
  if (isEditable) items.push({ role: 'paste', enabled: editFlags.canPaste });
  if (isEditable || hasSelection) {
    items.push({ type: 'separator' }, { role: 'selectAll', enabled: editFlags.canSelectAll });
  }
  return items;
}
