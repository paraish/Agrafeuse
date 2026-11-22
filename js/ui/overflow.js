// How far a drawn graph sticks out past the edges of its picture (a long title,
// tick labels at the ends of an axis, a big legend…), measured on the preview
// SVG. Whatever is clipped to the plotting panel cannot stick out, so it is
// skipped. Returns { left, right, top, bottom } in points (0 = fits), or null.
const TOLERANCE = 1.5; // pt

export function measureOverflow(svgText) {
  if (!svgText || typeof DOMParser === 'undefined') return null;
  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  const src = doc.documentElement;
  if (!src || src.nodeName.toLowerCase() !== 'svg') return null;
  const svg = document.importNode(src, true);
  svg.querySelectorAll('script, foreignObject').forEach((e) => e.remove());
  const vb = svg.viewBox?.baseVal;
  const W = vb?.width || parseFloat(svg.getAttribute('width'));
  const H = vb?.height || parseFloat(svg.getAttribute('height'));
  if (!(W > 0 && H > 0)) return null;
  // One unit of the picture = one CSS pixel, out of sight.
  svg.setAttribute('width', String(W));
  svg.setAttribute('height', String(H));
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-20000px;top:0;visibility:hidden;pointer-events:none;contain:strict;width:0;height:0;overflow:visible;';
  host.append(svg);
  document.body.append(host);
  try {
    // Clip regions as rectangles; one that covers the whole picture clips nothing we care about.
    const clipBox = new Map();
    for (const cp of svg.querySelectorAll('clipPath[id]')) {
      const nums = (cp.querySelector('path')?.getAttribute('d') || '').match(/-?\d*\.?\d+(?:e-?\d+)?/gi)?.map(Number) || [];
      const xs = nums.filter((_, i) => i % 2 === 0);
      const ys = nums.filter((_, i) => i % 2 === 1);
      const r = cp.querySelector('rect');
      const box = r ? { x0: +r.getAttribute('x'), y0: +r.getAttribute('y'), x1: +r.getAttribute('x') + +r.getAttribute('width'), y1: +r.getAttribute('y') + +r.getAttribute('height') }
        : xs.length ? { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) } : null;
      if (box) clipBox.set(cp.id, box);
    }
    const clippedInside = (el) => {
      for (let p = el.parentElement; p && p !== svg; p = p.parentElement) {
        const ref = /url\(#([^)]+)\)/.exec(p.getAttribute('clip-path') || '');
        if (!ref) continue;
        const b = clipBox.get(ref[1]);
        if (b && !(b.x0 <= 0.5 && b.y0 <= 0.5 && b.x1 >= W - 0.5 && b.y1 >= H - 0.5)) return true;
      }
      return false;
    };
    const root = svg.getBoundingClientRect();
    let x0 = 0, y0 = 0, x1 = W, y1 = H;
    for (const el of svg.querySelectorAll('path, use, rect, circle, ellipse, line, polyline, polygon, image, text')) {
      if (el.closest('defs, clipPath, mask, symbol, pattern, marker')) continue;
      if (clippedInside(el)) continue;
      const r = el.getBoundingClientRect();
      if (!r.width && !r.height) continue;
      const a = r.left - root.left, b = r.top - root.top;
      // The background of the whole picture.
      if (r.width >= W * 0.98 && r.height >= H * 0.98) continue;
      x0 = Math.min(x0, a); y0 = Math.min(y0, b);
      x1 = Math.max(x1, a + r.width); y1 = Math.max(y1, b + r.height);
    }
    const out = (v) => (v > TOLERANCE ? Math.ceil(v) : 0);
    return { left: out(-x0), right: out(x1 - W), top: out(-y0), bottom: out(y1 - H) };
  } catch {
    return null;
  } finally {
    host.remove();
  }
}

// "the top and right edges"
export function edgesText(ov) {
  const e = ['top', 'right', 'bottom', 'left'].filter((k) => ov?.[k] > 0);
  if (!e.length) return '';
  return `${e.length > 1 ? `${e.slice(0, -1).join(', ')} and ${e[e.length - 1]}` : e[0]} edge${e.length > 1 ? 's' : ''}`;
}
