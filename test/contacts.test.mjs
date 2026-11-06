import assert from 'node:assert/strict';
import test from 'node:test';
import { parseVCards } from '../contacts.js';

test('parses iPhone vCards, prefers mobile number', () => {
  const vcf = `BEGIN:VCARD\r\nVERSION:3.0\r\nN:Nkosi;Thandi;;;\r\nFN:Thandi Nkosi\r\nitem1.TEL;type=HOME;type=VOICE:011 555 0000\r\nTEL;type=CELL;type=VOICE;type=pref:+27 82 555 1234\r\nEND:VCARD\r\nBEGIN:VCARD\r\nVERSION:3.0\r\nN:van der Merwe;Pieter;;;\r\nTEL;type=IPHONE:083 111 2222\r\nEND:VCARD\r\n`;
  assert.deepEqual(parseVCards(vcf), [
    { name: 'Thandi Nkosi', phone: '+27 82 555 1234' },
    { name: 'Pieter van der Merwe', phone: '083 111 2222' },
  ]);
});
