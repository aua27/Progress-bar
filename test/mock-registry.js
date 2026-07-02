'use strict';

// Minimal in-process npm registry for integration tests. Serves packuments and
// real (gzipped tar) tarballs for a declared fixture tree, with configurable
// per-tarball failures — enough to drive arborist resolve + npmbar's download
// phase + reify entirely against localhost, no external network.

const http = require('http');
const zlib = require('zlib');
const crypto = require('crypto');

// --- Tiny tar writer -------------------------------------------------------
// One POSIX ustar file entry + two zero blocks. Enough for a tarball whose
// only content is package/package.json — node-tar extracts this happily.

function tarHeader(name, size) {
  const buf = Buffer.alloc(512);
  buf.write(name, 0, 100, 'utf8');
  buf.write('0000644\0', 100, 8, 'latin1');   // mode
  buf.write('0000000\0', 108, 8, 'latin1');   // uid
  buf.write('0000000\0', 116, 8, 'latin1');   // gid
  buf.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'latin1');
  buf.write('00000000000\0', 136, 12, 'latin1'); // mtime: epoch, deterministic tarballs
  buf.write('        ', 148, 8, 'latin1');    // chksum placeholder: 8 spaces
  buf.write('0', 156, 1, 'latin1');           // typeflag: regular file
  buf.write('ustar\0', 257, 6, 'latin1');     // magic
  buf.write('00', 263, 2, 'latin1');          // version
  let sum = 0;
  for (const b of buf) sum += b;
  buf.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'latin1');
  return buf;
}

function makeTarball(manifest) {
  const content = Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  const padded = Buffer.alloc(Math.ceil(content.length / 512) * 512);
  content.copy(padded);
  const tar = Buffer.concat([
    tarHeader('package/package.json', content.length),
    padded,
    Buffer.alloc(1024), // end-of-archive
  ]);
  return zlib.gzipSync(tar, { level: 9 });
}

function integrityOf(buf) {
  return 'sha512-' + crypto.createHash('sha512').update(buf).digest('base64');
}

// --- Registry --------------------------------------------------------------
//
// new MockRegistry({
//   packages: {
//     'pkg-a': { '1.0.0': { dependencies: { 'pkg-x': '1.0.0' } } },
//     'pkg-x': { '1.0.0': {}, '2.0.0': {} },
//   },
//   tarballFailures: { 'pkg-x@1.0.0': 404 },  // status code, or 'destroy'
// })
//
// Packuments/tarballs are prebuilt at start(); dist.integrity and dist.size
// are computed from the actual tarball bytes so pacote's integrity check passes.

class MockRegistry {
  constructor({ packages, tarballFailures = {} }) {
    this.spec = packages;
    this.tarballFailures = tarballFailures;
    this.tarballs = new Map();   // 'name@version' -> Buffer
    this.packuments = new Map(); // name -> object (dist.tarball filled at start)
    this.requests = [];          // observed request paths, for assertions
    this.server = null;
    this.url = null;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this._handle(req, res));
      this.server.on('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        const { port } = this.server.address();
        this.url = `http://127.0.0.1:${port}`;
        this._build();
        resolve(this.url);
      });
    });
  }

  stop() {
    return new Promise(resolve => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
      // Keep-alive agents can hold the server open past close(); sever them.
      this.server.closeAllConnections?.();
    });
  }

  _build() {
    for (const [name, versions] of Object.entries(this.spec)) {
      const packument = { name, 'dist-tags': {}, versions: {} };
      let latest = null;
      for (const [version, extra] of Object.entries(versions)) {
        const manifest = { name, version, ...extra };
        const tarball = makeTarball(manifest);
        this.tarballs.set(`${name}@${version}`, tarball);
        packument.versions[version] = {
          ...manifest,
          dist: {
            tarball: `${this.url}/${name}/-/${name}-${version}.tgz`,
            integrity: integrityOf(tarball),
            size: tarball.length,
          },
        };
        latest = version;
      }
      packument['dist-tags'].latest = latest;
      this.packuments.set(name, packument);
    }
  }

  _handle(req, res) {
    this.requests.push(req.url);
    const tarMatch = req.url.match(/^\/(.+)\/-\/\1-(.+)\.tgz$/);
    if (tarMatch) {
      const key = `${tarMatch[1]}@${tarMatch[2]}`;
      const failure = this.tarballFailures[key];
      if (failure === 'destroy') { req.socket.destroy(); return; }
      if (failure) {
        res.writeHead(failure, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: `injected ${failure} for ${key}` }));
        return;
      }
      const tarball = this.tarballs.get(key);
      if (!tarball) {
        res.writeHead(404); res.end('{"error":"tarball not found"}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': tarball.length });
      res.end(tarball);
      return;
    }
    const name = decodeURIComponent(req.url.slice(1).split('?')[0]);
    const packument = this.packuments.get(name);
    if (!packument) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(packument));
  }
}

module.exports = { MockRegistry, makeTarball, integrityOf };
