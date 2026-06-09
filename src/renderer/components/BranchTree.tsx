// BranchTree.tsx — handoff component 2 ("smart-collapse" branch tree), matched
// to the canonical mock (Branching Conversations v2).
//
// Model mapping (engine MessageNode tree -> design "branches"):
//   • A "branch" (segment) is a maximal run of nodes joined by single-child
//     links — a linear stretch with no forking.
//   • The recents row IS the root; the tree below shows the root branch's
//     CONTENTS directly (no separate root row), exactly like the mock which
//     opens with "+ 3 replies on root" then the first sub-branch.
//   • Within any branch: its linear replies collapse to a "+ N replies" stub,
//     and the branches that diverge at its end-fork render nested one level
//     deeper (git-branch rows). Off-path sibling branches collapse to a
//     "+ N sibling forks" stub. The active branch row is solid coral.
//   • Guide-line color: brand under the active path, brand-tint-2 under a fork.
import { useStore } from '../state/store';
import { Icon } from './Icon';
import type { IconName } from './Icon';
import type { MessageNode } from '@shared/types';

export function BranchTree() {
  const store = useStore();
  const { nodes, isOnPath, activeLeafId, childrenOf, expandedNodes } = store;

  const roots = childrenOf(null);
  if (nodes.length === 0 || roots.length === 0) return null;
  const root = roots[0];

  /** Walk a linear run from `head` following single-child links. */
  function walkSegment(head: MessageNode): { seg: MessageNode[]; end: MessageNode } {
    const seg: MessageNode[] = [head];
    const seen = new Set<string>([head.id]);
    let cur = head;
    let kids = childrenOf(cur.id);
    while (kids.length === 1 && !seen.has(kids[0].id)) {
      cur = kids[0];
      seen.add(cur.id);
      seg.push(cur);
      kids = childrenOf(cur.id);
    }
    return { seg, end: cur };
  }

  function branchLabel(seg: MessageNode[]): string {
    // Prefer the auto-generated branch title (on the head node), else derive
    // from the first user message.
    const head = seg[0];
    if (head.title && head.title.trim()) return head.title.trim();
    const firstUser = seg.find((n) => n.role === 'user') ?? head;
    const text = firstUser.content.trim().replace(/\s+/g, ' ');
    if (!text) return firstUser.role === 'assistant' ? 'Reply' : 'Branch';
    return text.length > 34 ? `${text.slice(0, 34)}…` : text;
  }

  function rowIcon(isFork: boolean): IconName {
    return isFork ? 'git-branch' : 'circle';
  }

  function switchToBranch(head: MessageNode): void {
    void store.switchLeaf(store.deepestLeaf(head.id));
  }

  /** A "+ N replies" stub for the linear messages inside a segment. */
  function repliesStub(seg: MessageNode[], head: MessageNode, onRoot: boolean): React.ReactNode {
    const n = seg.length - 1;
    if (n <= 0) return null;
    const word = n === 1 ? 'reply' : 'replies';
    return (
      <button
        key={`replies:${head.id}`}
        type="button"
        className="stub"
        onClick={() => switchToBranch(head)}
      >
        <span className="stub-dot" />
        {`+ ${n} ${word}${onRoot ? ' on root' : ''}`}
      </button>
    );
  }

  /** Render the branches diverging at a fork, with smart-collapse. */
  function renderForkChildren(kids: MessageNode[]): React.ReactNode[] {
    const shown: MessageNode[] = [];
    const collapsed: MessageNode[] = [];
    for (const k of kids) {
      if (isOnPath(k.id) || expandedNodes.has(k.id)) shown.push(k);
      else collapsed.push(k);
    }
    const out: React.ReactNode[] = shown.map((k) => renderBranch(k));
    if (collapsed.length > 0) {
      out.push(
        <button
          key={`siblings:${kids[0].id}`}
          type="button"
          className="stub"
          onClick={() => {
            for (const c of collapsed) store.toggleExpand(c.id);
          }}
        >
          <span className="stub-dot" />
          {`+ ${collapsed.length} sibling ${collapsed.length === 1 ? 'fork' : 'forks'}`}
        </button>
      );
    }
    return out;
  }

  /** Render the CONTENTS of a branch (replies stub + diverging branches). */
  function renderContents(
    head: MessageNode,
    isRoot: boolean
  ): { repliesNode: React.ReactNode; childNodes: React.ReactNode[]; hasAny: boolean } {
    const { seg, end } = walkSegment(head);
    const kids = childrenOf(end.id);
    const repliesNode = repliesStub(seg, head, isRoot);
    const childNodes = kids.length > 1 ? renderForkChildren(kids) : [];
    return { repliesNode, childNodes, hasAny: !!repliesNode || childNodes.length > 0 };
  }

  /** Render one branch: its row plus (when expanded) its nested contents. */
  function renderBranch(head: MessageNode): React.ReactNode {
    const { seg, end } = walkSegment(head);
    const isFork = childrenOf(end.id).length > 1;
    const onPath = isOnPath(head.id);
    const containsLeaf = seg.some((n) => n.id === activeLeafId);
    const expanded = onPath || expandedNodes.has(head.id);
    const { repliesNode, childNodes, hasAny } = renderContents(head, false);
    const canExpand = hasAny;

    return (
      <div key={head.id}>
        <button
          type="button"
          className={[
            'tree-row',
            onPath ? 'on-path' : '',
            containsLeaf ? 'active' : '',
            isFork ? 'is-fork' : '',
            canExpand && !expanded ? 'collapsed' : '',
          ]
            .filter(Boolean)
            .join(' ')}
          onClick={() => switchToBranch(head)}
        >
          {canExpand ? (
            <span
              className="twist"
              role="button"
              tabIndex={-1}
              onClick={(e) => {
                e.stopPropagation();
                store.toggleExpand(head.id);
              }}
            >
              <Icon name="chevron-down" size={11} />
            </span>
          ) : (
            <span style={{ width: 11, flex: '0 0 11px' }} />
          )}
          <span className="tree-icon">
            <Icon name={rowIcon(isFork)} size={isFork ? 12 : 6} />
          </span>
          <span className="tree-title">{branchLabel(seg)}</span>
          {containsLeaf ? <span className="when">now</span> : null}
        </button>

        {canExpand && expanded ? (
          <div className={['branch-children', onPath ? 'on-path' : 'fork-edge'].join(' ')}>
            {repliesNode}
            {childNodes}
          </div>
        ) : null}
      </div>
    );
  }

  // Root level: with a single root, render its contents directly (no root row).
  // With multiple roots (forking the very first exchange creates a second root),
  // render each root as its own top-level branch.
  const single = roots.length === 1 ? renderContents(root, true) : null;

  return (
    <div className="branch-tree guide-active">
      {single ? (
        <>
          {single.repliesNode}
          {single.childNodes}
        </>
      ) : (
        roots.map((r) => renderBranch(r))
      )}

      {/* Pending (unsent) draft branch from "Fork from here". */}
      {store.fork ? (
        <div className="tree-row active draft">
          <span style={{ width: 11, flex: '0 0 11px' }} />
          <span className="tree-icon">
            <Icon name="git-branch" size={12} />
          </span>
          <span className="tree-title">New branch (unsent)</span>
        </div>
      ) : null}

      <div className="branch-tree-foot">
        <button
          type="button"
          onClick={() => {
            if (activeLeafId) void store.forkFrom(activeLeafId);
          }}
          disabled={!activeLeafId}
        >
          <Icon name="plus" size={11} />
          Fork from latest reply
        </button>
      </div>
    </div>
  );
}
