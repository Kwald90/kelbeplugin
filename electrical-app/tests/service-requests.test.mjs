// Inbound service requests (lib/service-requests.js): the pipeline-ready shape, filtering and sort.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SERVICE_TYPES, URGENCY, serviceTypeLabel, urgencyRank, isServiceLead,
  newServiceRequest, serviceInbox, summarizeRequest,
} from '../js/lib/service-requests.js';

test('newServiceRequest produces a pipeline-ready service lead', () => {
  const r = newServiceRequest({
    contactName: 'Jane Doe', phone: '204-555-0100', email: 'jane@example.com',
    address: '42 Harbour St', serviceType: 'panel', description: 'Upgrade to 200A', urgency: 'urgent',
    preferredTimes: 'Weekday mornings', source: 'booking',
  });
  assert.equal(r.kind, 'service');
  assert.equal(r.stage, 'new'); // enters the board at the first open stage
  assert.equal(r.serviceType, 'panel');
  assert.equal(r.urgency, 'urgent');
  assert.equal(r.contactName, 'Jane Doe');
  assert.equal(r.serviceAddress, '42 Harbour St');
  assert.equal(r.notes, 'Upgrade to 200A');
  assert.match(r.title, /Panel or service upgrade/);
  assert.match(r.title, /Jane Doe/);
  assert.ok(isServiceLead(r));
  assert.equal(r.id, undefined); // store.add assigns the id
});

test('unknown type and blank urgency fall back safely', () => {
  const r = newServiceRequest({ serviceType: 'nope', urgency: '' });
  assert.equal(r.serviceType, 'other');
  assert.equal(r.urgency, 'flexible');
  assert.equal(r.source, 'booking'); // default source when none given
});

test('fields are trimmed and length-capped', () => {
  const r = newServiceRequest({ contactName: '  Bob  ', description: 'x'.repeat(30000) });
  assert.equal(r.contactName, 'Bob');
  assert.equal(r.notes.length, 20000);
});

test('isServiceLead only matches service-kind leads', () => {
  assert.ok(isServiceLead({ kind: 'service' }));
  assert.ok(!isServiceLead({ kind: 'sales' }));
  assert.ok(!isServiceLead({}));
  assert.ok(!isServiceLead(null));
});

test('serviceInbox keeps open service leads, most urgent first then newest', () => {
  const leads = [
    { id: 'a', kind: 'service', stage: 'new', urgency: 'flexible', createdAt: '2026-11-01T10:00:00Z' },
    { id: 'b', kind: 'service', stage: 'new', urgency: 'emergency', createdAt: '2026-11-02T10:00:00Z' },
    { id: 'c', kind: 'service', stage: 'won', urgency: 'urgent', createdAt: '2026-11-03T10:00:00Z' }, // closed out
    { id: 'd', kind: 'sales', stage: 'new', urgency: 'urgent', createdAt: '2026-11-04T10:00:00Z' }, // not a service req
    { id: 'e', kind: 'service', stage: 'new', urgency: 'soon', createdAt: '2026-11-05T10:00:00Z' },
    { id: 'f', kind: 'service', stage: 'new', urgency: 'soon', createdAt: '2026-11-06T10:00:00Z' },
  ];
  const ids = serviceInbox(leads).map((l) => l.id);
  assert.deepEqual(ids, ['b', 'f', 'e', 'a']); // emergency, then two 'soon' newest-first, then flexible
});

test('metadata tables are well-formed and summary reads cleanly', () => {
  assert.ok(SERVICE_TYPES.every((t) => t.id && t.label));
  assert.ok(URGENCY.every((u) => u.id && u.label && Number.isInteger(u.rank)));
  assert.equal(serviceTypeLabel('ev'), 'EV charger');
  assert.equal(urgencyRank('emergency'), 0);
  assert.ok(urgencyRank('nope') >= URGENCY.length); // unknown sorts last
  assert.equal(summarizeRequest({ serviceType: 'ev', urgency: 'emergency', serviceAddress: '5 Main' }),
    'EV charger · Emergency · 5 Main');
});
