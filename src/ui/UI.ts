import type { ControlMode } from '../core/Input';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, className?: string, text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function formatTime(seconds: number): string {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${m}:${rest.toFixed(1).padStart(4, '0')}`;
}

export interface TitleCallbacks {
  onStart: () => void;
  onLevels: () => void;
  onToggleControls: () => void;
}

export interface CompleteStats {
  levelName: string;
  time: number;
  best: number | null;
  isNewBest: boolean;
  deaths: number;
  isLast: boolean;
}

/**
 * All DOM. The game never touches `document` directly -- it calls into here.
 */
export class UI {
  readonly root: HTMLElement;

  readonly stick: HTMLElement;
  readonly nub: HTMLElement;
  readonly jump: HTMLElement;

  private readonly hud: HTMLElement;
  private readonly levelValue: HTMLElement;
  private readonly timeValue: HTMLElement;
  private readonly deathValue: HTMLElement;
  private readonly toastEl: HTMLElement;
  private readonly pauseBtn: HTMLElement;
  private overlay: HTMLElement | null = null;
  private toastTimer = 0;

  constructor(root: HTMLElement) {
    this.root = root;

    // --- HUD ---------------------------------------------------------------
    this.hud = el('div', 'hud hidden');
    const left = el('div', 'hud-l');
    left.append(el('div', 'hud-label', 'Level'));
    this.levelValue = el('div', 'hud-value', '--');
    left.append(this.levelValue);

    const right = el('div', 'hud-r');
    right.append(el('div', 'hud-label', 'Time'));
    this.timeValue = el('div', 'hud-value', '0:00.0');
    right.append(this.timeValue);
    this.deathValue = el('div', 'hud-label', 'Falls 0');
    right.append(this.deathValue);

    this.hud.append(left, right);

    this.pauseBtn = el('div', '', '⏸');
    this.pauseBtn.id = 'pause';
    this.pauseBtn.classList.add('hide');

    // --- touch controls -----------------------------------------------------
    this.stick = el('div', 'pad');
    this.stick.id = 'stick';
    this.nub = el('div', 'nub');
    this.stick.append(this.nub);
    this.stick.classList.add('hide');

    this.jump = el('div', 'pad', 'JUMP');
    this.jump.id = 'jump';
    this.jump.classList.add('hide');

    this.toastEl = el('div');
    this.toastEl.id = 'toast';

    root.append(this.hud, this.pauseBtn, this.stick, this.jump, this.toastEl);
  }

  onPause(handler: () => void): void {
    this.pauseBtn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      handler();
    });
  }

  /* ------------------------------------------------------------- overlays */

  private setOverlay(node: HTMLElement | null): void {
    this.overlay?.remove();
    this.overlay = node;
    if (node) this.root.append(node);
  }

  private makeOverlay(): HTMLElement {
    return el('div', 'overlay');
  }

  private button(label: string, onClick: () => void, ghost = false): HTMLButtonElement {
    const b = el('button', ghost ? 'btn ghost' : 'btn', label);
    // pointerdown, not click: on iOS click has a perceptible delay and this is
    // also the gesture we need for the audio/motion permission prompts.
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      onClick();
    });
    return b;
  }

  showTitle(
    cb: TitleCallbacks, mode: ControlMode, tiltAvailable: boolean, tiltNote = '',
  ): void {
    this.setPlayingChrome(false);
    const o = this.makeOverlay();

    o.append(el('div', 'subtitle', 'A rolling problem'));
    o.append(el('div', 'title', 'MARBLE\nLOCO'));
    o.append(el('div', 'body',
      'Ten courses. Gravity, momentum and very little floor. Get the marble to the gold pad before the clock runs out.'));

    const row = el('div', 'btn-row');
    row.append(this.button('Play', cb.onStart));
    row.append(this.button('Levels', cb.onLevels, true));
    o.append(row);

    if (tiltAvailable) {
      // A segmented control rather than a cycling button: the tilt option has
      // to look like something you can turn on, or nobody ever finds it.
      const seg = el('div', 'segment');
      seg.append(el('div', 'segment-label', 'Steering'));

      const opts = el('div', 'btn-row');
      const stick = this.button('Stick', () => {
        if (mode !== 'stick') cb.onToggleControls();
      }, true);
      const tilt = this.button('Tilt', () => {
        if (mode !== 'tilt') cb.onToggleControls();
      }, true);
      stick.classList.toggle('on', mode === 'stick');
      tilt.classList.toggle('on', mode === 'tilt');
      opts.append(stick, tilt);
      seg.append(opts);
      o.append(seg);
    }

    if (tiltNote) o.append(el('div', 'note', tiltNote));

    this.setOverlay(o);
  }

  showLevelSelect(
    levels: { id: number; name: string }[],
    unlocked: number,
    bests: Record<number, number>,
    onPick: (index: number) => void,
    onBack: () => void,
  ): void {
    this.setPlayingChrome(false);
    const o = this.makeOverlay();
    o.append(el('div', 'headline', 'Select Course'));

    const grid = el('div', 'levels');
    levels.forEach((lvl, i) => {
      const locked = i > unlocked;
      const b = el('button', 'lvl');
      b.append(el('div', '', String(lvl.id)));
      const best = bests[lvl.id];
      const sub = el('div', 'hud-label', best ? formatTime(best) : locked ? 'locked' : 'open');
      sub.style.fontSize = '8px';
      sub.style.marginTop = '4px';
      b.append(sub);

      if (locked) b.classList.add('locked');
      else if (best) b.classList.add('done');

      if (!locked) {
        b.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          onPick(i);
        });
      }
      grid.append(b);
    });
    o.append(grid);
    o.append(this.button('Back', onBack, true));
    this.setOverlay(o);
  }

  showCountdown(levelName: string, hint: string): void {
    this.setPlayingChrome(true);
    this.setOverlay(null);
    this.toast(levelName, '#58f7ff');
    window.setTimeout(() => this.toast(hint, '#8fa3c4'), 1400);
  }

  showPaused(onResume: () => void, onRestart: () => void, onQuit: () => void, onCalibrate: (() => void) | null): void {
    const o = this.makeOverlay();
    o.append(el('div', 'headline', 'Paused'));
    o.append(this.button('Resume', onResume));
    const row = el('div', 'btn-row');
    row.append(this.button('Restart', onRestart, true));
    row.append(this.button('Quit', onQuit, true));
    o.append(row);
    if (onCalibrate) {
      o.append(this.button('Re-centre tilt', onCalibrate, true));
      o.append(el('div', 'body', 'Hold the phone how you want to hold it, then re-centre.'));
    }
    this.setOverlay(o);
  }

  showComplete(stats: CompleteStats, onNext: () => void, onRetry: () => void, onMenu: () => void): void {
    this.setPlayingChrome(false);
    const o = this.makeOverlay();
    o.append(el('div', 'headline win', stats.isLast ? 'All Courses Clear' : 'Course Clear'));
    o.append(el('div', 'subtitle', stats.levelName));

    const stats_ = el('div', 'stats');
    const time = el('div', '', 'Time');
    time.append(el('b', '', formatTime(stats.time)));
    const best = el('div', '', stats.isNewBest ? 'New Best' : 'Best');
    best.append(el('b', '', formatTime(stats.best ?? stats.time)));
    const falls = el('div', '', 'Falls');
    falls.append(el('b', '', String(stats.deaths)));
    stats_.append(time, best, falls);
    o.append(stats_);

    if (stats.isNewBest) o.append(el('div', 'subtitle', '★ Personal best'));

    if (!stats.isLast) o.append(this.button('Next Course', onNext));
    const row = el('div', 'btn-row');
    row.append(this.button('Retry', onRetry, true));
    row.append(this.button('Menu', onMenu, true));
    o.append(row);

    this.setOverlay(o);
  }

  showFailed(title: string, message: string, onRetry: () => void, onMenu: () => void): void {
    this.setPlayingChrome(false);
    const o = this.makeOverlay();
    o.append(el('div', 'headline lose', title));
    o.append(el('div', 'body', message));
    o.append(this.button('Try Again', onRetry));
    o.append(this.button('Menu', onMenu, true));
    this.setOverlay(o);
  }

  clearOverlay(): void {
    this.setOverlay(null);
  }

  /* ------------------------------------------------------------------- hud */

  setPlayingChrome(visible: boolean, showStick = true): void {
    this.hud.classList.toggle('hidden', !visible);
    this.pauseBtn.classList.toggle('hide', !visible);
    this.jump.classList.toggle('hide', !visible);
    this.stick.classList.toggle('hide', !visible || !showStick);
  }

  setStickVisible(visible: boolean): void {
    this.stick.classList.toggle('hide', !visible);
  }

  setLevel(name: string): void {
    this.levelValue.textContent = name;
  }

  setTime(remaining: number, warn: boolean): void {
    this.timeValue.textContent = formatTime(remaining);
    this.timeValue.classList.toggle('warn', warn);
  }

  setDeaths(n: number): void {
    this.deathValue.textContent = `Falls ${n}`;
  }

  toast(message: string, color = '#eaf2ff'): void {
    this.toastEl.textContent = message;
    this.toastEl.style.color = color;
    this.toastEl.classList.remove('show');
    // Force a reflow so the animation restarts even for back-to-back toasts.
    void this.toastEl.offsetWidth;
    this.toastEl.classList.add('show');
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toastEl.classList.remove('show'), 1400);
  }
}
