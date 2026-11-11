const test = require('node:test');
const assert = require('node:assert/strict');
const { extractCarriers, normName } = require('../extension/src/dat-extract.js');

// Shaped like a DAT One GraphQL search response (exact schema unknown; the
// extractor must not depend on it).
const RESPONSE = {
  data: {
    freightSearch: {
      __typename: 'SearchResults',
      totalCount: 3,
      results: [
        {
          __typename: 'Match',
          id: 'a1',
          origin: { city: 'Grove City', stateProv: 'OH' },
          posterInfo: {
            companyName: 'Matrix Logistics Inc',
            contact: { phoneNumber: '(708) 351-7448', email: null },
            city: 'Schaumburg',
          },
          posterDotIds: { brokerMcNumber: null, carrierMcNumber: 108527, dotNumber: 3157032 },
        },
        {
          id: 'a2',
          origin: { city: 'Lexington', stateProv: 'KY' },
          posterInfo: { companyName: 'Alenkos Express Llc', contact: { phoneNumber: '8592215295' } },
          posterDotIds: { brokerMcNumber: null, carrierMcNumber: '0987654', dotNumber: 1 },
        },
        {
          id: 'a3',
          posterInfo: { companyName: 'Broker Only Co', contact: { email: 'ops@broker.com' } },
          posterDotIds: { brokerMcNumber: 555555, carrierMcNumber: null, dotNumber: 2 },
        },
      ],
    },
  },
};

test('extracts one carrier per posting with MC, name and contacts', () => {
  const c = extractCarriers(RESPONSE);
  assert.equal(c.length, 2);
  assert.equal(c[0].mc, '108527');
  assert.deepEqual(c[0].names, ['MATRIX LOGISTICS INC']);
  assert.ok(c[0].contacts.includes('7083517448'));
  assert.equal(c[1].mc, '987654');
  assert.deepEqual(c[1].names, ['ALENKOS EXPRESS LLC']);
});

test('ignores broker MC numbers and city names', () => {
  const c = extractCarriers(RESPONSE);
  assert.ok(!c.some((x) => x.mc === '555555'));
  assert.ok(!c[0].names.includes('SCHAUMBURG'));
});

test('handles other shapes: flat mcNumber, nested arrays, no array at all', () => {
  assert.deepEqual(
    extractCarriers([{ carrierName: 'X LLC', mcNumber: 'MC-123456' }]).map((x) => [x.mc, x.names[0]]),
    [['123456', 'X LLC']]
  );
  const single = extractCarriers({ carrier: { name: 'Solo Inc', carrierMcNumber: 777777 } });
  assert.equal(single[0].mc, '777777');
});

test('returns nothing for unrelated JSON', () => {
  assert.deepEqual(extractCarriers({ data: { user: { name: 'Kenny', id: 5 } } }), []);
});

test('normName makes on-screen and API names comparable', () => {
  assert.equal(normName('Matrix Logistics, Inc.'), normName('MATRIX LOGISTICS INC'));
});
