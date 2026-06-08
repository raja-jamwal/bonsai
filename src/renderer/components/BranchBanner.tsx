// BranchBanner.tsx — handoff component 5 (branch context banner).
//
// A coral pill at the top of the message stream announcing the current branch
// context. Informational only (reminds the user what they're replying into).
// Uses --brand-tint bg + --fork-ink text (the .branch-banner class).
//
//   [Branch] You're on <leaf> — depth N        forked from <parent fork> · …
//
// depth = activePath length. "forked from" names the nearest ancestor fork
// point (a path node with >1 child) above the leaf, mirroring the design copy.
import { useStore } from '../state/store';
import { Icon } from './Icon';
import type { MessageNode } from '@shared/types';

function shortLabel(node: MessageNode | undefined, fallback: string): string {
  if (!node) return fallback;
  if (node.title && node.title.trim()) {
    const t = node.title.trim();
    return t.length > 28 ? `${t.slice(0, 28)}…` : t;
  }
  const text = node.content.trim().replace(/\s+/g, ' ');
  if (!text) return fallback;
  return text.length > 28 ? `${text.slice(0, 28)}…` : text;
}

export function BranchBanner() {
  const store = useStore();
  const path = store.activePath();
  if (path.length === 0) return null;

  // Indices of fork points along the path (a node with >1 child, excluding leaf).
  const forkIdxs: number[] = [];
  path.forEach((n, i) => {
    if (i < path.length - 1 && store.childrenOf(n.id).length > 1) forkIdxs.push(i);
  });

  // No fork on the path => a plain linear conversation; no branch to announce.
  if (forkIdxs.length === 0) return null;

  const lastFork = forkIdxs[forkIdxs.length - 1];
  // The node where the path actually diverges (the last shared ancestor).
  const forkNode = path[lastFork];
  const currentHead = path[lastFork + 1];

  return (
    <div className="branch-banner">
      <span className="banner-label">
        <Icon name="git-branch" size={11} /> Branch
      </span>
      <span>
        You're on <strong>{shortLabel(currentHead, 'this branch')}</strong> — depth{' '}
        {forkIdxs.length}
      </span>
      <span className="banner-meta">
        branched after {shortLabel(forkNode, 'fork point')}
      </span>
    </div>
  );
}
