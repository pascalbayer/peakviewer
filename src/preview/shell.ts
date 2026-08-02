/** Common page scaffold for the step previews. */

import { CompassRibbon, Controls, el } from './ui';

export interface Shell {
  stage: HTMLDivElement;
  canvas: HTMLCanvasElement;
  overlay: HTMLDivElement;
  ribbon: CompassRibbon;
  badge: HTMLDivElement;
  controls: Controls;
  setProgress(frac: number, label?: string): void;
  done(): void;
  fail(err: unknown): void;
  setBadges(items: [string, string][]): void;
}

export function buildShell(title: string): Shell {
  const canvas = el('canvas', { class: 'view' });
  const ribbon = new CompassRibbon();
  const badge = el('div', { class: 'badge' });
  const overlay = el('div', { id: 'overlay' }, ribbon.canvas, badge);
  const bar = el('i');
  const label = el('small', {}, 'loading terrain…');
  const loading = el('div', { id: 'loading' },
    el('strong', {}, title), el('div', { class: 'bar' }, bar), label);
  const stage = el('div', { id: 'stage' }, canvas, overlay, loading);

  const controls = new Controls();
  const sheet = el('div', { id: 'sheet' }, controls.root);
  const toggle = el('button', { type: 'button' }, 'Hide');
  toggle.addEventListener('click', () => {
    const hidden = sheet.classList.toggle('collapsed');
    toggle.textContent = hidden ? 'Controls' : 'Hide';
  });
  const grip = el('div', { id: 'grip' }, el('span', { class: 'title' }, title), toggle);

  document.body.append(el('div', { id: 'app' }, stage, el('div', {
    style: 'display:contents',
  }, grip, sheet)));

  return {
    stage, canvas, overlay, ribbon, badge, controls,
    setProgress(frac, text) {
      bar.style.width = `${Math.round(frac * 100)}%`;
      if (text) label.textContent = text;
    },
    done() {
      loading.style.opacity = '0';
      setTimeout(() => loading.remove(), 400);
    },
    fail(err) {
      loading.remove();
      const msg = err instanceof Error ? `${err.message}\n\n${err.stack ?? ''}` : String(err);
      stage.append(el('div', { class: 'err' }, msg));
    },
    setBadges(items) {
      if (badge.childElementCount !== items.length) {
        badge.textContent = '';
        items.forEach(() => badge.append(
          el('span', {}, document.createTextNode(''), el('b', {})),
        ));
      }
      items.forEach(([k, v], i) => {
        const s = badge.children[i];
        s.firstChild!.textContent = `${k} `;
        (s.lastChild as HTMLElement).textContent = v;
      });
    },
  };
}
