// Icon.tsx — a tiny generic wrapper around lucide-react.
//
// The design handoff "Assets" section lists the exact lucide glyphs used across
// the branched-conversation pane; we import only those and expose a single
// <Icon name=.. size=.. /> component so the rest of the UI never imports lucide
// directly (keeps the icon set auditable in one place).
import {
  GitBranch,
  MessageSquare,
  Circle,
  ChevronDown,
  ChevronRight,
  CornerDownRight,
  Plus,
  Pencil,
  MoreHorizontal,
  PanelRight,
  Search,
  SquarePen,
  SlidersHorizontal,
  GitCompare,
  Copy,
  ThumbsUp,
  ThumbsDown,
  Hand,
  Mic,
  Folder,
  FolderPlus,
  ChevronsRight,
  X,
  Trash2,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

/** The set of icon names the UI may reference (handoff "Assets"). */
export type IconName =
  | 'git-branch'
  | 'message-square'
  | 'circle'
  | 'chevron-down'
  | 'chevron-right'
  | 'corner-down-right'
  | 'plus'
  | 'pencil'
  | 'more-horizontal'
  | 'panel-right'
  | 'search'
  | 'square-pen'
  | 'sliders-horizontal'
  | 'git-compare'
  | 'copy'
  | 'thumbs-up'
  | 'thumbs-down'
  | 'hand'
  | 'mic'
  | 'folder'
  | 'folder-plus'
  | 'chevrons-right'
  | 'x'
  | 'trash-2';

// Map kebab-case design names -> the imported lucide components.
const REGISTRY: Record<IconName, LucideIcon> = {
  'git-branch': GitBranch,
  'message-square': MessageSquare,
  circle: Circle,
  'chevron-down': ChevronDown,
  'chevron-right': ChevronRight,
  'corner-down-right': CornerDownRight,
  plus: Plus,
  pencil: Pencil,
  'more-horizontal': MoreHorizontal,
  'panel-right': PanelRight,
  search: Search,
  'square-pen': SquarePen,
  'sliders-horizontal': SlidersHorizontal,
  'git-compare': GitCompare,
  copy: Copy,
  'thumbs-up': ThumbsUp,
  'thumbs-down': ThumbsDown,
  hand: Hand,
  mic: Mic,
  folder: Folder,
  'folder-plus': FolderPlus,
  'chevrons-right': ChevronsRight,
  x: X,
  'trash-2': Trash2,
};

export interface IconProps {
  name: IconName;
  /** Pixel size (width == height). Defaults to 14px, the handoff chrome size. */
  size?: number;
  /** Optional class for color/positioning overrides. */
  className?: string;
  /** Stroke width override (lucide default is 2). */
  strokeWidth?: number;
}

/** Generic icon. `currentColor` so CSS color rules drive the glyph color. */
export function Icon({ name, size = 14, className, strokeWidth }: IconProps) {
  const Glyph = REGISTRY[name];
  return <Glyph size={size} className={className} strokeWidth={strokeWidth} aria-hidden />;
}
