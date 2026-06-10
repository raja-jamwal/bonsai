// Unit tests for buildContextMenuTemplate — the right-click menu the main
// process pops from a webContents context-menu hit-test. Pure function; no
// Electron runtime (the MenuItemConstructorOptions import is type-only).
import { describe, it, expect } from 'vitest';
import { buildContextMenuTemplate, type ContextMenuParams } from '../src/main/contextMenu';

const flags = (over: Partial<ContextMenuParams['editFlags']> = {}) => ({
  canCut: true,
  canCopy: true,
  canPaste: true,
  canSelectAll: true,
  ...over,
});
const roles = (items: ReturnType<typeof buildContextMenuTemplate>) =>
  items.map((i) => i.role ?? i.type);

describe('buildContextMenuTemplate', () => {
  it('editable field with a selection → cut, copy, paste, separator, select-all', () => {
    const items = buildContextMenuTemplate({
      isEditable: true,
      selectionText: 'hi',
      editFlags: flags(),
    });
    expect(roles(items)).toEqual(['cut', 'copy', 'paste', 'separator', 'selectAll']);
  });

  it('editable field with NO selection still offers cut/copy/paste/select-all', () => {
    // editFlags drive enablement (cut/copy grey out), but the items are present
    // so paste is always reachable in an input.
    const items = buildContextMenuTemplate({
      isEditable: true,
      selectionText: '',
      editFlags: flags({ canCut: false, canCopy: false }),
    });
    expect(roles(items)).toEqual(['cut', 'copy', 'paste', 'separator', 'selectAll']);
    expect(items[0]).toMatchObject({ role: 'cut', enabled: false });
    expect(items[2]).toMatchObject({ role: 'paste', enabled: true });
  });

  it('non-editable WITH a selection → copy + select-all only (no cut/paste)', () => {
    const items = buildContextMenuTemplate({
      isEditable: false,
      selectionText: 'some selected text',
      editFlags: flags(),
    });
    expect(roles(items)).toEqual(['copy', 'separator', 'selectAll']);
  });

  it('non-editable with NO selection → empty (caller skips popping a menu)', () => {
    const items = buildContextMenuTemplate({
      isEditable: false,
      selectionText: '',
      editFlags: flags(),
    });
    expect(items).toEqual([]);
  });

  it('a whitespace-only selection counts as no selection', () => {
    const items = buildContextMenuTemplate({
      isEditable: false,
      selectionText: '   \n\t ',
      editFlags: flags(),
    });
    expect(items).toEqual([]);
  });

  it('propagates editFlags onto each role (e.g. paste disabled on empty clipboard)', () => {
    const items = buildContextMenuTemplate({
      isEditable: true,
      selectionText: 'x',
      editFlags: flags({ canPaste: false, canSelectAll: false }),
    });
    expect(items.find((i) => i.role === 'paste')).toMatchObject({ enabled: false });
    expect(items.find((i) => i.role === 'selectAll')).toMatchObject({ enabled: false });
  });
});
