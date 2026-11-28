import type { AvatarShape } from '../types';

export interface AvatarShapeDef {
  id: AvatarShape;
  label: string;
  /** Rounded shapes use border-radius; the rest are clipped. */
  radius?: string;
  clip?: string;
}

export const AVATAR_SHAPES: AvatarShapeDef[] = [
  { id: 'circle', label: 'Circle', radius: '50%' },
  { id: 'squircle', label: 'Squircle', radius: '32%' },
  { id: 'rounded', label: 'Rounded square', radius: '18%' },
  { id: 'hexagon', label: 'Hexagon', clip: 'polygon(25% 4%, 75% 4%, 100% 50%, 75% 96%, 25% 96%, 0 50%)' },
  { id: 'diamond', label: 'Diamond', clip: 'polygon(50% 0, 100% 50%, 50% 100%, 0 50%)' },
  { id: 'octagon', label: 'Octagon', clip: 'polygon(30% 0, 70% 0, 100% 30%, 100% 70%, 70% 100%, 30% 100%, 0 70%, 0 30%)' },
  { id: 'shield', label: 'Shield', clip: 'polygon(0 0, 100% 0, 100% 62%, 50% 100%, 0 62%)' },
  { id: 'leaf', label: 'Leaf', radius: '0 50% 0 50%' },
];

export const shapeDef = (id: AvatarShape | undefined): AvatarShapeDef =>
  AVATAR_SHAPES.find((s) => s.id === id) ?? AVATAR_SHAPES[0];

/** 24 colours: the original ten first, then a wider spread. */
export const WIDE_ACCENTS = [
  '#7c9cff', '#5fd4a4', '#f0a4c8', '#f5c56b', '#a78bfa',
  '#4fd1c5', '#fb923c', '#f87171', '#60a5fa', '#c084fc',
  '#34d399', '#fbbf24', '#f472b6', '#38bdf8', '#a3e635',
  '#e879f9', '#fb7185', '#2dd4bf', '#facc15', '#818cf8',
  '#f97316', '#22d3ee', '#94a3b8', '#d4a373',
];

export const WIDE_EMOJIS = [
  '🔭', '🛠️', '🎨', '📝', '🧠', '⚡', '🛰️', '🧪', '📊', '🦉',
  '🐙', '🌱', '🔮', '🧭', '🎯', '💬', '🧩', '🚀', '🕵️', '📚',
  '🦊', '🐝', '🦋', '🐺', '🦄', '🐳', '🌋', '🌊', '🔥', '❄️',
  '🍀', '🌸', '🎲', '🎧', '🔑', '⚙️', '🧲', '💡', '📡', '🛡️',
  '🏗️', '🔍', '🐞', '🌐', '📦', '🪐', '🗺️', '🧵',
];
