import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { extname, join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = __dirname;
const dataDir = join(__dirname, 'data');
const progressFile = join(dataDir, 'progress.json');
const inboxFile = join(dataDir, 'contact-submissions.json');
const cmsFile = join(dataDir, 'cms.json');

const PORT = Number(process.env.PORT || 3000);
const MAX_BODY_BYTES = 200000;
const MAX_PROGRESS_LIST_LENGTH = 200;
const MAX_SESSION_XP = 4200;
const ROOT_DIR_RESOLVED = resolve(rootDir);

const ADMIN_USERNAME = String(process.env.ADMIN_USERNAME || '').trim();
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || '').trim();
const VALID_THEMES = ['c1', 'c2', 'c3', 'c4'];
const ADMIN_SESSION_COOKIE = 'sv_admin_session';
const ADMIN_SESSION_TTL_SECONDS = 60 * 60 * 8;

const adminSessions = new Map();
let writeQueue = Promise.resolve();

const defaultCmsData = {
  profile: {
    activeQuest: 'SDE @ FYNO',
    exploring: 'LLM / REACT NATIVE'
  },
  experiences: [
    {
      id: 'exp-fyno',
      icon: '⚡',
      company: 'FYNO',
      role: 'Software Development Engineer',
      location: 'Bengaluru',
      start: 'AUG 2022',
      end: 'PRESENT',
      status: 'active',
      xpText: '+1400 XP EARNED',
      bullets: [
        'Built socket-based notification system guaranteeing message deliverability',
        'Developed mobile SDKs with custom push rendering and richer provider integrations'
      ]
    },
    {
      id: 'exp-hirect',
      icon: '🔍',
      company: 'HIRECT INDIA',
      role: 'Senior Software Developer',
      location: 'Bengaluru',
      start: 'JUN 2022',
      end: 'AUG 2022',
      status: 'done',
      xpText: '+300 XP EARNED',
      bullets: [
        'Designed REST endpoints for jobs and candidate search with filtering and pagination',
        'Revamped website performance and improved Core Web Vitals'
      ]
    },
    {
      id: 'exp-factset',
      icon: '📊',
      company: 'FACTSET RESEARCH SYSTEMS',
      role: 'Software Engineer III',
      location: 'Hyderabad',
      start: 'APR 2021',
      end: 'JUN 2022',
      status: 'done',
      xpText: '+900 XP EARNED',
      bullets: [
        'Rebuilt application UIs to accessibility standards',
        'Delivered charting experiences with live data streams for enterprise clients'
      ]
    },
    {
      id: 'exp-actifio',
      icon: '☁️',
      company: 'ACTIFIO (GOOGLE CLOUD)',
      role: 'Lead Software Engineer',
      location: 'Hyderabad',
      start: 'JUN 2019',
      end: 'APR 2021',
      status: 'done',
      xpText: '+1200 XP EARNED',
      bullets: [
        'Built reusable lazy-load data grid with search/sort/multi-select adopted app-wide',
        'Delivered on-demand backup features for cloud backup and DR workflows'
      ]
    },
    {
      id: 'exp-tcs',
      icon: '🏦',
      company: 'TCS · ICICI BANK',
      role: 'Systems Engineer',
      location: 'Hyderabad',
      start: 'JUL 2017',
      end: 'JUN 2019',
      status: 'done',
      xpText: '+1200 XP EARNED',
      bullets: [
        'Worked on UPI and UPI 2.0 product capabilities with NPCI integrations',
        'Implemented Video KYC and remittance improvements for fintech applications'
      ]
    },
    {
      id: 'exp-darwinbox',
      icon: '🌱',
      company: 'DARWINBOX',
      role: 'Frontend Intern',
      location: 'Hyderabad',
      start: 'AUG 2016',
      end: 'JAN 2017',
      status: 'done',
      xpText: '+500 XP EARNED',
      bullets: [
        'Built auto-invoicing module for pay-as-you-go SaaS billing',
        'Developed and launched the initial Darwinbox marketing website'
      ]
    }
  ],
  projects: [
    {
      id: 'ownhook',
      theme: 'c1',
      icon: '🪝',
      name: 'OWNHOOK',
      type: 'DEVELOPER TOOL · SAAS',
      summary: 'All-in-one webhook testing platform with live payload inspection and custom responders.',
      tags: ['WEBSOCKETS', 'MOCK API', 'REAL-TIME', 'NODE.JS'],
      date: '2025 — APR 2026',
      modalPre: '// LEGENDARY ITEM',
      modalSub: 'WEBHOOK TESTING PLATFORM · DEVELOPER TOOL',
      modalBody: 'The all-in-one webhook testing and debugging platform with unlimited personal endpoints, forwarding rules, and mock APIs.',
      modalStatus: 'COMPLETED',
      modalXp: '+800 XP',
      color: '#00f5c4'
    },
    {
      id: 'meshcall',
      theme: 'c3',
      icon: '📡',
      name: 'MESHCALL',
      type: 'P2P · WEBRTC APP',
      summary: 'Peer-to-peer calling and messaging for high-congestion environments.',
      tags: ['WEBRTC', 'P2P MESH', 'OFFLINE-FIRST'],
      date: '2024 — JUN 2025',
      modalPre: '// EPIC ITEM',
      modalSub: 'P2P CALLING & MESSAGING APP · WEBRTC',
      modalBody: 'A WebRTC-powered peer-to-peer app designed for weak-network scenarios and dense event environments.',
      modalStatus: 'COMPLETED',
      modalXp: '+900 XP',
      color: '#a855f7'
    },
    {
      id: 'biolinks',
      theme: 'c2',
      icon: '🔗',
      name: 'BIOLINKS',
      type: 'OPEN SOURCE · LINK PLATFORM',
      summary: 'Open-source link platform with rich theming and social embeds.',
      tags: ['OPEN SOURCE', 'SPOTIFY API', 'YOUTUBE API', 'CSS THEMES'],
      date: 'AUG 2020',
      modalPre: '// RARE ITEM · OPEN SOURCE',
      modalSub: 'OPEN SOURCE LINK PLATFORM · FULL CUSTOMIZATION',
      modalBody: 'A full-featured open-source alternative to popular bio link tools with deep customization and analytics.',
      modalStatus: 'ARCHIVED · 2020',
      modalXp: '+600 XP',
      color: '#ff6b35'
    },
    {
      id: 'kakeibo',
      theme: 'c4',
      icon: '💴',
      name: 'KAKEIBO MM',
      type: 'FINTECH · EXPENSE MANAGER',
      summary: 'Expense management app inspired by Japanese kakeibo budgeting principles.',
      tags: ['REACT', 'NODE.JS', 'BUDGETING'],
      date: 'AUG 2021 — FEB 2022',
      modalPre: '// UNCOMMON ITEM',
      modalSub: 'EXPENSE MANAGER · JAPANESE BUDGETING',
      modalBody: 'An expense tracking application with reminders, trend analysis, and category-aware budgeting workflows.',
      modalStatus: 'COMPLETED · FEB 2022',
      modalXp: '+500 XP',
      color: '#ffd700'
    }
  ]
};

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

function sanitizeString(value, max = 300) {
  return String(value || '').trim().slice(0, max);
}

function sanitizeStringList(value, maxItems = 12, maxEach = 80) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, maxItems).map((item) => sanitizeString(item, maxEach)).filter(Boolean);
}

function sanitizeCmsProfile(profile) {
  const source = profile && typeof profile === 'object' ? profile : {};
  return {
    activeQuest: sanitizeString(source.activeQuest, 120),
    exploring: sanitizeString(source.exploring, 120)
  };
}

function sanitizeExperienceItem(item, index) {
  const source = item && typeof item === 'object' ? item : {};
  const idRaw = sanitizeString(source.id || `exp-${index + 1}`, 80).replace(/[^a-zA-Z0-9_-]/g, '-');
  const status = sanitizeString(source.status || 'done', 20).toLowerCase() === 'active' ? 'active' : 'done';
  return {
    id: idRaw || `exp-${index + 1}`,
    icon: sanitizeString(source.icon || '⚡', 10),
    company: sanitizeString(source.company, 120),
    role: sanitizeString(source.role, 140),
    location: sanitizeString(source.location, 120),
    start: sanitizeString(source.start, 40),
    end: sanitizeString(source.end, 40),
    status,
    xpText: sanitizeString(source.xpText, 60),
    bullets: sanitizeStringList(source.bullets, 10, 240)
  };
}

function sanitizeProjectItem(item, index) {
  const source = item && typeof item === 'object' ? item : {};
  const idRaw = sanitizeString(source.id || `project-${index + 1}`, 80).replace(/[^a-zA-Z0-9_-]/g, '-');
  const themeRaw = sanitizeString(source.theme || 'c1', 10).toLowerCase().replace(/[^a-z0-9]/g, '');
  const theme = VALID_THEMES.includes(themeRaw) ? themeRaw : 'c1';
  const color = sanitizeString(source.color || '#00f5c4', 16);
  return {
    id: idRaw || `project-${index + 1}`,
    theme,
    icon: sanitizeString(source.icon || '🧩', 10),
    name: sanitizeString(source.name, 120),
    type: sanitizeString(source.type, 120),
    summary: sanitizeString(source.summary, 400),
    tags: sanitizeStringList(source.tags, 10, 40),
    date: sanitizeString(source.date, 60),
    modalPre: sanitizeString(source.modalPre, 100),
    modalSub: sanitizeString(source.modalSub, 180),
    modalBody: sanitizeString(source.modalBody, 1200),
    modalStatus: sanitizeString(source.modalStatus, 80),
    modalXp: sanitizeString(source.modalXp, 40),
    color
  };
}

function sanitizeCms(body) {
  const source = body && typeof body === 'object' ? body : {};
  const experiencesInput = Array.isArray(source.experiences) ? source.experiences.slice(0, 40) : [];
  const projectsInput = Array.isArray(source.projects) ? source.projects.slice(0, 40) : [];
  const cms = {
    profile: sanitizeCmsProfile(source.profile),
    experiences: experiencesInput.map(sanitizeExperienceItem).filter((item) => item.company && item.role),
    projects: projectsInput.map(sanitizeProjectItem).filter((item) => item.name && item.id)
  };

  if (cms.experiences.length === 0) cms.experiences = defaultCmsData.experiences.map(sanitizeExperienceItem);
  if (cms.projects.length === 0) cms.projects = defaultCmsData.projects.map(sanitizeProjectItem);
  if (!cms.profile.activeQuest) cms.profile.activeQuest = defaultCmsData.profile.activeQuest;
  if (!cms.profile.exploring) cms.profile.exploring = defaultCmsData.profile.exploring;

  return cms;
}

async function ensureData() {
  await mkdir(dataDir, { recursive: true });
  if (!existsSync(progressFile)) {
    await writeFile(progressFile, JSON.stringify({ sessions: {} }, null, 2), 'utf8');
  }
  if (!existsSync(inboxFile)) {
    await writeFile(inboxFile, JSON.stringify({ submissions: [] }, null, 2), 'utf8');
  }
  if (!existsSync(cmsFile)) {
    const cms = sanitizeCms(defaultCmsData);
    await writeFile(cmsFile, JSON.stringify(cms, null, 2), 'utf8');
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

function sendJson(res, code, payload, extraHeaders = {}) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders
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

function parseCookies(req) {
  const raw = req.headers.cookie || '';
  return raw.split(';').reduce((acc, part) => {
    const [name, ...rest] = part.trim().split('=');
    if (!name) return acc;
    acc[name] = decodeURIComponent(rest.join('='));
    return acc;
  }, {});
}

function cleanupAdminSessions() {
  const now = Date.now();
  for (const [token, info] of adminSessions.entries()) {
    if (!info || info.expiresAt <= now) adminSessions.delete(token);
  }
}

function isAdminAuthenticated(req) {
  cleanupAdminSessions();
  const cookies = parseCookies(req);
  const token = cookies[ADMIN_SESSION_COOKIE];
  if (!token) return false;
  const session = adminSessions.get(token);
  if (!session) return false;
  if (session.expiresAt <= Date.now()) {
    adminSessions.delete(token);
    return false;
  }
  return true;
}

function safeEqualStrings(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function createAdminSession() {
  const token = randomBytes(32).toString('hex');
  adminSessions.set(token, { expiresAt: Date.now() + ADMIN_SESSION_TTL_SECONDS * 1000 });
  return token;
}

function clearAdminSession(req) {
  const cookies = parseCookies(req);
  const token = cookies[ADMIN_SESSION_COOKIE];
  if (token) adminSessions.delete(token);
}

function getAdminCookieHeader(token, clear = false) {
  const maxAge = clear ? 0 : ADMIN_SESSION_TTL_SECONDS;
  const value = clear ? '' : token;
  return `${ADMIN_SESSION_COOKIE}=${encodeURIComponent(value)}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${maxAge}`;
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
    throw new Error('email_send_failed');
  }

  return { delivered: true };
}

function sanitizeProgress(body) {
  const list = (arr) => Array.isArray(arr) ? arr.slice(0, MAX_PROGRESS_LIST_LENGTH).map(String) : [];
  const xpNum = Number(body.xp);
  const levelNum = Number(body.level);
  const skillClicksNum = Number(body.skillClicks);
  const xp = Number.isFinite(xpNum) ? Math.max(0, Math.min(xpNum, MAX_SESSION_XP)) : 0;
  const level = Number.isFinite(levelNum) ? Math.max(1, Math.min(levelNum, 10)) : 1;
  const skillClicks = Number.isFinite(skillClicksNum) ? Math.max(0, Math.min(skillClicksNum, 500)) : 0;
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
  const levelNum = Number(body.level);
  const xpNum = Number(body.xp);
  return {
    name: String(body.name || '').trim().slice(0, 120),
    email: String(body.email || '').trim().slice(0, 200),
    message: String(body.message || '').trim().slice(0, 5000),
    level: Number.isFinite(levelNum) ? levelNum : 0,
    xp: Number.isFinite(xpNum) ? xpNum : 0,
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
  const filePath = resolve(rootDir, relativePath);
  const useCaseInsensitiveCheck = process.platform === 'win32' || process.platform === 'darwin';
  const rootPathForCheck = useCaseInsensitiveCheck ? ROOT_DIR_RESOLVED.toLowerCase() : ROOT_DIR_RESOLVED;
  const filePathForCheck = useCaseInsensitiveCheck ? filePath.toLowerCase() : filePath;
  if (!filePathForCheck.startsWith(`${rootPathForCheck}/`) && filePathForCheck !== rootPathForCheck) {
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

function computeAnalytics(progressDb, inboxDb) {
  const sessions = progressDb && progressDb.sessions && typeof progressDb.sessions === 'object' ? progressDb.sessions : {};
  const submissions = Array.isArray(inboxDb?.submissions) ? inboxDb.submissions : [];
  const sessionList = Object.values(sessions);

  const totalSessions = sessionList.length;
  const totalSubmissions = submissions.length;
  const totalXp = sessionList.reduce((sum, item) => sum + (Number(item?.xp) || 0), 0);
  const averageXp = totalSessions > 0 ? Math.round(totalXp / totalSessions) : 0;
  const maxXp = sessionList.reduce((max, item) => Math.max(max, Number(item?.xp) || 0), 0);

  const sectionCounter = {};
  const questCounter = {};
  sessionList.forEach((item) => {
    const sections = Array.isArray(item?.visitedSections) ? item.visitedSections : [];
    const quests = Array.isArray(item?.openedQuests) ? item.openedQuests : [];
    sections.forEach((section) => {
      const key = sanitizeString(section, 60);
      if (!key) return;
      sectionCounter[key] = (sectionCounter[key] || 0) + 1;
    });
    quests.forEach((quest) => {
      const key = sanitizeString(quest, 60);
      if (!key) return;
      questCounter[key] = (questCounter[key] || 0) + 1;
    });
  });

  const topVisitedSections = Object.entries(sectionCounter)
    .map(([section, count]) => ({ section, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  const topOpenedExperiences = Object.entries(questCounter)
    .map(([quest, count]) => ({ quest, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  const latestSubmission = submissions.length > 0
    ? submissions.slice().sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))[0]
    : null;

  return {
    totalSessions,
    totalSubmissions,
    averageXp,
    maxXp,
    latestSubmissionAt: latestSubmission?.createdAt || null,
    topVisitedSections,
    topOpenedExperiences
  };
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

    if (url.pathname === '/api/cms' && req.method === 'GET') {
      const cms = sanitizeCms(await readJson(cmsFile, defaultCmsData));
      return sendJson(res, 200, { cms });
    }

    if (url.pathname === '/api/admin/login' && req.method === 'POST') {
      if (!ADMIN_USERNAME || !ADMIN_PASSWORD) {
        return sendJson(res, 503, { error: 'admin_not_configured' });
      }
      const body = await parseBody(req);
      const username = String(body.username || '').trim();
      const password = String(body.password || '').trim();

      const validUser = safeEqualStrings(username, ADMIN_USERNAME);
      const validPass = safeEqualStrings(password, ADMIN_PASSWORD);

      if (!validUser || !validPass) {
        return sendJson(res, 401, { error: 'invalid_credentials' });
      }

      const token = createAdminSession();
      return sendJson(
        res,
        200,
        { ok: true, username: ADMIN_USERNAME },
        { 'Set-Cookie': getAdminCookieHeader(token) }
      );
    }

    if (url.pathname === '/api/admin/logout' && req.method === 'POST') {
      clearAdminSession(req);
      return sendJson(res, 200, { ok: true }, { 'Set-Cookie': getAdminCookieHeader('', true) });
    }

    if (url.pathname === '/api/admin/session' && req.method === 'GET') {
      if (!isAdminAuthenticated(req)) return sendJson(res, 401, { error: 'unauthorized' });
      return sendJson(res, 200, { ok: true, username: ADMIN_USERNAME });
    }

    if (url.pathname.startsWith('/api/admin/')) {
      if (!isAdminAuthenticated(req)) return sendJson(res, 401, { error: 'unauthorized' });

      if (url.pathname === '/api/admin/cms' && req.method === 'GET') {
        const cms = sanitizeCms(await readJson(cmsFile, defaultCmsData));
        return sendJson(res, 200, { cms });
      }

      if (url.pathname === '/api/admin/cms' && req.method === 'PUT') {
        const body = await parseBody(req);
        const cms = sanitizeCms(body?.cms || body);
        await enqueueWrite(async () => {
          await writeJson(cmsFile, cms);
        });
        return sendJson(res, 200, { ok: true, cms });
      }

      if (url.pathname === '/api/admin/submissions' && req.method === 'GET') {
        const inbox = await readJson(inboxFile, { submissions: [] });
        const submissions = Array.isArray(inbox.submissions) ? inbox.submissions : [];
        const sorted = submissions.slice().sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
        return sendJson(res, 200, { submissions: sorted });
      }

      if (url.pathname === '/api/admin/analytics' && req.method === 'GET') {
        const progressDb = await readJson(progressFile, { sessions: {} });
        const inboxDb = await readJson(inboxFile, { submissions: [] });
        return sendJson(res, 200, { analytics: computeAnalytics(progressDb, inboxDb) });
      }
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
