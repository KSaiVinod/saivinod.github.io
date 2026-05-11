import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { extname, join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const publicDir = __dirname;
const dataDir = join(__dirname, 'data');
const progressFile = join(dataDir, 'progress.json');
const inboxFile = join(dataDir, 'contact-submissions.json');
const PORT = Number(process.env.PORT || 3000);
const MAX_BODY_BYTES = 200000;
const MAX_PROGRESS_LIST_LENGTH = 200;
const EMAIL_ERROR_MESSAGE_LIMIT = 200;
const MAX_SESSION_XP = 4200;
const PUBLIC_DIR_RESOLVED = resolve(publicDir);
let writeQueue = Promise.resolve();

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

async function ensureData() {
  await mkdir(dataDir, { recursive: true });
  if (!existsSync(progressFile)) {
    await writeFile(progressFile, JSON.stringify({ sessions: {} }, null, 2), 'utf8');
  }
  if (!existsSync(inboxFile)) {
    await writeFile(inboxFile, JSON.stringify({ submissions: [] }, null, 2), 'utf8');
  }
}

async function readJson(filePath, fallback) {
  try {
    const raw = await readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, value) {
  await writeFile(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function enqueueWrite(task) {
  writeQueue = writeQueue.catch(() => undefined).then(task);
  return writeQueue;
}

function sendJson(res, code, payload) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(payload));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      if (body.length + chunk.length > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error('payload_too_large'));
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('invalid_json'));
      }
    });
    req.on('error', reject);
  });
}

async function sendContactEmail(payload) {
  const apiKey = process.env.RESEND_API_KEY;
  const toEmail = process.env.CONTACT_TO_EMAIL;
  const fromEmail = process.env.CONTACT_FROM_EMAIL || 'onboarding@resend.dev';

  if (!apiKey || !toEmail) return { delivered: false, reason: 'email_not_configured' };

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: fromEmail,
      to: [toEmail],
      subject: `[Portfolio Quest] Message from ${payload.name}`,
      reply_to: payload.email,
      text: [
        `Name: ${payload.name}`,
        `Email: ${payload.email}`,
        `Level: ${payload.level}`,
        `XP: ${payload.xp}`,
        `Session: ${payload.sessionId}`,
        '',
        payload.message
      ].join('\n')
    })
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`email_send_failed:${details.slice(0, EMAIL_ERROR_MESSAGE_LIMIT)}`);
  }

  return { delivered: true };
}

function sanitizeProgress(body) {
  const list = (arr) => Array.isArray(arr) ? arr.slice(0, MAX_PROGRESS_LIST_LENGTH).map(String) : [];
  const xp = Number.isFinite(Number(body.xp)) ? Math.max(0, Math.min(Number(body.xp), MAX_SESSION_XP)) : 0;
  const level = Number.isFinite(Number(body.level)) ? Math.max(1, Math.min(Number(body.level), 10)) : 1;
  const skillClicks = Number.isFinite(Number(body.skillClicks)) ? Math.max(0, Math.min(Number(body.skillClicks), 500)) : 0;
  return {
    sessionId: String(body.sessionId || '').slice(0, 120),
    xp,
    level,
    rewardUnlocked: Boolean(body.rewardUnlocked),
    skillClicks,
    visitedSections: list(body.visitedSections),
    openedQuests: list(body.openedQuests),
    openedProjects: list(body.openedProjects),
    foundRunes: list(body.foundRunes),
    updatedAt: new Date().toISOString()
  };
}

function sanitizeMessage(body) {
  return {
    name: String(body.name || '').trim().slice(0, 120),
    email: String(body.email || '').trim().slice(0, 200),
    message: String(body.message || '').trim().slice(0, 5000),
    level: Number.isFinite(Number(body.level)) ? Number(body.level) : 0,
    xp: Number.isFinite(Number(body.xp)) ? Number(body.xp) : 0,
    sessionId: String(body.sessionId || '').trim().slice(0, 120)
  };
}

function serveStatic(pathname, res) {
  let path = pathname === '/' ? '/index.html' : pathname;
  try {
    path = decodeURIComponent(path);
  } catch {
    sendJson(res, 400, { error: 'invalid_path' });
    return;
  }
  if (path.includes('\0') || path.includes('..')) {
    sendJson(res, 403, { error: 'forbidden' });
    return;
  }
  const relativePath = path.replace(/^\/+/, '');
  const filePath = resolve(publicDir, relativePath);
  if (!filePath.startsWith(`${PUBLIC_DIR_RESOLVED}/`) && filePath !== PUBLIC_DIR_RESOLVED) {
    sendJson(res, 403, { error: 'forbidden' });
    return;
  }
  const extension = extname(filePath).toLowerCase();

  if (!existsSync(filePath)) {
    sendJson(res, 404, { error: 'not_found' });
    return;
  }

  res.writeHead(200, {
    'Content-Type': mimeTypes[extension] || 'application/octet-stream',
    'Cache-Control': extension === '.html' ? 'no-store' : 'public, max-age=3600'
  });
  createReadStream(filePath).pipe(res);
}

await ensureData();

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === '/api/progress' && req.method === 'GET') {
      const sessionId = String(url.searchParams.get('sessionId') || '').trim();
      if (!sessionId) return sendJson(res, 400, { error: 'sessionId_required' });
      const db = await readJson(progressFile, { sessions: {} });
      return sendJson(res, 200, { progress: db.sessions[sessionId] || null });
    }

    if (url.pathname === '/api/progress' && req.method === 'POST') {
      const body = await parseBody(req);
      const progress = sanitizeProgress(body);
      if (!progress.sessionId) return sendJson(res, 400, { error: 'sessionId_required' });

      await enqueueWrite(async () => {
        const db = await readJson(progressFile, { sessions: {} });
        db.sessions[progress.sessionId] = progress;
        await writeJson(progressFile, db);
      });
      return sendJson(res, 200, { ok: true, progress });
    }

    if (url.pathname === '/api/contact' && req.method === 'POST') {
      const body = await parseBody(req);
      const payload = sanitizeMessage(body);
      if (!payload.name || !payload.email || !payload.message) {
        return sendJson(res, 400, { error: 'missing_required_fields' });
      }

      await enqueueWrite(async () => {
        const inbox = await readJson(inboxFile, { submissions: [] });
        inbox.submissions.push({ ...payload, createdAt: new Date().toISOString() });
        await writeJson(inboxFile, inbox);
      });

      let emailState = { delivered: false, reason: 'email_not_configured' };
      try {
        emailState = await sendContactEmail(payload);
      } catch (err) {
        emailState = { delivered: false, reason: err.message };
      }

      return sendJson(res, 200, { ok: true, email: emailState });
    }

    if (url.pathname.startsWith('/api/')) {
      return sendJson(res, 404, { error: 'api_route_not_found' });
    }

    serveStatic(url.pathname, res);
  } catch (err) {
    sendJson(res, 500, { error: 'internal_error', message: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
