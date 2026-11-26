// Run: node --test electrical-app/tests/
// The paper pattern under a drawing: level it is unchanged, and when two fingers turn the canvas the
// grid turns with the drawing and still covers the whole screen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drawPaper } from '../js/canvas/engine.js';
import { screenToWorld } from '../js/canvas/gestures.js';

/** A 2D context that records what is drawn, in screen px (translate and rotate applied). */
function recorder() {
  let tx = 0, ty = 0, r = 0;
  const stack = [];
  const lines = [];
  let from = null;
  const map = (x, y) => [tx + x * Math.cos(r) - y * Math.sin(r), ty + x * Math.sin(r) + y * Math.cos(r)];
  return {
    lines, calls: [],
    fillRect() {}, beginPath() {}, stroke() {}, fill() {}, arc() {},
    save() { stack.push([tx, ty, r]); }, restore() { [tx, ty, r] = stack.pop(); },
    translate(x, y) { this.calls.push(['translate', x, y]); [tx, ty] = map(x, y); },
    rotate(a) { this.calls.push(['rotate', a]); r += a; },
    moveTo(x, y) { from = map(x, y); },
    lineTo(x, y) { lines.push([from, map(x, y)]); },
  };
}
const colors = { bg: '#fff', line: '#ccc' };

test('a level grid is drawn as before: crisp lines on the screen, offset by the pan', () => {
  const c = recorder();
  drawPaper(c, { x: 10, y: 5, zoom: 1 }, 200, 100, 'grid', colors);
  const verticals = c.lines.filter(([a, b]) => a[0] === b[0]).map(([a]) => a[0]);
  assert.equal(verticals[0], 10.5, 'first line at the pan offset, on a pixel');
  assert.equal(verticals[1], 34.5, '24 units apart at zoom 1');
  assert.equal(c.calls.length, 0, 'no transform when level');
});

test('a turned canvas turns its grid, which still reaches every corner of the screen', () => {
  const view = { x: 150, y: 80, zoom: 1.5, rot: 0.6 };
  const c = recorder();
  drawPaper(c, view, 300, 200, 'grid', colors);
  assert.deepEqual(c.calls, [['translate', 150, 80], ['rotate', 0.6]]);
  assert.ok(c.lines.length > 10);
  // every line is along a world axis: its direction is the view's rotation (or a quarter turn more)
  for (const [a, b] of c.lines) {
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]) - 0.6;
    const q = ang / (Math.PI / 2);
    assert.ok(Math.abs(q - Math.round(q)) < 1e-9, 'parallel to a world axis');
  }
  // and the lines run on world grid positions (multiples of 24 units)
  const [a] = c.lines[0];
  const w = screenToWorld(view, a[0], a[1]);
  assert.ok(w.some((v) => Math.abs(v / 24 - Math.round(v / 24)) < 1e-6), JSON.stringify(w));
  // each screen corner lies within the span of the drawn lines
  const xs = c.lines.flat().map((p) => p[0]), ys = c.lines.flat().map((p) => p[1]);
  for (const [cx, cy] of [[0, 0], [300, 0], [0, 200], [300, 200]]) {
    assert.ok(cx >= Math.min(...xs) - 1e-6 && cx <= Math.max(...xs) + 1e-6 && cy >= Math.min(...ys) - 1e-6 && cy <= Math.max(...ys) + 1e-6, `corner ${cx},${cy}`);
  }
});

test('isometric paper turns too', () => {
  const c = recorder();
  drawPaper(c, { x: 0, y: 0, zoom: 1, rot: -1.1 }, 200, 200, 'iso', colors);
  assert.ok(c.lines.length > 10);
  assert.deepEqual(c.calls[1], ['rotate', -1.1]);
});
