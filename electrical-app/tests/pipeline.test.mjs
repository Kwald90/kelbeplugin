// Editable sales pipeline (lib/pipeline.js): stage repair, funnel order and reached counts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_STAGES, normalizeStages, pipelineStages, stageById, openStages,
  leadIsOpen, newStageId, funnelOrder, reachedCounts,
} from '../js/lib/pipeline.js';

test('the default pipeline has one Won and one Lost terminal stage', () => {
  assert.equal(DEFAULT_STAGES.filter((s) => s.kind === 'won').length, 1);
  assert.equal(DEFAULT_STAGES.filter((s) => s.kind === 'lost').length, 1);
  assert.equal(stageById(DEFAULT_STAGES, 'won').kind, 'won');
  assert.equal(stageById(DEFAULT_STAGES, 'lost').kind, 'lost');
});

test('normalizeStages falls back to the defaults for an empty or bad list', () => {
  assert.deepEqual(normalizeStages(undefined), DEFAULT_STAGES);
  assert.deepEqual(normalizeStages([]), DEFAULT_STAGES);
  assert.deepEqual(normalizeStages('nope'), DEFAULT_STAGES);
  // a fresh copy, not a shared reference
  const a = normalizeStages([]);
  a[0].label = 'changed';
  assert.equal(DEFAULT_STAGES[0].label, 'New');
});

test('normalizeStages keeps a valid custom list and preserves a stage trigger', () => {
  const custom = [
    { id: 'new', label: 'Enquiry', kind: 'open' },
    { id: 'quote', label: 'Quote sent', kind: 'open', sequenceId: 'seq1' },
    { id: 'won', label: 'Booked', kind: 'won' },
    { id: 'lost', label: 'No go', kind: 'lost' },
  ];
  const out = normalizeStages(custom);
  assert.deepEqual(out.map((s) => s.id), ['new', 'quote', 'won', 'lost']);
  assert.equal(out[0].label, 'Enquiry');
  assert.equal(out[1].sequenceId, 'seq1');
  assert.equal(stageById(out, 'won').kind, 'won');
});

test('normalizeStages appends Won/Lost when missing and only reserved ids are terminal', () => {
  const out = normalizeStages([{ id: 'a', label: 'A', kind: 'won' }, { id: 'b', label: 'B', kind: 'lost' }]);
  // a and b are not the reserved ids, so they are forced open, and Won/Lost are appended
  assert.equal(stageById(out, 'a').kind, 'open');
  assert.equal(stageById(out, 'b').kind, 'open');
  assert.equal(out.filter((s) => s.kind === 'won').length, 1);
  assert.equal(out.filter((s) => s.kind === 'lost').length, 1);
  assert.equal(out[out.length - 2].id, 'won');
  assert.equal(out[out.length - 1].id, 'lost');
});

test('normalizeStages drops blank and duplicate ids and caps the label length', () => {
  const out = normalizeStages([
    { id: '', label: 'blank' },
    { id: 'dup', label: 'First' },
    { id: 'dup', label: 'Second' },
    { id: 'long', label: 'x'.repeat(80) },
  ]);
  assert.equal(out.filter((s) => s.id === 'dup').length, 1);
  assert.equal(stageById(out, 'dup').label, 'First');
  assert.equal(stageById(out, 'long').label.length, 40);
  assert.ok(!out.some((s) => s.id === ''));
});

test('pipelineStages reads settings.pipeline.stages and falls back', () => {
  assert.deepEqual(pipelineStages(null), DEFAULT_STAGES);
  assert.deepEqual(pipelineStages({}), DEFAULT_STAGES);
  const stages = [{ id: 'new', label: 'Lead', kind: 'open' }, { id: 'won', label: 'Won', kind: 'won' }, { id: 'lost', label: 'Lost', kind: 'lost' }];
  assert.equal(pipelineStages({ pipeline: { stages } })[0].label, 'Lead');
});

test('openStages and leadIsOpen treat only Won/Lost as terminal', () => {
  assert.deepEqual(openStages(DEFAULT_STAGES).map((s) => s.id), ['new', 'contacted', 'site-visit', 'quoted']);
  assert.equal(leadIsOpen('quoted'), true);
  assert.equal(leadIsOpen('won'), false);
  assert.equal(leadIsOpen('lost'), false);
});

test('newStageId mints an id not already in use', () => {
  const id = newStageId(DEFAULT_STAGES);
  assert.ok(!DEFAULT_STAGES.some((s) => s.id === id));
  // collides with the obvious candidate, so it must skip it
  const withStage5 = [...DEFAULT_STAGES, { id: 'stage-5', label: 'Five', kind: 'open' }];
  assert.ok(!withStage5.some((s) => s.id === newStageId(withStage5)));
});

test('funnelOrder is the open stages plus Won, never Lost', () => {
  const order = funnelOrder(DEFAULT_STAGES);
  assert.deepEqual(order.map((s) => s.id), ['new', 'contacted', 'site-visit', 'quoted', 'won']);
  assert.ok(!order.some((s) => s.kind === 'lost'));
});

test('reachedCounts: a lead reaches every stage up to its own; Lost and unknown count only at the top', () => {
  const order = funnelOrder(DEFAULT_STAGES); // new, contacted, site-visit, quoted, won
  const leads = [
    { stage: 'new' },
    { stage: 'quoted' },
    { stage: 'won' },
    { stage: 'lost' },
    { stage: 'deleted-stage' },
  ];
  // index 0 (new): everyone = 5; indexes 1-3: quoted + won = 2; index 4 (won): won only = 1
  assert.deepEqual(reachedCounts(leads, order), [5, 2, 2, 2, 1]);
});
