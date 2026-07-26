import './style.css';
import { Game } from './game/Game';

const canvas = document.getElementById('gl') as HTMLCanvasElement;
const uiRoot = document.getElementById('ui') as HTMLElement;

// Safari fires a synthetic double-tap zoom even with user-scalable=no, and
// rubber-bands the page on any vertical drag. Both ruin a tilt-controlled game.
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });

try {
  const game = new Game(canvas, uiRoot);
  if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).game = game;
} catch (error) {
  console.error(error);
  uiRoot.innerHTML = `
    <div class="overlay">
      <div class="headline lose">No WebGL</div>
      <div class="body">This game needs WebGL 2. On iOS that means Safari 15 or newer.</div>
    </div>`;
}
