const test = require('node:test');
const assert = require('node:assert/strict');
const { LookupQueue } = require('../extension/src/queue.js');

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

test('never runs more than `concurrency` jobs and uses distinct slots', async () => {
  let active = 0;
  let maxActive = 0;
  const slotsInUse = new Set();
  const q = new LookupQueue({
    concurrency: 3,
    worker: async (key, slot) => {
      assert.ok(!slotsInUse.has(slot), 'slot reused while busy');
      slotsInUse.add(slot);
      active++;
      maxActive = Math.max(maxActive, active);
      await tick(5);
      active--;
      slotsInUse.delete(slot);
      return key + '!';
    },
  });
  const keys = Array.from({ length: 40 }, (_, i) => 'mc' + i);
  const results = await Promise.all(keys.map((k) => q.add(k)));
  assert.equal(maxActive, 3);
  assert.deepEqual(results, keys.map((k) => k + '!'));
});

test('duplicate keys run once', async () => {
  let calls = 0;
  const q = new LookupQueue({ concurrency: 2, worker: async (k) => (calls++, await tick(5), k) });
  await Promise.all([q.add('a'), q.add('a'), q.add('a'), q.add('b')]);
  assert.equal(calls, 2);
});

test('errors reject only that key', async () => {
  const q = new LookupQueue({
    concurrency: 2,
    worker: async (k) => {
      if (k === 'bad') throw new Error('boom');
      return k;
    },
  });
  await assert.rejects(q.add('bad'), /boom/);
  assert.equal(await q.add('good'), 'good');
});

test('requeue error pauses and resumes without losing the job', async () => {
  let loggedIn = false;
  const q = new LookupQueue({
    concurrency: 1,
    worker: async (k) => {
      if (!loggedIn) {
        const e = new Error('login');
        e.requeue = true;
        throw e;
      }
      return k;
    },
  });
  const p = q.add('x');
  await tick(5);
  assert.equal(q.paused, true);
  assert.equal(q.has('x'), true);
  loggedIn = true;
  q.resume();
  assert.equal(await p, 'x');
});
