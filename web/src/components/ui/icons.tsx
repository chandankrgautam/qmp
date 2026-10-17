import { BrickWall, DoorClosed, Droplet, MoreHorizontal, PaintRoller, Waves, Zap, type LucideIcon } from 'lucide-react';

/* One icon per category, always the same one (DESIGN_SYSTEM.md §7). */
export function categoryIcon(name = ''): LucideIcon {
  const n = name.toLowerCase();
  if (n.startsWith('water')) return Droplet;
  if (n.startsWith('sanitary')) return Waves;
  if (n.startsWith('structure')) return BrickWall;
  if (n.startsWith('carpentry')) return DoorClosed;
  if (n.startsWith('finishing')) return PaintRoller;
  if (n.startsWith('electrical')) return Zap;
  return MoreHorizontal;
}
