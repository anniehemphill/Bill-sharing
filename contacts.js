// Parse vCard (.vcf) text — what iPhone Contacts produces via "Share Contact" — into [{name, phone}].
export function parseVCards(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  const out = [];
  let cur = null;
  const unesc = (v) => v.replace(/\\([,;\\])/g, '$1').replace(/\\n/gi, ' ').trim();
  for (const line of lines) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    const key = line.slice(0, i).toUpperCase();
    const val = line.slice(i + 1);
    const prop = key.split(';')[0].replace(/^ITEM\d+\./, '');
    if (prop === 'BEGIN' && /VCARD/i.test(val)) cur = { fn: '', n: '', tels: [] };
    else if (!cur) continue;
    else if (prop === 'END') {
      const name = cur.fn || cur.n;
      const tel = cur.tels.find((t) => t.cell) || cur.tels[0];
      if (name) out.push({ name, phone: tel ? tel.num : '' });
      cur = null;
    } else if (prop === 'FN') cur.fn = unesc(val);
    else if (prop === 'N') {
      const [last, first] = val.split(';').map(unesc);
      cur.n = [first, last].filter(Boolean).join(' ');
    } else if (prop === 'TEL') {
      cur.tels.push({ num: unesc(val.replace(/^tel:/i, '')), cell: /CELL|MOBILE|IPHONE/.test(key) });
    }
  }
  return out;
}
