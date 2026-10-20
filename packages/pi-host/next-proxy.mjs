import http from 'node:http';
import { UI_PORT, requestPolicy } from './security.mjs';
const policy = requestPolicy();

export function nextPage(req, res) {
  const upstream = http.request({hostname:'127.0.0.1', port:UI_PORT, path:req.url,
    method:req.method, headers:{...req.headers, 'x-forwarded-proto':policy.protocol(req.headers.host)}}, incoming => {
    const headers = {...incoming.headers};
    delete headers['content-security-policy'];
    res.writeHead(incoming.statusCode ?? 502, headers);
    incoming.pipe(res);
  });
  upstream.on('error', () => { if (!res.headersSent) res.writeHead(503, {'content-type':'text/plain'}); res.end('The interface is restarting. Refresh in a moment.'); });
  req.on('aborted', () => upstream.destroy());
  req.pipe(upstream);
}

export function attachNextUpgrade(server, authorised) {
  server.on('upgrade', (req, socket, head) => {
    if (!authorised(req) || !req.url?.startsWith('/_next/')) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    const upstream = http.request({hostname:'127.0.0.1', port:UI_PORT, path:req.url,
      method:'GET', headers:req.headers});
    upstream.on('upgrade', (res, remote, buffer) => {
      socket.write(`HTTP/1.1 ${res.statusCode} Switching Protocols\r\n`);
      for (const [key,value] of Object.entries(res.headers)) socket.write(`${key}: ${value}\r\n`);
      socket.write('\r\n');
      if (head.length) remote.write(head);
      if (buffer.length) socket.write(buffer);
      remote.pipe(socket); socket.pipe(remote);
      remote.on('error', () => socket.destroy()); socket.on('error', () => remote.destroy());
      socket.on('close', () => remote.destroy());
    });
    upstream.on('error', () => socket.destroy());
    upstream.on('response', () => socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'));
    upstream.end();
  });
}
