const test = require('node:test');
const assert = require('node:assert/strict');
const { findAllMcs, findFirstMc, stripQuoted, extractMc } = require('../extension/src/mc.js');

test('recognizes common MC formats', () => {
  const cases = {
    'MC# 689501': '689501',
    'MC#689501': '689501',
    'MC 689501': '689501',
    'MC-689501': '689501',
    'MC689501': '689501',
    'M.C. #689501': '689501',
    'MC Number: 689501': '689501',
    'MC No. 689501': '689501',
    'mc #: 689501': '689501',
    'MC: 0689501': '689501',
    'DOT 1928967 / MC 815700': '815700',
  };
  for (const [text, want] of Object.entries(cases)) {
    assert.equal(findFirstMc(text), want, text);
  }
});

test('does not match MC inside other words or without digits', () => {
  assert.equal(findFirstMc('EMC 123456'), null);
  assert.equal(findFirstMc('Contact mcdonald@carrier.com'), null);
  assert.equal(findFirstMc('No MC here, DOT 1928967'), null);
});

test('findAllMcs de-duplicates and keeps order', () => {
  assert.deepEqual(findAllMcs('MC 1111 then MC# 2222 and MC-1111'), ['1111', '2222']);
});

test('ignore list skips your own MC', () => {
  assert.equal(findFirstMc('Our MC 555555, carrier MC 689501', ['555555']), '689501');
});

test('stripQuoted removes Gmail reply history', () => {
  const body = 'Hi, we can cover it.\nMC 689501\n\nOn Mon, Nov 3, 2026 at 9:00 AM Broker <b@x.com>\nwrote:\n> MC 999999';
  const s = stripQuoted(body);
  assert.match(s, /689501/);
  assert.doesNotMatch(s, /999999/);
});

test('stripQuoted removes Outlook reply history', () => {
  const body = 'Rate ok.\n\nFrom: Broker <b@x.com>\nSent: Monday\nTo: me\nSubject: load\nMC 999999';
  assert.doesNotMatch(stripQuoted(body), /999999/);
  const body2 = 'Rate ok.\n-----Original Message-----\nMC 999999';
  assert.doesNotMatch(stripQuoted(body2), /999999/);
});

test('stripQuoted removes > quoted lines', () => {
  assert.doesNotMatch(stripQuoted('ok\n> MC 999999\nthanks'), /999999/);
});

test('extractMc: subject first, then newest message, then older', () => {
  assert.equal(extractMc({ subject: 'Load 123 - MC 111111', snippet: '', messages: ['MC 222222'] }), '111111');
  assert.equal(extractMc({ subject: 'Load', snippet: 'hi', messages: ['MC 222222', 'MC 333333'] }), '222222');
  assert.equal(extractMc({ subject: 'Load', snippet: 'hi', messages: ['thanks!', 'MC 333333'] }), '333333');
  assert.equal(
    extractMc({ subject: 'Load', snippet: '', messages: ['thanks\nOn Mon wrote:\n> MC 999999'] }),
    null
  );
});

const { parseMessage, solelyToMe } = require('../extension/src/mc.js');

const ME = ['me@gmail.com'];
const msg = (from, to, cc = '', body = 'Hello\nMC 689501') =>
  parseMessage(`Carrier Guy <${from}>\tMon, Nov 3, 2026 at 9:00 AM\nTo: ${to}\n${cc ? `Cc: ${cc}\n` : ''}\n${body}`);

test('parseMessage reads sender, To and Cc', () => {
  const m = msg('c@carrier.com', 'Me <ME@gmail.com>, x@y.com', 'boss@co.com');
  assert.equal(m.from, 'c@carrier.com');
  assert.deepEqual(m.to, ['me@gmail.com', 'x@y.com']);
  assert.deepEqual(m.cc, ['boss@co.com']);
});

test('solelyToMe: only me in To -> eligible', () => {
  assert.ok(solelyToMe([msg('c@carrier.com', 'me@gmail.com')], ME));
});

test('solelyToMe: other recipients, Cc, or Bcc/undisclosed -> skipped', () => {
  assert.equal(solelyToMe([msg('c@carrier.com', 'me@gmail.com, other@co.com')], ME), null);
  assert.equal(solelyToMe([msg('c@carrier.com', 'me@gmail.com', 'other@co.com')], ME), null);
  assert.equal(solelyToMe([msg('c@carrier.com', 'undisclosed-recipients:;')], ME), null);
  assert.equal(solelyToMe([msg('c@carrier.com', 'list@carrier.com')], ME), null);
});

test('solelyToMe: my own newest reply is skipped, carrier message decides', () => {
  const thread = [msg('me@gmail.com', 'c@carrier.com', '', 'thanks'), msg('c@carrier.com', 'me@gmail.com')];
  const rel = solelyToMe(thread, ME);
  assert.equal(rel.length, 1);
  assert.equal(rel[0].from, 'c@carrier.com');
  assert.equal(solelyToMe([msg('me@gmail.com', 'c@carrier.com')], ME), null);
});

test('solelyToMe: aliases count as me', () => {
  assert.ok(solelyToMe([msg('c@carrier.com', 'me@gmail.com', 'dispatch@me.com')], [...ME, 'dispatch@me.com']));
});
