'use strict';

require('dotenv').config();

const express   = require('express');
const crypto    = require('crypto');
const nodemailer = require('nodemailer');
const { v4: uuidv4 } = require('uuid');
const fs   = require('fs');
const path = require('path');

function getSupabaseKeyRole(key) {
  if (!key || typeof key !== 'string') return 'missing';

  // New Supabase secret keys are prefixed and are safe for server-side usage.
  if (key.startsWith('sb_secret_')) return 'service_role';

  // Legacy keys are JWT-like and may include role in payload.
  const parts = key.split('.');
  if (parts.length === 3) {
    try {
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
      if (payload && typeof payload.role === 'string') return payload.role;
    } catch {
      return 'unknown';
    }
  }

  return 'unknown';
}

// Supabase (optional – falls back to JSON if not configured)
let db_client = null;
let USE_SUPABASE = false;
try {
  if (process.env.SUPABASE_URL && process.env.SUPABASE_KEY) {
    const keyRole = getSupabaseKeyRole(process.env.SUPABASE_KEY);

    if (keyRole === 'service_role' || keyRole === 'unknown') {
      db_client = require('./supabase-client');
      USE_SUPABASE = true;
      console.log('✓ Supabase configured');
    } else {
      console.warn(`⚠ Supabase key role is '${keyRole}', not service_role. Falling back to JSON storage to avoid RLS write failures.`);
    }
  }
} catch (err) {
  console.warn('⚠ Supabase not configured or unavailable, using JSON fallback');
}

const app  = express();
const PORT = Number(process.env.PORT) || 3001;
const FRONTEND_ROOT = path.join(__dirname, '..');
const INDEX_FILE = path.join(FRONTEND_ROOT, 'index.html');
const API_ACCESS_COOKIE = 'pf_access';
const API_ACCESS_TTL_MS = 2 * 60 * 60 * 1000;
const API_ACCESS_SECRET = process.env.API_ACCESS_SECRET || crypto.randomBytes(32).toString('hex');
const IS_SERVERLESS = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.LAMBDA_TASK_ROOT);

// ── Data directory (fallback for JSON storage) ──────────────────────────────
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(__dirname, process.env.DATA_DIR)
  : (IS_SERVERLESS ? path.join('/tmp', 'ksaivinod-data') : path.join(__dirname, '../data'));

if (!USE_SUPABASE) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ── Security middleware ──────────────────────────────────────────────────────
app.set('trust proxy', 1);

// Limit request body to 20 KB
app.use(express.json({ limit: '20kb' }));

// Remove fingerprinting header
app.disable('x-powered-by');

app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  }
  next();
});

// ── Advanced Rate Limiter with Sliding Window ────────────────────────────────
const rateLimitStore = new Map();
const requestFingerprints = new Map();

/** Generate request fingerprint (IP + User-Agent hash) */
function getFingerprint(req) {
  const ip = req.ip || '0.0.0.0';
  const ua = req.get('user-agent') || 'unknown';
  // Simple hash
  let hash = 0;
  for (let i = 0; i < ua.length; i++) {
    hash = ((hash << 5) - hash) + ua.charCodeAt(i);
    hash = hash & hash;
  }
  return `${ip}:${Math.abs(hash)}`;
}

function parseCookies(req) {
  const raw = req.headers.cookie;
  if (!raw) return {};

  return raw.split(';').reduce((cookies, entry) => {
    const index = entry.indexOf('=');
    if (index === -1) return cookies;

    const key = entry.slice(0, index).trim();
    const value = entry.slice(index + 1).trim();
    cookies[key] = decodeURIComponent(value);
    return cookies;
  }, {});
}

function createApiAccessToken(req) {
  const payload = {
    exp: Date.now() + API_ACCESS_TTL_MS,
    fp: getFingerprint(req)
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto
    .createHmac('sha256', API_ACCESS_SECRET)
    .update(encoded)
    .digest('base64url');

  return `${encoded}.${signature}`;
}

function verifyApiAccessToken(token, req) {
  if (!token || typeof token !== 'string') return false;

  const parts = token.split('.');
  if (parts.length !== 2) return false;

  const [encoded, receivedSignature] = parts;
  const expectedSignature = crypto
    .createHmac('sha256', API_ACCESS_SECRET)
    .update(encoded)
    .digest('base64url');

  if (receivedSignature.length !== expectedSignature.length) {
    return false;
  }

  if (!crypto.timingSafeEqual(Buffer.from(receivedSignature), Buffer.from(expectedSignature))) {
    return false;
  }

  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (!payload || typeof payload !== 'object') return false;
    if (payload.exp < Date.now()) return false;
    if (payload.fp !== getFingerprint(req)) return false;
    return true;
  } catch {
    return false;
  }
}

function setApiAccessCookie(req, res, token) {
  const isSecure = req.secure || req.get('x-forwarded-proto') === 'https';
  const cookieParts = [
    `${API_ACCESS_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.floor(API_ACCESS_TTL_MS / 1000)}`
  ];

  if (isSecure) cookieParts.push('Secure');
  res.setHeader('Set-Cookie', cookieParts.join('; '));
}

function requestComesFromSite(req) {
  const host = req.get('host');
  const origin = req.get('origin');
  const referer = req.get('referer');
  const secFetchSite = req.get('sec-fetch-site');

  if (secFetchSite && secFetchSite !== 'same-origin' && secFetchSite !== 'same-site') {
    return false;
  }

  if (origin) {
    try {
      if (new URL(origin).host !== host) return false;
    } catch {
      return false;
    }
  }

  if (referer) {
    try {
      if (new URL(referer).host !== host) return false;
    } catch {
      return false;
    }
  }

  return Boolean(origin || referer || secFetchSite === 'same-origin' || secFetchSite === 'same-site');
}

function requirePageAccess(req, res, next) {
  if (!requestComesFromSite(req)) {
    return res.status(403).json({ error: 'Direct API access is not allowed.' });
  }

  const cookies = parseCookies(req);
  const cookieToken = cookies[API_ACCESS_COOKIE];
  const headerToken = req.get('x-portfolio-access');

  if (!headerToken) {
    return res.status(403).json({ error: 'Missing page access token.' });
  }

  if (cookieToken && cookieToken !== headerToken) {
    return res.status(403).json({ error: 'Mismatched page access token.' });
  }

  if (!verifyApiAccessToken(headerToken, req)) {
    return res.status(403).json({ error: 'Invalid page access token.' });
  }

  return next();
}

function sendIndex(req, res) {
  const cookies = parseCookies(req);
  const existingToken = cookies[API_ACCESS_COOKIE];
  const accessToken = verifyApiAccessToken(existingToken, req)
    ? existingToken
    : createApiAccessToken(req);

  if (existingToken !== accessToken) {
    setApiAccessCookie(req, res, accessToken);
  }

  const html = fs.readFileSync(INDEX_FILE, 'utf-8').replace('__PORTFOLIO_API_TOKEN__', accessToken);
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.set('Cache-Control', 'no-store');
  res.send(html);
}

/**
 * Advanced rate limiter with sliding window and abuse detection
 * @param {string} key - Unique key (route + fingerprint)
 * @param {number} maxHits - Max requests allowed
 * @param {number} windowMs - Time window in milliseconds
 * @returns {{ allowed: boolean, remaining: number, resetIn: number }}
 */
function checkRateLimit(key, maxHits, windowMs) {
  const now = Date.now();
  let entry = rateLimitStore.get(key);

  if (!entry || now > entry.reset) {
    entry = { requests: [], reset: now + windowMs };
  }

  // Remove expired requests
  entry.requests = entry.requests.filter(t => now - t < windowMs);
  
  const allowed = entry.requests.length < maxHits;
  if (allowed) entry.requests.push(now);
  
  rateLimitStore.set(key, entry);

  return {
    allowed,
    remaining: Math.max(0, maxHits - entry.requests.length),
    resetIn: Math.max(0, entry.reset - now)
  };
}

/**
 * Detect potential abuse patterns
 */
function detectAbuse(fingerprint) {
  const abuse = requestFingerprints.get(fingerprint) || { count: 0, firstSeen: Date.now(), flags: 0 };
  const timeSinceFirst = Date.now() - abuse.firstSeen;
  
  // Flag: More than 100 requests in 10 seconds
  if (timeSinceFirst < 10000 && abuse.count > 100) abuse.flags |= 1;
  
  // Flag: Rapid endpoint switching (10+ different endpoints in 5s)
  if (timeSinceFirst < 5000 && abuse.endpoints >= 10) abuse.flags |= 2;
  
  // Clear old entries after 1 hour
  if (timeSinceFirst > 3600000) {
    requestFingerprints.delete(fingerprint);
    return false;
  }
  
  abuse.count++;
  abuse.endpoints = (abuse.endpoints || 0) + 1;
  requestFingerprints.set(fingerprint, abuse);
  
  return (abuse.flags & 3) > 0; // Return true if suspicious
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Strip HTML-dangerous chars and truncate. */
function sanitize(value, maxLen = 500) {
  if (typeof value !== 'string') return '';
  return value.slice(0, maxLen)
    .replace(/[<>"'`]/g, '')
    .replace(/[\x00-\x1F\x7F]/g, ''); // Remove control chars
}

/** Validate email strictly */
function isValidEmail(email) {
  if (!email || typeof email !== 'string' || email.length > 254) return false;
  // RFC 5322 simplified
  return /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/.test(email);
}

/** Validate session ID format */
function isValidSessionId(sessionId) {
  if (!sessionId || typeof sessionId !== 'string') return false;
  if (sessionId.length < 8 || sessionId.length > 64) return false;
  // Only alphanumeric, dash, underscore
  return /^[a-zA-Z0-9_-]+$/.test(sessionId);
}

/** Validate visited sections */
function isValidSectionArray(sections) {
  if (!Array.isArray(sections)) return false;
  if (sections.length > 20) return false; // Max 20 sections
  const valid = ['world', 'quests', 'treasures', 'inventory', 'guild'];
  return sections.every(s => valid.includes(s));
}

/** Read a JSON file from DATA_DIR; returns {} if missing or unreadable. */
function readJson(filename) {
  const filepath = path.join(DATA_DIR, filename);
  try {
    return JSON.parse(fs.readFileSync(filepath, 'utf-8'));
  } catch {
    return {};
  }
}

/** Atomically write a JSON file to DATA_DIR. */
function writeJson(filename, data) {
  const filepath = path.join(DATA_DIR, filename);
  const tmp = filepath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmp, filepath);
}

/** Log security events */
function logSecurityEvent(event, details) {
  console.warn(`[SEC] ${event}:`, details);
}

const initializationPromise = (async () => {
  if (!USE_SUPABASE) return;

  try {
    await db_client.initializeDatabase();
  } catch (err) {
    console.warn('⚠ Database initialization error:', err.message);
  }
})();

app.use(async (_req, _res, next) => {
  await initializationPromise;
  next();
});

// ── Routes ───────────────────────────────────────────────────────────────────

app.get('/', sendIndex);
app.get('/index.html', sendIndex);

// Health check
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.use('/api', requirePageAccess);

// ── POST /api/progress ────────────────────────────────────────────────────────
// Supports both individual progress updates and bulk batch updates
app.post('/api/progress', async (req, res) => {
  const fingerprint = getFingerprint(req);
  
  // Detect abuse patterns
  if (detectAbuse(fingerprint)) {
    logSecurityEvent('ABUSE_DETECTED', { fingerprint });
    return res.status(429).json({ error: 'Suspicious activity detected. Please try again later.' });
  }

  // Rate limit: 100 requests per minute per fingerprint
  const rateCheck = checkRateLimit(`progress:${fingerprint}`, 100, 60_000);
  if (!rateCheck.allowed) {
    return res.status(429).json({ 
      error: 'Rate limit exceeded',
      resetIn: rateCheck.resetIn 
    });
  }

  const { sessionId, xp, level, visitedSections, rewardUnlocked, batch } = req.body;

  // Handle batch updates (array of progress objects)
  if (batch && Array.isArray(batch)) {
    if (batch.length > 50) {
      return res.status(400).json({ error: 'Batch size exceeds 50 items' });
    }

    try {
      const results = [];
      for (const item of batch) {
        if (!isValidSessionId(item.sessionId)) {
          results.push({ sessionId: item.sessionId, ok: false, error: 'Invalid session ID' });
          continue;
        }

        const sessionData = {
          sessionId: sanitize(item.sessionId, 64),
          xp: Math.max(0, Math.min(Number(item.xp) || 100, 10_000)),
          level: Math.max(1, Math.min(Number(item.level) || 1, 10)),
          rewardUnlocked: Boolean(item.rewardUnlocked),
          visitedSections: isValidSectionArray(item.visitedSections) ? item.visitedSections : []
        };

        try {
          if (USE_SUPABASE) {
            await db_client.saveSession(sessionData);
          } else {
            const db = readJson('progress.json');
            db.sessions = db.sessions || {};
            db.sessions[sessionData.sessionId] = {
              ...sessionData,
              updatedAt: new Date().toISOString()
            };
            writeJson('progress.json', db);
          }
          results.push({ sessionId: item.sessionId, ok: true });
        } catch (err) {
          results.push({ sessionId: item.sessionId, ok: false, error: err.message });
        }
      }

      return res.json({ ok: true, batch: results });
    } catch (err) {
      console.error('[batch progress]', err);
      return res.status(500).json({ error: 'Batch processing failed' });
    }
  }

  // Single update
  if (!isValidSessionId(sessionId)) {
    return res.status(400).json({ error: 'Invalid session ID' });
  }

  if (!isValidSectionArray(visitedSections)) {
    return res.status(400).json({ error: 'Invalid visited sections' });
  }

  const sessionData = {
    sessionId: sanitize(sessionId, 64),
    xp: Math.max(0, Math.min(Number(xp) || 100, 10_000)),
    level: Math.max(1, Math.min(Number(level) || 1, 10)),
    rewardUnlocked: Boolean(rewardUnlocked),
    visitedSections: visitedSections || []
  };

  try {
    if (USE_SUPABASE) {
      await db_client.saveSession(sessionData);
    } else {
      const db = readJson('progress.json');
      db.sessions = db.sessions || {};
      db.sessions[sessionData.sessionId] = {
        ...sessionData,
        updatedAt: new Date().toISOString()
      };
      writeJson('progress.json', db);
    }
    return res.json({ ok: true });
  } catch (err) {
    console.error('[progress save]', err);
    return res.status(500).json({ error: 'Failed to save progress' });
  }
});

// ── GET /api/progress/:sessionId ──────────────────────────────────────────────
app.get('/api/progress/:sessionId', async (req, res) => {
  const fingerprint = getFingerprint(req);
  
  // Rate limit: 200 reads per minute per fingerprint
  const rateCheck = checkRateLimit(`progress:read:${fingerprint}`, 200, 60_000);
  if (!rateCheck.allowed) {
    return res.status(429).json({ 
      error: 'Rate limit exceeded',
      resetIn: rateCheck.resetIn 
    });
  }

  const { sessionId } = req.params;
  if (!isValidSessionId(sessionId)) {
    return res.status(400).json({ error: 'Invalid session ID format' });
  }

  try {
    const cleanId = sanitize(sessionId, 64);
    let session = null;

    if (USE_SUPABASE) {
      session = await db_client.getSession(cleanId);
    } else {
      const db = readJson('progress.json');
      session = db.sessions?.[cleanId];
    }

    if (!session) return res.status(404).json({ error: 'Session not found' });
    return res.json(session);
  } catch (err) {
    console.error('[progress get]', err);
    return res.status(500).json({ error: 'Failed to retrieve progress' });
  }
});

// ── POST /api/contact ─────────────────────────────────────────────────────────
app.post('/api/contact', async (req, res) => {
  const fingerprint = getFingerprint(req);
  
  // Detect abuse
  if (detectAbuse(fingerprint)) {
    logSecurityEvent('CONTACT_ABUSE', { fingerprint });
    return res.status(429).json({ error: 'Suspicious activity. Request denied.' });
  }

  // ⚠️ STRICT RATE LIMIT for email sending: 5 per day per fingerprint (per IP + User-Agent)
  const emailRateCheck = checkRateLimit(`contact:email:${fingerprint}`, 5, 86_400_000);
  if (!emailRateCheck.allowed) {
    logSecurityEvent('EMAIL_RATE_LIMIT_EXCEEDED', { fingerprint });
    return res.status(429).json({ 
      error: 'Too many contact submissions. Please try again tomorrow.',
      resetIn: emailRateCheck.resetIn 
    });
  }

  // Save-only rate limit: 5 per hour per fingerprint (for testing)
  const saveRateCheck = checkRateLimit(`contact:save:${fingerprint}`, 5, 3_600_000);
  if (!saveRateCheck.allowed) {
    return res.status(429).json({ 
      error: 'Rate limit exceeded',
      resetIn: saveRateCheck.resetIn 
    });
  }

  const { name, email, subject, message, sessionId, _hp } = req.body;

  // Honeypot – bots typically fill hidden fields
  if (_hp) {
    logSecurityEvent('HONEYPOT_TRIGGERED', { fingerprint });
    return res.status(200).json({ ok: true }); // silent discard
  }

  // Validate all inputs
  const cleanName    = sanitize(name, 100);
  const cleanEmail   = sanitize(email, 254);
  const cleanSubject = sanitize(subject || 'Portfolio Contact', 200);
  const cleanMessage = sanitize(message, 5000);
  const cleanSession = isValidSessionId(sessionId) ? sanitize(sessionId, 64) : '';

  if (!cleanName || cleanName.length < 2) {
    return res.status(400).json({ error: 'Name is required (min 2 chars).' });
  }
  
  if (!cleanEmail || !isValidEmail(cleanEmail)) {
    return res.status(400).json({ error: 'Valid email is required.' });
  }
  
  if (!cleanMessage || cleanMessage.length < 5) {
    return res.status(400).json({ error: 'Message is required (min 5 chars).' });
  }

  // Check for spam patterns (repeated words, excessive caps)
  const wordCount = cleanMessage.split(/\s+/).length;
  const capsCount = (cleanMessage.match(/[A-Z]/g) || []).length;
  if (wordCount < 2 || (capsCount / Math.max(1, cleanMessage.length) > 0.5)) {
    logSecurityEvent('SPAM_PATTERN_DETECTED', { fingerprint, wordCount, capsCount });
    return res.status(400).json({ error: 'Message looks like spam. Please try again.' });
  }

  const ip = req.ip || '0.0.0.0';
  const userAgent = req.get('user-agent') || 'unknown';

  try {
    // Save submission to database
    const submissionData = {
      sessionId: cleanSession,
      name: cleanName,
      email: cleanEmail,
      message: cleanMessage,
      userAgent,
      ipAddress: ip
    };

    if (USE_SUPABASE) {
      await db_client.saveContactSubmission(submissionData);
    } else {
      const db = readJson('contact-submissions.json');
      db.submissions = db.submissions || [];
      db.submissions.push({
        id: uuidv4(),
        ...submissionData,
        submittedAt: new Date().toISOString()
      });
      writeJson('contact-submissions.json', db);
    }

    console.log(`[contact] Saved: ${cleanEmail} from ${cleanSession || ip}`);
  } catch (err) {
    console.error('[contact save]', err);
    return res.status(500).json({ error: 'Failed to save submission' });
  }

  // Send email (non-blocking)
  if (process.env.SMTP_USER && process.env.SMTP_PASS) {
    (async () => {
      try {
        const transporter = nodemailer.createTransport({
          host  : process.env.SMTP_HOST || 'smtp.gmail.com',
          port  : Number(process.env.SMTP_PORT) || 587,
          secure: false,
          auth  : {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS
          },
          connectionTimeout: 5000,
          socketTimeout: 5000
        });

        const htmlBody = `
          <div style="font-family:monospace;max-width:600px;background:#0a0a12;color:#e0e0ff;padding:24px;border:1px solid #2a2a4a;border-radius:4px">
            <h2 style="color:#00f5c4;font-size:14px;letter-spacing:2px;margin:0 0 16px">⚡ NEW PORTFOLIO CONTACT</h2>
            <table style="width:100%;border-collapse:collapse;font-size:13px">
              <tr><td style="color:#8080b0;padding:6px 0;width:80px;vertical-align:top">FROM</td><td style="color:#fff;padding:6px 0">${cleanName}</td></tr>
              <tr><td style="color:#8080b0;padding:6px 0;vertical-align:top">EMAIL</td><td style="padding:6px 0"><a href="mailto:${cleanEmail}" style="color:#00f5c4">${cleanEmail}</a></td></tr>
              <tr><td style="color:#8080b0;padding:6px 0;vertical-align:top">SUBJECT</td><td style="color:#fff;padding:6px 0">${cleanSubject}</td></tr>
              <tr><td style="color:#8080b0;padding:6px 0;vertical-align:top">TIME</td><td style="color:#fff;padding:6px 0">${new Date().toISOString()}</td></tr>
            </table>
            <div style="margin-top:16px;padding:16px;background:#13131f;border-left:3px solid #00f5c4;border-radius:2px">
              <p style="color:#8080b0;font-size:10px;margin:0 0 8px;letter-spacing:2px">MESSAGE</p>
              <p style="color:#e0e0ff;white-space:pre-wrap;font-size:14px;margin:0">${cleanMessage}</p>
            </div>
            <p style="color:#666;font-size:10px;margin-top:16px;padding-top:16px;border-top:1px solid #2a2a4a">Session: ${cleanSession || 'anonymous'} | IP: ${ip}</p>
          </div>
        `;

        await transporter.sendMail({
          from   : `"Sai Vinod Portfolio" <${process.env.SMTP_USER}>`,
          to     : process.env.CONTACT_RECIPIENT || process.env.SMTP_USER,
          replyTo: cleanEmail,
          subject: `[Portfolio] ${cleanSubject} — from ${cleanName}`,
          text   : `Name: ${cleanName}\nEmail: ${cleanEmail}\nSubject: ${cleanSubject}\n\n${cleanMessage}`,
          html   : htmlBody,
          priority: 'high'
        });

        console.log(`[email sent] to ${cleanEmail}`);
      } catch (err) {
        console.error('[email error]', err.message);
      }
    })();
  }

  return res.json({ 
    ok: true, 
    message: 'Message received! I will get back to you soon.',
    remaining: emailRateCheck.remaining 
  });
});

// ── Serve static files ────────────────────────────────────────────────────────
// Must come before catch-all route to serve assets like animData.json
app.use('/assets', express.static(path.join(FRONTEND_ROOT, 'assets'), {
  maxAge: '7d',
  etag: false
}));

app.use(express.static(FRONTEND_ROOT, {
  maxAge: '1d',
  etag: false,
  setHeaders: (res, path) => {
    // JSON files should not be cached
    if (path.endsWith('.json')) {
      res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  }
}));

app.get(/^\/(?!api\/|health$|_vercel\/).*/, sendIndex);

// ── 404 fallback ──────────────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

module.exports = app;

// ── Start ─────────────────────────────────────────────────────────────────────
if (require.main === module) {
  initializationPromise
    .then(() => {
      app.listen(PORT, () => {
        console.log(`Portfolio server listening on port ${PORT} | Storage: ${USE_SUPABASE ? 'Supabase' : 'JSON'}`);
      });
    })
    .catch(err => {
      console.error('Failed to start:', err);
      process.exit(1);
    });
}
