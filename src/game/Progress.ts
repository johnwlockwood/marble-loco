const KEY = 'marble-loco.progress.v1';

export interface Progress {
  /** Index of the highest level the player may start. */
  unlocked: number;
  /** Best time per level id, in seconds. */
  bests: Record<number, number>;
}

const DEFAULT: Progress = { unlocked: 0, bests: {} };

export function loadProgress(): Progress {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT, bests: {} };

    const parsed = JSON.parse(raw) as Partial<Progress>;
    return {
      unlocked: Number.isFinite(parsed.unlocked) ? Math.max(0, parsed.unlocked as number) : 0,
      bests: parsed.bests && typeof parsed.bests === 'object' ? parsed.bests : {},
    };
  } catch {
    // Private browsing, cleared storage, corrupt JSON -- all mean "start over".
    return { ...DEFAULT, bests: {} };
  }
}

export function saveProgress(progress: Progress): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(progress));
  } catch {
    // Saving is a nicety; never let it break the game.
  }
}
