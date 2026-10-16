const assert = require('assert');
const { buildTree, nextFocus, stepBackTarget, findNodeByRowKeys, toLabel, isWithin } = require('../.tmp/unit/tree');
const { layoutTree, fitBox, overviewBox, subtreeBox, fullNodePredicate, compactMetrics, zoomPath, connectorPath } = require('../.tmp/unit/layout');

const rows = [
  ['T1', 'Acme', 'EDC', 5], ['T1', 'Acme', 'IRT', 3], ['T1', 'Beta', 'EDC', 4],
  ['T2', 'Acme', 'EDC', 10], [null, '', 'ePRO', -2], ['T2', 'Gamma', 'X', 0],
].map((r, i) => ({ path: r.slice(0, 3).map(v => toLabel(v)), value: r[3], rowIndex: i }));
const t = buildTree(rows, ['Program', 'Vendor', 'Application']);
assert.equal(t.root.value, 20); assert.equal(t.root.rowCount, 6);
assert.deepEqual(t.root.children.map(n => n.name), ['T1', 'T2', 'Unassigned']);
const t1 = t.byKey.get('T1');
assert.deepEqual(t1.children.map(n => [n.name, n.value]), [['Acme', 8], ['Beta', 4]]);
const a1 = t.byKey.get('T1\u001fAcme'), a2 = t.byKey.get('T2\u001fAcme');
assert.ok(a1 && a2 && a1 !== a2);
assert.ok(t.byKey.get('Unassigned\u001fUnassigned\u001fePRO'));
assert.deepEqual(t.byKey.get('T2').children.map(n => n.name), ['Acme', 'Gamma']);

// Focus rules
const edc = t.byKey.get('T1\u001fAcme\u001fEDC');
let f = nextFocus(null, edc); assert.equal(f, edc);
f = nextFocus(f, edc); assert.equal(f, a1);
f = nextFocus(f, a1); assert.equal(f, t1);
f = nextFocus(f, t1); assert.equal(f, null);
assert.equal(nextFocus(t1, a2), a2);
assert.equal(nextFocus(a2, t.root), null);
assert.equal(stepBackTarget(null), null);
assert.equal(findNodeByRowKeys(t, new Set(a1.rows.map(String)), r => String(r)), a1);
const g = t.byKey.get('T2\u001fGamma');
assert.equal(findNodeByRowKeys(t, new Set(g.rows.map(String)), r => String(r)), g.children[0]);

// Layout
function opts(orientation, collapse) {
  const cross = orientation === 'horizontal' ? 58 : 184;
  return { orientation, collapse, nodeWidth: 184, nodeHeight: 58, levelSpacing: 56, siblingSpacing: 12, ...compactMetrics(cross, 12) };
}
function noOverlap(tree, orientation) {
  const cols = {};
  for (const n of tree.nodes) if (!n.hidden) (cols[n.depth] = cols[n.depth] || []).push(n);
  for (const d in cols) {
    const key = orientation === 'horizontal' ? 'y' : 'x', size = orientation === 'horizontal' ? 'h' : 'w';
    const c = cols[d].sort((a, b) => a[key] - b[key]);
    for (let i = 1; i < c.length; i++) assert.ok(c[i][key] >= c[i - 1][key] + c[i - 1][size] - 1e-6, `overlap at depth ${d}: ${c[i - 1].name} / ${c[i].name}`);
  }
}
function levelAxisOk(tree, orientation) {
  for (const n of tree.nodes) if (!n.hidden && n.parent) {
    if (orientation === 'horizontal') assert.ok(n.x > n.parent.x, 'child right of parent');
    else assert.ok(n.y > n.parent.y, 'child below parent');
  }
}
for (const orientation of ['horizontal', 'vertical']) {
  for (const collapse of ['compressed', 'hidden']) {
    for (const focus of [null, t1, a1, edc, g]) {
      layoutTree(t, opts(orientation, collapse), fullNodePredicate(focus, 1));
      noOverlap(t, orientation);
      levelAxisOk(t, orientation);
      if (focus) for (const n of t.nodes) if (n === focus || isWithin(n, focus)) assert.ok(n.full && !n.hidden, 'focused subtree full');
      if (collapse === 'hidden') for (const n of t.nodes) assert.equal(n.hidden, !n.full, 'hidden mode: not full means hidden');
      else for (const n of t.nodes) assert.equal(n.hidden, false, 'compressed mode hides nothing');
      // Hidden nodes sit at their parent's outgoing edge so they can grow from it.
      for (const n of t.nodes) if (n.hidden && n.parent && !n.parent.hidden) {
        if (orientation === 'horizontal') assert.ok(Math.abs(n.y - (n.parent.y + n.parent.h / 2)) < 1e-6);
        else assert.ok(Math.abs(n.x - (n.parent.x + n.parent.w / 2)) < 1e-6);
      }
    }
  }
}
layoutTree(t, opts('horizontal', 'compressed'), fullNodePredicate(null, 1));
assert.ok(t.root.children.every(n => n.full) && a1.full === false, 'overview: level 1 full, level 2 compact');
layoutTree(t, opts('horizontal', 'compressed'), fullNodePredicate(a1, 1));
assert.ok(a1.full && edc.full && t.byKey.get('T1\u001fBeta').full && !t.byKey.get('T2\u001fAcme').full, 'focus keeps path context');
// Vertical org chart: root at top, level 1 in a row beneath it, centred under the root
layoutTree(t, opts('vertical', 'hidden'), fullNodePredicate(null, 1));
const kids = t.root.children;
assert.ok(kids.every(k => Math.abs(k.y - kids[0].y) < 1e-6), 'children share a row');
const mid = (kids[0].x + kids.at(-1).x + kids.at(-1).w) / 2;
assert.ok(Math.abs(mid - (t.root.x + t.root.w / 2)) < 1e-6, 'root centred over children');
const sb = subtreeBox(t.root, 'vertical');
assert.ok(sb.w >= 3 * 184 && sb.h >= 58, 'vertical subtree box');

// Fit
const vb = fitBox(subtreeBox(a1, 'horizontal'), 800, 400, { orientation: 'horizontal', padding: 16, maxScale: 1.6, minScale: 0.4 });
assert.ok(Math.abs(vb.w / vb.h - 2) < 1e-9, 'aspect preserved');
const vv = fitBox(overviewBox(t, 1), 800, 400, { orientation: 'vertical', padding: 16, maxScale: 1.1, minScale: 0.4, alignStart: true });
assert.ok(vv.y <= t.root.y && vv.y + vv.h >= t.root.y + t.root.h, 'vertical overview shows the root');

// Zoom path: starts and ends exactly, keeps aspect, pulls out between distant views
const A = { x: 0, y: 0, w: 400, h: 200 }, B = { x: 3000, y: 900, w: 200, h: 100 };
const zp = zoomPath(A, B);
const s0 = zp.at(0), s1 = zp.at(1), sm = zp.at(0.5);
for (const k of ['x', 'y', 'w', 'h']) { assert.ok(Math.abs(s0[k] - A[k]) < 1e-6); assert.ok(Math.abs(s1[k] - B[k]) < 1e-6); }
assert.ok(sm.w > A.w, 'camera pulls out on a long move');
assert.ok(Math.abs(sm.h / sm.w - 0.5) < 1e-9, 'aspect kept mid-flight');
const zz = zoomPath(A, { x: 100, y: 50, w: 200, h: 100 });
assert.ok(zz.at(0.5).w < A.w && zz.at(0.5).w > 200, 'pure zoom is monotonic');

// Connectors
assert.ok(connectorPath({ x: 0, y: 0, w: 100, h: 40 }, { x: 150, y: 100, w: 100, h: 40 }, 'horizontal', 'curved').startsWith('M100,20 C'));
assert.ok(connectorPath({ x: 0, y: 0, w: 100, h: 40 }, { x: 150, y: 100, w: 100, h: 40 }, 'vertical', 'elbow').startsWith('M50,40 L'));

// Large tree
const big = []; for (let i = 0; i < 30000; i++) big.push({ path: ['T' + (i % 40), 'V' + (i % 300), 'S' + (i % 2000), 'X' + i % 7], value: i % 13 - 3, rowIndex: i });
let t0 = Date.now(); const bt = buildTree(big, ['a', 'b', 'c', 'd']);
for (const orientation of ['horizontal', 'vertical']) for (const collapse of ['compressed', 'hidden']) {
  layoutTree(bt, opts(orientation, collapse), fullNodePredicate(null, 1)); noOverlap(bt, orientation);
}
console.log('30k rows ->', bt.nodes.length, 'nodes, built + 4 layouts in', Date.now() - t0, 'ms');
const deep = buildTree([{ path: ['1', '2', '3', '4', '5', '6', '7', '8'], value: 1, rowIndex: 0 }], ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
assert.equal(deep.maxDepth, 8);
console.log('ALL TREE/LAYOUT TESTS PASSED');
