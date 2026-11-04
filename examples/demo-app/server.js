import http from 'node:http';
import fs from 'node:fs';
import { validateSignup } from './validate.js';

const page = () => fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/signup') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const data = Object.fromEntries(new URLSearchParams(body));
      const errors = validateSignup(data);
      res.writeHead(errors.length ? 400 : 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(errors.length ? { ok: false, errors } : { ok: true, welcome: data.name }));
    });
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(page());
});

const port = Number(process.env.PORT || 3000);
server.listen(port, () => console.log(`acme-signup on http://localhost:${port}`));
