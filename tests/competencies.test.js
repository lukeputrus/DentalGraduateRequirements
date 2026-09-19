const test = require('node:test');
const assert = require('node:assert');
const { computeStatus, summarize, groupByCategory } = require('../src/utils/competencies');

test('computeStatus: not_started when no items have progress', () => {
  const items = [{ current_count: 0, target_count: 1 }, { current_count: 0, target_count: 3 }];
  assert.equal(computeStatus(items, 'not_attempted'), 'not_started');
});

test('computeStatus: prereqs_in_progress when some but not all items are complete', () => {
  const items = [{ current_count: 1, target_count: 1 }, { current_count: 1, target_count: 3 }];
  assert.equal(computeStatus(items, 'not_attempted'), 'prereqs_in_progress');
});

test('computeStatus: eligible when every item has hit its target', () => {
  const items = [{ current_count: 1, target_count: 1 }, { current_count: 3, target_count: 3 }];
  assert.equal(computeStatus(items, 'not_attempted'), 'eligible');
});

test('computeStatus: eligible immediately when a competency has no prerequisite items', () => {
  assert.equal(computeStatus([], 'not_attempted'), 'eligible');
});

test('computeStatus: an explicit exam outcome overrides item progress', () => {
  const incompleteItems = [{ current_count: 0, target_count: 1 }];
  assert.equal(computeStatus(incompleteItems, 'passed'), 'passed');
  assert.equal(computeStatus(incompleteItems, 'needs_retest'), 'needs_retest');
});

test('summarize: counts each status bucket and computes pass percentage', () => {
  const competencies = [
    { status: 'passed' },
    { status: 'passed' },
    { status: 'eligible' },
    { status: 'prereqs_in_progress' },
    { status: 'not_started' },
    { status: 'needs_retest' },
  ];
  const s = summarize(competencies);
  assert.equal(s.total, 6);
  assert.equal(s.passed, 2);
  assert.equal(s.eligible, 1);
  assert.equal(s.prereqs_in_progress, 1);
  assert.equal(s.not_started, 1);
  assert.equal(s.needs_retest, 1);
  assert.equal(s.percent, 33);
});

test('summarize: 0% on an empty list, no division by zero', () => {
  assert.equal(summarize([]).percent, 0);
});

test('groupByCategory: groups items under their category, preserving order of first appearance', () => {
  const competencies = [
    { category: 'Oral Surgery', id: 1 },
    { category: 'Pediatric', id: 2 },
    { category: 'Oral Surgery', id: 3 },
  ];
  const groups = groupByCategory(competencies);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].category, 'Oral Surgery');
  assert.equal(groups[0].items.length, 2);
  assert.equal(groups[1].category, 'Pediatric');
  assert.equal(groups[1].items.length, 1);
});

test('groupByCategory: falls back to "General" for a missing category', () => {
  const groups = groupByCategory([{ category: null, id: 1 }]);
  assert.equal(groups[0].category, 'General');
});
