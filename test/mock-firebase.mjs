// Minimal stand-in for the Firebase Realtime Database REST API (GET/PUT/PATCH/DELETE, multi-path PATCH).
import http from 'node:http';
let root = null;
const parts = (p) => p.split('/').filter(Boolean);
function getAt(path) { let n = root; for (const k of parts(path)) { if (n == null || typeof n !== 'object') return null; n = n[k]; } return n ?? null; }
function prune(n) {
  if (n && typeof n === 'object') { for (const k of Object.keys(n)) { n[k] = prune(n[k]); if (n[k] == null) delete n[k]; } return Object.keys(n).length ? n : null; }
  return n;
}
function setAt(path, val) {
  const ks = parts(path);
  if (!ks.length) { root = prune(structuredClone(val)); return; }
  if (root == null || typeof root !== 'object') root = {};
  let n = root;
  for (const k of ks.slice(0, -1)) { if (n[k] == null || typeof n[k] !== 'object') n[k] = {}; n = n[k]; }
  n[ks.at(-1)] = val == null ? null : structuredClone(val);
  root = prune(root);
}
export function start(port) {
  const srv = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.end();
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname.replace(/\.json$/, ''));
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const val = body ? JSON.parse(body) : null;
      if (req.method === 'PUT') setAt(path, val);
      else if (req.method === 'PATCH') for (const [k, v] of Object.entries(val)) setAt(`${path}/${k}`, v);
      else if (req.method === 'DELETE') setAt(path, null);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(req.method === 'DELETE' ? null : getAt(path)));
    });
  });
  return new Promise((r) => srv.listen(port, () => r(srv)));
}
export const dump = () => root;
if (process.argv[1] === new URL(import.meta.url).pathname) start(Number(process.argv[2] || 9000));
