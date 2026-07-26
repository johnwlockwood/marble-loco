import type { ControlMode } from '../core/Input';

const KEY = 'marble-loco.progress.v1';

export interface Progress {
  /** Index of the highest level the player may start. */
  unlocked: number;
  /** Best time per level id, in seconds. */
  bests: Record<number, number>;
  /**
   * Steering the player last chose.
   *
   * This is a *preference*, not live state: tilt cannot be switched on at load
   * because the permission API demands a user gesture, so the game restores it
   * on the next tap instead.
   */
  controls: ControlMode;
}

function fresh(): Progress {
  return { unlocked: 0, bests: {}, controls: 'stick' };
}

export function loadProgress(): Progress {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return fresh();

    const parsed = JSON.parse(raw) as Partial<Progress>;
    return {
      unlocked: Number.isFinite(parsed.unlocked) ? Math.max(0, parsed.unlocked as number) : 0,
      bests: parsed.bests && typeof parsed.bests === 'object' ? parsed.bests : {},
      controls: parsed.controls === 'tilt' ? 'tilt' : 'stick',
    };
  } catch {
    // Private browsing, cleared storage, corrupt JSON -- all mean "start over".
    return fresh();
  }
}

export function saveProgress(progress: Progress): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(progress));
  } catch {
    // Saving is a nicety; never let it break the game.
  }
}
