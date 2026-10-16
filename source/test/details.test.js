const assert = require('assert');
const { collectDetails, summarizeDetail, initialsOf, isWebLink } = require('../.tmp/unit/details');
const rows = [
  ['Ada Quillmere', 'Manager', 'Copenhagen', null],
  ['Bex Thornvale', 'Analyst', 'Aarhus', ''],
  ['Cai Larkholt', 'Analyst', 'Copenhagen', 'https://example.com/profile/cai'],
  ['Dex Fernby', 'Engineer', 'Odense', null],
  ['Elo Wrenstead', 'Designer', 'Oslo', null],
];
const fmt = v => (v === null || v === undefined || v === '' ? null : String(v));
const cols = [{ name: 'Position', index: 1, format: fmt }, { name: 'Location', index: 2, format: fmt }, { name: 'Link', index: 3, format: fmt }];
const one = collectDetails(rows, [0], cols);
assert.deepEqual(one.map(summarizeDetail), ['Manager', 'Copenhagen', '–']);
const two = collectDetails(rows, [1, 2], cols);
assert.equal(summarizeDetail(two[0]), 'Analyst', 'duplicates collapse');
assert.equal(summarizeDetail(two[1]), 'Aarhus, Copenhagen');
assert.equal(summarizeDetail(two[2]), 'https://example.com/profile/cai', 'blanks ignored');
const all = collectDetails(rows, [0, 1, 2, 3, 4], cols);
assert.equal(summarizeDetail(all[0]), '4 different values');
assert.equal(all[1].distinct, 4);
assert.equal(initialsOf('Ada Quillmere'), 'AQ');
assert.equal(initialsOf('Bex Thornvale'), 'BT');
assert.equal(initialsOf('Finance'), 'FI');
assert.equal(initialsOf('Plan-301 North'), 'PN');
assert.equal(initialsOf('Quality & Compliance'), 'QC');
assert.equal(initialsOf('Ølstykke Ærø'), 'ØÆ');
assert.equal(initialsOf('2024'), '20');
assert.equal(initialsOf('  '), '?');
assert.ok(isWebLink('https://example.com/x') && !isWebLink('http://example.com') && !isWebLink('javascript:alert(1)') && !isWebLink('see https://x.com'));
console.log('ALL DETAILS TESTS PASSED');
