/** DOM helpers shared by the app and the preview pages. */

/**
 * A preview is emitted as a fragment (no <body> tag of its own), so the parser
 * is still in head context when the inline bundle runs and document.body can
 * legitimately be null.
 */
export function domReady(): Promise<void> {
  if (document.readyState !== 'loading' && document.body) return Promise.resolve();
  return new Promise((r) => document.addEventListener('DOMContentLoaded', () => r()));
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, attrs: Record<string, unknown> = {}, ...kids: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = String(v);
    else if (k === 'style') n.setAttribute('style', String(v));
    else if (k.startsWith('on') && typeof v === 'function') {
      n.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (v !== undefined && v !== null && v !== false) {
      n.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const k of kids) n.append(k);
  return n;
}

