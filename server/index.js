const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRuntime } = require('./apps-script-runtime');

const projectRoot = path.resolve(__dirname, '..');
const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || '127.0.0.1';
const dataDirectory = process.env.RASPORED_DATA_DIR ||
  path.join(os.homedir(), 'Library', 'Application Support', 'Raspored App');
const databasePath = path.join(dataDirectory, 'raspored.db');

const runtime = createRuntime({
  databasePath,
  appsScriptPath: path.join(projectRoot, 'appscript.gs')
});

function sendJson(response, statusCode, value) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  });
  response.end(JSON.stringify(value));
}

function sendFile(response, filename, contentType) {
  fs.readFile(filename, (error, data) => {
    if (error) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Fajl nije pronađen.');
      return;
    }
    response.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache'
    });
    response.end(data);
  });
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 10 * 1024 * 1024) {
        reject(new Error('API zahtev je prevelik.'));
        request.destroy();
      }
    });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

const server = http.createServer(async (request, response) => {
  if (request.method === 'OPTIONS') {
    sendJson(response, 204, {});
    return;
  }

  const url = new URL(request.url, `http://${request.headers.host || host}`);

  if (request.method === 'GET' && url.pathname === '/') {
    sendFile(response, path.join(projectRoot, 'index.html'), 'text/html; charset=utf-8');
    return;
  }

  if (request.method === 'GET' && url.pathname === '/favicon.ico') {
    response.writeHead(204);
    response.end();
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/health') {
    sendJson(response, 200, {
      ok: true,
      data: {
        status: 'ok',
        version: 'local-1.0.0',
        database: databasePath
      }
    });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api') {
    try {
      const body = JSON.parse(await readBody(request) || '{}');
      if (!Array.isArray(body.args)) {
        throw new Error('API args mora biti niz.');
      }
      const data = runtime.dispatch(body.action, body.args);
      sendJson(response, 200, { ok: true, data });
    } catch (error) {
      console.error(error);
      sendJson(response, 400, {
        ok: false,
        error: error && error.message ? error.message : String(error),
        transient: false
      });
    }
    return;
  }

  sendJson(response, 404, { ok: false, error: 'Ruta nije pronađena.' });
});

server.listen(port, host, () => {
  console.log(`Raspored App: http://${host}:${port}`);
  console.log(`SQLite baza: ${databasePath}`);
});

function shutdown() {
  server.close(() => {
    runtime.close();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
