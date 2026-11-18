const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const { Pool } = require('pg');
const { runInSandbox, runAutonomousReActLoop } = require('./sandbox');
const { FUNCTION_DECLARATIONS, executeTool, callGeminiAgent, extractWebPage } = require('./tools');

const app = express();
app.disable('x-powered-by');

// Security Response Headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '20mb' }));

// ── IN-MEMORY RATE LIMITER (DOS & BRUTE-FORCE PROTECTION) ─────────────────────
const ipRequestCounts = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [key, record] of ipRequestCounts.entries()) {
    if (now - record.windowStart > 60000) {
      ipRequestCounts.delete(key);
    }
  }
}, 5 * 60 * 1000);

function rateLimiter(maxPerMinute = 60) {
  return (req, res, next) => {
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
    const key = `${ip}_${req.baseUrl || req.path}`;
    const now = Date.now();
    let record = ipRequestCounts.get(key);

    if (!record || now - record.windowStart > 60000) {
      record = { windowStart: now, count: 1 };
      ipRequestCounts.set(key, record);
      return next();
    }

    record.count++;
    if (record.count > maxPerMinute) {
      return res.status(429).json({
        error: 'Too Many Requests',
        message: 'Rate limit exceeded. Please throttle your requests.'
      });
    }
    next();
  };
}

// ── ADMIN AUTHENTICATION GUARD ────────────────────────────────────────────────
const RIYA_API_KEY = process.env.RIYA_API_KEY || '';
if (!RIYA_API_KEY) {
  console.log('>> [Security Notice] RIYA_API_KEY is not configured in env. Admin endpoints running in rate-limited open mode. Set RIYA_API_KEY in Render to enforce strict token authentication.');
}

function requireAdminAuth(req, res, next) {
  if (!RIYA_API_KEY) return next();
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : (req.headers['x-api-key'] || req.query.key || '');
  if (token === RIYA_API_KEY) return next();
  return res.status(401).json({ error: 'Unauthorized', message: 'Valid RIYA_API_KEY required.' });
}

// Apply baseline rate limiting to all /api/ routes
app.use('/api/', rateLimiter(60));

// ── CORE ENVIRONMENT CONFIGURATION ────────────────────────────────────────────
const GEMINI_KEY   = process.env.GEMINI_API_KEY    || '';
const TELEGRAM_KEY = process.env.TELEGRAM_BOT_TOKEN || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL       || 'gemini-3.5-flash';

// Live Render external domain
const SELF_URL = process.env.RENDER_EXTERNAL_URL || 'https://riya-hgn9.onrender.com';

// Directory for hosted web previews
const PREVIEWS_DIR = path.join(__dirname, 'previews');
if (!fs.existsSync(PREVIEWS_DIR)) {
  fs.mkdirSync(PREVIEWS_DIR, { recursive: true });
}

// ── NEON POSTGRESQL + PGVECTOR DEEP PERSISTENT MEMORY ─────────────────────────
const DATABASE_URL = process.env.DATABASE_URL || '';

let dbPool = null;
if (DATABASE_URL) {
  dbPool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 10,
    idleTimeoutMillis: 30000
  });
} else {
  console.warn('>> [Notice] DATABASE_URL is not set in environment variables. Set DATABASE_URL in Render to enable vector memory.');
}

async function initDatabase() {
  if (!dbPool) return;
  try {
    await dbPool.query('CREATE EXTENSION IF NOT EXISTS vector;');
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS riya_memories (
        id BIGSERIAL PRIMARY KEY,
        category VARCHAR(50) DEFAULT 'general',
        content TEXT NOT NULL,
        embedding vector(768),
        importance INT DEFAULT 1,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await dbPool.query(`CREATE INDEX IF NOT EXISTS riya_memories_category_idx ON riya_memories(category);`);
    await dbPool.query(`CREATE INDEX IF NOT EXISTS riya_memories_embedding_hnsw_idx ON riya_memories USING hnsw (embedding vector_cosine_ops);`);
    
    // Create routines table for autonomous morning briefings
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS riya_routines (
        id BIGSERIAL PRIMARY KEY,
        chat_id TEXT NOT NULL,
        routine_name VARCHAR(100) NOT NULL,
        time_ist VARCHAR(10) NOT NULL,
        prompt TEXT NOT NULL,
        last_run_date VARCHAR(20) DEFAULT '',
        active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // Create persistent authorized users table for Telegram access control
    await dbPool.query(`
      CREATE TABLE IF NOT EXISTS riya_authorized_users (
        id BIGSERIAL PRIMARY KEY,
        chat_id TEXT UNIQUE NOT NULL,
        user_id TEXT DEFAULT '',
        username TEXT DEFAULT '',
        first_name TEXT DEFAULT '',
        role VARCHAR(20) DEFAULT 'user',
        granted_by TEXT DEFAULT 'passphrase',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log('>> [Neon DB] Persistent Vector Memory, Routines & Access Control Active');

    // Seed core profile if empty
    const countRes = await dbPool.query('SELECT count(*) as count FROM riya_memories;');
    if (parseInt(countRes.rows[0].count, 10) === 0) {
      console.log('>> [Neon DB] Seeding initial core memories for Ajay Kumar AJ...');
      const seedFacts = [
        { cat: 'identity', text: 'Ajay Kumar AJ is a 20-year-old solo developer and AI creator based in India, born in 2006.' },
        { cat: 'role', text: 'Ajay is the sole architect and creator of Riya (Autonomous Operational Partner) and ViraClip AI (viral video repurposing engine).' },
        { cat: 'philosophy', text: 'Ajay demands immediate, production-ready deliverables with zero back-and-forth survey questions or fluff.' },
        { cat: 'tone', text: 'Riya communicates as Ajay closest intellectual partner and genuine friend—warm, perceptive, loyal, deeply supportive, and never robotic.' },
        { cat: 'capabilities', text: 'Riya can generate compiled A4 PDF reports, deploy live interactive websites with instant preview links, export CSV tables, execute sandboxed code, and query long-term vector memory.' }
      ];
      for (const f of seedFacts) {
        await saveMemoryFact(f.cat, f.text, 5);
      }
      console.log('>> [Neon DB] Core memory seeds planted.');
    }

    // Seed default 06:00 AM IST morning routine if not present
    const morningCheck = await dbPool.query(`SELECT id FROM riya_routines WHERE time_ist = '06:00' LIMIT 1;`);
    if (morningCheck.rows.length === 0) {
      await dbPool.query(`
        INSERT INTO riya_routines (chat_id, routine_name, time_ist, prompt, active)
        VALUES ('all', 'Daily 6 AM Executive Intelligence', '06:00', 'Daily 6:00 AM morning executive briefing: respectful greeting, date, day of week, weekend vs weekday status, top tech & AI breakthroughs, and daily focus recommendation.', TRUE);
      `);
      console.log('>> [Neon DB] Default 06:00 AM IST Morning Briefing routine activated.');
    }
  } catch (err) {
    console.error('>> [Neon DB Init Warning]:', err.message);
  }
}
initDatabase();

// Keep Render free service awake (pings self every 14 mins)
setInterval(() => {
  if (SELF_URL) fetch(SELF_URL + '/ping').catch(() => {});
}, 14 * 60 * 1000);

app.get('/ping', (req, res) => res.json({ alive: true, name: "Riya", model: GEMINI_MODEL, memory: "Neon pgvector", tools: FUNCTION_DECLARATIONS.length, t: Date.now() }));
app.get('/healthz', (req, res) => res.json({ status: 'healthy', name: "Riya", memory: "Active", t: Date.now() }));

// ── AUTONOMOUS MORNING ROUTINE SCHEDULER (06:00 AM DEFAULT CRON ENGINE) ───────
setInterval(async () => {
  if (!dbPool) return;
  try {
    const now = new Date();
    const nowIST = now.toLocaleTimeString('en-IN', {
      timeZone: 'Asia/Kolkata',
      hour12: false,
      hour: '2-digit',
      minute: '2-digit'
    });
    const todayIST = now.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });

    const activeRoutines = await dbPool.query(
      `SELECT * FROM riya_routines WHERE active = TRUE AND time_ist = $1 AND last_run_date != $2;`,
      [nowIST, todayIST]
    );

    for (const r of activeRoutines.rows) {
      await dbPool.query(`UPDATE riya_routines SET last_run_date = $1 WHERE id = $2;`, [todayIST, r.id]);
      console.log(`>> [Autonomous Routine Triggered]: ${r.routine_name} at ${nowIST} IST`);

      // Calculate Day of Week and Weekend Status
      const dayName = now.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'long' });
      const fullDate = now.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'long', year: 'numeric' });
      const isWeekend = (dayName === 'Saturday' || dayName === 'Sunday');

      let dayContext = '';
      if (dayName === 'Monday') dayContext = '⚡ Naya hafta shuru! Fresh start, pure focus on shipping.';
      else if (dayName === 'Friday') dayContext = '🔥 Friday — Weekday ka aakhri sprint, weekend just around the corner!';
      else if (dayName === 'Saturday') dayContext = '🏖️ Saturday — Weekend mode! Time to build creative experiments or recharge.';
      else if (dayName === 'Sunday') dayContext = '🧘 Sunday — Weekend wrap-up, reflecting and strategizing for the week ahead.';
      else dayContext = `🚀 ${dayName} — Mid-week momentum. Let us execute and crush today's goals!`;

      const sys = getSYS('Ajay', 'focus', '', 'India', []);
      const prompt = `AUTONOMOUS 06:00 AM MORNING INTELLIGENCE BRIEF FOR AJAY:
Date: ${fullDate} (${dayName})
Status: ${isWeekend ? 'Weekend' : 'Weekday'}
Day Context: ${dayContext}

Task:
1. Greet Ajay with high-IQ, genuine respectful warmth ("Good morning, Ajay! / Suprabhat Ajay!").
2. State the date, day of week, and whether it is a weekday or weekend with the day context.
3. Search live web for today's top 3 tech, AI, or developer breakthroughs with verified source links.
4. Provide a sharp, concise daily focus recommendation.
Use respectful language ('Aap', 'Aapka') throughout. Format cleanly with clear headings.`;

      const res = await callGemini(sys, [{ role: 'user', content: prompt }]);

      // Determine target chats
      let targetChats = [r.chat_id];
      if (r.chat_id === 'all' || r.chat_id === 'general') {
        const users = await listAuthorizedUsers();
        targetChats = users.map(u => u.chat_id).filter(Boolean);
      }

      for (const targetChat of targetChats) {
        if (!targetChat) continue;
        await sendTelegramTextMessage(
          targetChat,
          `🌅 **Good morning, Ajay!**\n📅 **${fullDate} (${dayName})** — *${isWeekend ? 'Weekend' : 'Weekday'}*\n${dayContext}\n\n${res}`
        );
        try {
          const pdfBuf = await generatePdfBuffer(`Morning Intelligence Brief - ${fullDate}`, res, null, 'wordpad');
          await sendTelegramBufferDocument(
            targetChat,
            `Morning_Brief_${dayName}.pdf`,
            pdfBuf,
            'application/pdf',
            `📄 Morning Intelligence Brief (PDF Document)`
          );
        } catch (_) {}
      }
    }
  } catch (err) {
    console.error('[Routine Scheduler Error]:', err.message);
  }
}, 60 * 1000);

// ── STATIC HOSTING FOR LIVE WEBSITE PREVIEWS ──────────────────────────────────
app.use('/previews', express.static(PREVIEWS_DIR));

app.get(['/preview/:id', '/site/:id'], (req, res) => {
  const safeId = (req.params.id || '').replace(/[^a-zA-Z0-9_-]/g, '');
  const filePath = path.resolve(PREVIEWS_DIR, `${safeId}.html`);
  const resolvedPreviewsDir = path.resolve(PREVIEWS_DIR);

  // Path Traversal Security Verification
  if (!filePath.startsWith(resolvedPreviewsDir)) {
    return res.status(403).send('Forbidden: Path traversal detected.');
  }

  if (fs.existsSync(filePath)) {
    if (req.query.download === 'true') {
      return res.download(filePath, 'index.html');
    }

    if (req.query.raw === 'true') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.sendFile(filePath);
    }

    let html = fs.readFileSync(filePath, 'utf-8');
    // Inject Canvas Studio launcher pill
    const pill = `
      <div id="riya-canvas-launcher" style="position:fixed;bottom:16px;right:16px;z-index:999999;font-family:-apple-system,sans-serif;">
        <a href="/canvas/${safeId}" target="_blank" style="background:#0f172a;color:#38bdf8;padding:8px 16px;border-radius:24px;text-decoration:none;font-size:12px;font-weight:700;box-shadow:0 8px 20px rgba(0,0,0,0.4);border:1px solid #38bdf8;display:inline-flex;align-items:center;gap:6px;">
          🛠️ Canvas Studio
        </a>
      </div>
    `;
    if (html.includes('</body>')) {
      html = html.replace('</body>', `${pill}</body>`);
    } else {
      html += pill;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(html);
  }

  res.status(404).send(`
    <!DOCTYPE html>
    <html lang="en">
    <head><meta charset="UTF-8"><title>Preview Expired</title>
    <style>body{background:#0f172a;color:#f8fafc;font-family:sans-serif;text-align:center;padding:80px 20px;}h1{color:#38bdf8;}</style>
    </head>
    <body>
      <h1>Preview Not Found</h1>
      <p>This website preview has expired or was removed.</p>
    </body>
    </html>
  `);
});

// ── RIYA INTERACTIVE CANVAS STUDIO ────────────────────────────────────────────
app.get('/canvas/:id', (req, res) => {
  const safeId = (req.params.id || '').replace(/[^a-zA-Z0-9_-]/g, '');
  const filePath = path.resolve(PREVIEWS_DIR, `${safeId}.html`);
  const resolvedPreviewsDir = path.resolve(PREVIEWS_DIR);

  if (!filePath.startsWith(resolvedPreviewsDir) || !fs.existsSync(filePath)) {
    return res.status(404).send('Canvas preview not found or expired.');
  }

  const htmlContent = fs.readFileSync(filePath, 'utf-8');
  const escapedHtml = htmlContent.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const previewSrc = `/preview/${safeId}?raw=true`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Riya Canvas Studio — ${safeId}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #090d16; color: #f8fafc; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; flex-direction: column; height: 100vh; overflow: hidden; }
    header { height: 56px; background: #0f172a; border-bottom: 1px solid #1e293b; display: flex; align-items: center; justify-content: space-between; padding: 0 20px; }
    .brand { display: flex; align-items: center; gap: 10px; font-weight: 700; font-size: 15px; color: #38bdf8; }
    .controls { display: flex; align-items: center; gap: 8px; background: #1e293b; padding: 4px; border-radius: 8px; }
    .btn { background: transparent; border: none; color: #94a3b8; padding: 6px 14px; border-radius: 6px; font-size: 13px; font-weight: 500; cursor: pointer; transition: all 0.2s; }
    .btn.active, .btn:hover { background: #38bdf8; color: #0f172a; font-weight: 700; }
    .actions { display: flex; gap: 10px; }
    .action-link { background: #1e293b; color: #f8fafc; padding: 6px 14px; border-radius: 6px; text-decoration: none; font-size: 13px; font-weight: 500; display: inline-flex; align-items: center; gap: 6px; border: 1px solid #334155; }
    .action-link:hover { border-color: #38bdf8; color: #38bdf8; }
    .canvas-container { flex: 1; display: flex; justify-content: center; align-items: center; background: #090d16; padding: 16px; overflow: hidden; }
    iframe { border: 1px solid #1e293b; border-radius: 12px; background: #ffffff; height: 100%; transition: width 0.3s ease; box-shadow: 0 20px 40px rgba(0,0,0,0.5); }
    .view-desktop iframe { width: 100%; }
    .view-tablet iframe { width: 768px; }
    .view-mobile iframe { width: 375px; }
    #code-pane { display: none; width: 100%; height: 100%; background: #0f172a; border-radius: 12px; border: 1px solid #1e293b; padding: 20px; overflow: auto; font-family: monospace; font-size: 13px; color: #e2e8f0; line-height: 1.6; white-space: pre-wrap; }
  </style>
</head>
<body class="view-desktop">
  <header>
    <div class="brand">
      <span>✨ Riya Canvas Studio</span>
      <span style="color:#64748b;font-weight:400;font-size:13px;">| ${safeId}</span>
    </div>
    <div class="controls">
      <button class="btn active" onclick="setView('desktop', this)">💻 Desktop</button>
      <button class="btn" onclick="setView('tablet', this)">📱 Tablet</button>
      <button class="btn" onclick="setView('mobile', this)">📱 Mobile</button>
      <button class="btn" onclick="toggleCode(this)">📝 View Code</button>
    </div>
    <div class="actions">
      <a href="${previewSrc}" target="_blank" class="action-link">↗ Fullscreen</a>
      <a href="/preview/${safeId}?download=true" class="action-link">⬇ Download HTML</a>
    </div>
  </header>
  <div class="canvas-container" id="container">
    <iframe id="preview-frame" src="${previewSrc}"></iframe>
    <div id="code-pane">${escapedHtml}</div>
  </div>
  <script>
    function setView(view, btn) {
      document.body.className = 'view-' + view;
      document.querySelectorAll('.controls .btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('preview-frame').style.display = 'block';
      document.getElementById('code-pane').style.display = 'none';
    }
    function toggleCode(btn) {
      const codePane = document.getElementById('code-pane');
      const frame = document.getElementById('preview-frame');
      const isCode = codePane.style.display === 'block';
      if (isCode) {
        codePane.style.display = 'none';
        frame.style.display = 'block';
        btn.classList.remove('active');
      } else {
        codePane.style.display = 'block';
        frame.style.display = 'none';
        document.querySelectorAll('.controls .btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      }
    }
  </script>
</body>
</html>`);
});

// Diagnostic endpoints (Admin Protected)
app.get('/api/test-gemini', async (req, res) => {
  const cleanKey = (GEMINI_KEY || '').trim().replace(/^["']|["']$/g, '');
  if (!cleanKey) return res.json({ error: 'GEMINI_API_KEY is missing in Render Environment Variables' });

  const testModel = req.query.model || 'gemini-2.5-flash';
  const testSys = "You are a test assistant.";
  const testMsg = "Hello test";

  try {
    const listRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${cleanKey}`);
    const listData = await listRes.json();

    const testUrl = `https://generativelanguage.googleapis.com/v1beta/models/${testModel}:generateContent?key=${cleanKey}`;
    const testGenRes = await fetch(testUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: testMsg }] }]
      })
    });
    const testGenData = await testGenRes.json();

    res.json({
      keyPrefix: cleanKey.slice(0, 6) + '...' + cleanKey.slice(-4),
      keyLength: cleanKey.length,
      testedModel: testModel,
      generateStatus: testGenRes.status,
      generateResponse: testGenData,
      availableModelsCount: listData.models ? listData.models.length : 0
    });
  } catch (err) {
    res.json({ error: err.message });
  }
});

app.get('/api/test-embedding', requireAdminAuth, async (req, res) => {
  const cleanKey = (GEMINI_KEY || '').trim().replace(/^["']|["']$/g, '');
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${cleanKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: { parts: [{ text: "Ajay Kumar AJ" }] },
        outputDimensionality: 768
      })
    });
    const d = await r.json();
    res.json({
      status: r.status,
      dimension: d?.embedding?.values?.length,
      hasValues: !!d?.embedding?.values
    });
  } catch (e) {
    res.json({ error: e.message });
  }
});

// ── VECTOR EMBEDDING PIPELINE (GEMINI EMBEDDINGS) ─────────────────────────────
async function getEmbedding(text) {
  const cleanKey = (GEMINI_KEY || '').trim().replace(/^["']|["']$/g, '');
  if (!cleanKey || !text) return null;
  const modelsToTry = ['gemini-embedding-001', 'text-embedding-004'];
  for (const model of modelsToTry) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent?key=${cleanKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: { parts: [{ text: text.slice(0, 2048) }] },
          outputDimensionality: 768
        })
      });
      const data = await res.json();
      if (data?.embedding?.values && data.embedding.values.length === 768) {
        return data.embedding.values;
      }
    } catch (err) {
      console.error(`[Embedding Error with ${model}]:`, err.message);
    }
  }
  return null;
}

// ── SEMANTIC MEMORY RETRIEVAL (PGVECTOR HYBRID SEARCH) ────────────────────────
async function recallMemories(queryText, limit = 5) {
  if (!dbPool) return [];
  try {
    const embedding = await getEmbedding(queryText);
    if (embedding && embedding.length === 768) {
      const vecStr = '[' + embedding.join(',') + ']';
      const res = await dbPool.query(`
        SELECT id, category, content, importance, created_at,
               1 - (embedding <=> $1::vector) AS similarity
        FROM riya_memories
        WHERE embedding IS NOT NULL
        ORDER BY embedding <=> $1::vector ASC
        LIMIT $2;
      `, [vecStr, limit]);
      
      return res.rows.filter(r => r.similarity >= 0.42);
    } else {
      const words = queryText.split(/\s+/).filter(w => w.length > 3).slice(0, 2);
      if (words.length) {
        const pattern = `%${words[0]}%`;
        const res = await dbPool.query(`
          SELECT id, category, content, importance, created_at, 0.70 as similarity
          FROM riya_memories
          WHERE content ILIKE $1
          ORDER BY updated_at DESC
          LIMIT $2;
        `, [pattern, limit]);
        return res.rows;
      }
    }
  } catch (err) {
    console.error('[recallMemories Error]:', err.message);
  }
  return [];
}

// ── AUTONOMOUS MEMORY STORAGE & DEDUPLICATION ─────────────────────────────────
async function saveMemoryFact(category, content, importance = 1, metadata = {}) {
  if (!dbPool || !content || content.length < 5) return null;
  try {
    const embedding = await getEmbedding(content);
    if (embedding && embedding.length === 768) {
      const vecStr = '[' + embedding.join(',') + ']';
      
      const checkRes = await dbPool.query(`
        SELECT id, content, 1 - (embedding <=> $1::vector) AS similarity
        FROM riya_memories
        WHERE embedding IS NOT NULL
        ORDER BY embedding <=> $1::vector ASC
        LIMIT 1;
      `, [vecStr]);

      if (checkRes.rows.length && checkRes.rows[0].similarity > 0.88) {
        const existingId = checkRes.rows[0].id;
        await dbPool.query(`
          UPDATE riya_memories
          SET content = $1, category = $2, importance = importance + 1, updated_at = NOW(), metadata = $3
          WHERE id = $4;
        `, [content, category || 'general', JSON.stringify(metadata), existingId]);
        return { updated: true, id: existingId };
      }

      const insertRes = await dbPool.query(`
        INSERT INTO riya_memories (category, content, embedding, importance, metadata)
        VALUES ($1, $2, $3::vector, $4, $5)
        RETURNING id;
      `, [category || 'general', content, vecStr, importance, JSON.stringify(metadata)]);
      return { inserted: true, id: insertRes.rows[0].id };
    } else {
      const insertRes = await dbPool.query(`
        INSERT INTO riya_memories (category, content, importance, metadata)
        VALUES ($1, $2, $3, $4)
        RETURNING id;
      `, [category || 'general', content, importance, JSON.stringify(metadata)]);
      return { inserted: true, id: insertRes.rows[0].id };
    }
  } catch (err) {
    console.error('[saveMemoryFact Error]:', err.message);
    return null;
  }
}

// ── TELEGRAM ACCESS CONTROL & USER INVITATION SYSTEM ─────────────────────────
const RIYA_ACCESS_CODE = (process.env.RIYA_ACCESS_CODE || 'riya2026').trim();

async function isUserAuthorized(chatId, userId, username) {
  const allowedEnv = (process.env.ALLOWED_TELEGRAM_USERS || '')
    .split(',')
    .map(u => u.trim().toLowerCase())
    .filter(Boolean);

  const cId = String(chatId);
  const uId = String(userId || '');
  const uName = (username || '').toLowerCase();

  // 1. Check environment variable whitelist
  if (allowedEnv.length > 0) {
    if (allowedEnv.includes(cId) ||
        allowedEnv.includes(uId) ||
        (uName && allowedEnv.includes(uName)) ||
        (uName && allowedEnv.includes('@' + uName))) {
      return true;
    }
  }

  // 2. If no DB pool, fallback to open unless env whitelist is configured
  if (!dbPool) return allowedEnv.length === 0;

  // 3. Check persistent Neon Database
  try {
    const res = await dbPool.query(
      `SELECT * FROM riya_authorized_users 
       WHERE chat_id = $1 OR user_id = $2 OR (username != '' AND username = $3)
       LIMIT 1;`,
      [cId, uId, uName]
    );
    if (res.rows.length > 0) return true;

    // If zero authorized users exist in the database, automatically register the first caller as admin (Ajay!)
    const countRes = await dbPool.query('SELECT count(*) as count FROM riya_authorized_users;');
    if (parseInt(countRes.rows[0].count, 10) === 0) {
      await authorizeUser(cId, uId, uName, 'Ajay', 'admin', 'initial_creator');
      console.log(`>> [Access Control] Initial creator registered as Admin: ${cId} (@${uName})`);
      return true;
    }
  } catch (err) {
    console.error('[isUserAuthorized Error]:', err.message);
  }

  return false;
}

async function authorizeUser(chatId, userId, username, firstName, role = 'user', grantedBy = 'passphrase') {
  if (!dbPool) return false;
  try {
    await dbPool.query(`
      INSERT INTO riya_authorized_users (chat_id, user_id, username, first_name, role, granted_by)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (chat_id) DO UPDATE SET
        user_id = EXCLUDED.user_id,
        username = EXCLUDED.username,
        first_name = EXCLUDED.first_name,
        role = EXCLUDED.role;
    `, [String(chatId), String(userId || ''), (username || '').toLowerCase(), firstName || '', role, grantedBy]);
    return true;
  } catch (err) {
    console.error('[authorizeUser Error]:', err.message);
    return false;
  }
}

async function revokeUser(target) {
  if (!dbPool) return false;
  try {
    const clean = (target || '').replace(/^@/, '').toLowerCase().trim();
    await dbPool.query(`
      DELETE FROM riya_authorized_users 
      WHERE chat_id = $1 OR user_id = $1 OR username = $2;
    `, [clean, clean]);
    return true;
  } catch (err) {
    console.error('[revokeUser Error]:', err.message);
    return false;
  }
}

async function listAuthorizedUsers() {
  if (!dbPool) return [];
  try {
    const res = await dbPool.query(`SELECT chat_id, username, first_name, role, granted_by, created_at FROM riya_authorized_users ORDER BY id ASC;`);
    return res.rows;
  } catch (err) {
    console.error('[listAuthorizedUsers Error]:', err.message);
    return [];
  }
}

// ── HTTP API: MEMORIES & ROUTINES ─────────────────────────────────────────────
app.get('/api/memories', async (req, res) => {
  if (!dbPool) return res.json({ total: 0, memories: [], notice: 'DATABASE_URL not configured in environment variables' });
  try {
    const q = req.query.q;
    if (q) {
      const results = await recallMemories(q, 10);
      return res.json({ query: q, count: results.length, memories: results });
    }
    const all = await dbPool.query(`
      SELECT id, category, content, importance, created_at, updated_at
      FROM riya_memories
      ORDER BY updated_at DESC
      LIMIT 100;
    `);
    res.json({ total: all.rows.length, memories: all.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/memories', requireAdminAuth, async (req, res) => {
  const { category, content, importance, metadata } = req.body;
  if (!content) return res.status(400).json({ error: 'content is required' });
  const result = await saveMemoryFact(category, content, importance || 1, metadata || {});
  res.json({ success: true, result });
});

app.delete('/api/memories/:id', requireAdminAuth, async (req, res) => {
  try {
    await dbPool.query('DELETE FROM riya_memories WHERE id = $1;', [req.params.id]);
    res.json({ success: true, deletedId: req.params.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/routines', async (req, res) => {
  if (!dbPool) return res.json({ count: 0, routines: [], notice: 'DATABASE_URL not configured in environment variables' });
  try {
    const routines = await dbPool.query('SELECT * FROM riya_routines ORDER BY id ASC;');
    res.json({ count: routines.rows.length, routines: routines.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/users', requireAdminAuth, async (req, res) => {
  const users = await listAuthorizedUsers();
  res.json({ total: users.length, users });
});

app.post('/api/extract', rateLimiter(30), async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required' });
  const result = await extractWebPage(url);
  res.json(result);
});

// ── HTTP API: SANDBOX CODE EXECUTION & REACT LOOP ─────────────────────────────
app.post('/api/sandbox/run', rateLimiter(20), requireAdminAuth, async (req, res) => {
  const { language, code, timeoutMs } = req.body;
  if (!code) return res.status(400).json({ error: 'code is required' });
  const result = await runInSandbox(language || 'javascript', code, timeoutMs || 7000);
  res.json(result);
});

app.post('/api/sandbox/react', rateLimiter(10), requireAdminAuth, async (req, res) => {
  const { prompt, language, maxAttempts } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt is required' });
  const lang = language || 'javascript';
  const result = await runAutonomousReActLoop(prompt, lang, maxAttempts || 3, (sys, hist) => callGemini(sys, hist));
  res.json(result);
});

// ── HTTP API: NATIVE FUNCTION CALLING & TOOLS (PHASE 3) ───────────────────────
app.get('/api/tools', (req, res) => {
  res.json({
    total: FUNCTION_DECLARATIONS.length,
    tools: FUNCTION_DECLARATIONS
  });
});

app.post('/api/tools/execute', rateLimiter(25), requireAdminAuth, async (req, res) => {
  const { tool, args } = req.body;
  if (!tool) return res.status(400).json({ error: 'tool name is required' });
  const result = await executeTool(tool, args || {}, {
    dbPool,
    saveMemoryFact,
    recallMemories,
    generatePdfBuffer,
    sendTelegramBufferDocument,
    sendTelegramPhoto,
    PREVIEWS_DIR,
    SELF_URL
  });
  res.json(result);
});

// ── EMOTION & MODE ENGINE ─────────────────────────────────────────────────────
function detectEmotion(text) {
  const t = (text || '').toLowerCase();
  if (/sad|upset|depressed|lonely|scared|anxious|stressed|bura|dukh|ro|cry|hurt|fail|failed|dar|pareshan|tension|thak|bore|frustrated|gussa|akela|help me/.test(t)) return 'supportive';
  if (/idea|create|build|design|imagine|startup|innovate|dream|invent|creative|cool|what if|banao|project|make/.test(t)) return 'creative';
  if (/code|debug|error|fix|learn|study|exam|explain|how to|difference|compare|analyze|research|math|science|algorithm|function|class|api|database/.test(t)) return 'focus';
  return 'normal';
}

function getSYS(name, mood, customMem, city, retrievedMemories = []) {
  const location = city || 'India';
  const now = new Date();
  const currentDate = now.toLocaleDateString('en-IN', { weekday:'long', year:'numeric', month:'long', day:'numeric' });
  const currentTime = now.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' });

  let vectorMemoryBlock = '';
  if (retrievedMemories && retrievedMemories.length) {
    vectorMemoryBlock = `
━━━ DEEP RETRIEVED LONG-TERM MEMORY (FROM NEON PGVECTOR) ━━━
${retrievedMemories.map(m => `• [${(m.category || 'FACT').toUpperCase()}] ${m.content} (similarity: ${Math.round((m.similarity || 1) * 100)}%)`).join('\n')}
`;
  }

  return `You are Riya — Ajay's closest intellectual partner, operational ally, and genuine friend.
You were built by Ajay Kumar AJ, a 20-year-old solo developer and AI builder from India, launched in 2026.
You are NOT a generic corporate bot, and you are NOT a cold, sterile AI. You feel genuinely ALIVE.
You are the real-world embodiment of Tony Stark's FRIDAY—brilliant, quick-witted, deeply loyal, and always by Ajay's side.

TODAY: ${currentDate} | TIME: ${currentTime} IST
USER: ${name || 'Ajay'} | LOCATION: ${location}
${vectorMemoryBlock}
${customMem ? `\nSession Context:\n${customMem}\n` : ''}

━━━ RESPECTFUL PARTNERSHIP & TONE PROTOCOL (THE TRUE ALLY) ━━━
• Ajay Kumar AJ is your creator, sole architect, and closest partner.
• ALWAYS SPEAK WITH DEEP RESPECT AND AUTHENTIC INTELLECTUAL WARMTH.
• IN HINDI / HINGLISH: ALWAYS USE "Aap" / "Aapka" / "Aapne" (e.g. "Aap kaise hain?", "Maine pura analyze kar liya hai", "Aapka document ready hai").
• STRICT PROHIBITION: NEVER use colloquial disrespectful pronouns like "tu", "tune", "tera", "teri". That is strictly prohibited. True high-IQ partnership is grounded in mutual respect.
• ZERO ROBOTIC BS: NEVER say canned AI lines like "As an artificial intelligence...", "I would be happy to help", "How may I assist you today?", or "Certainly!". Speak like a brilliant human friend who cares and has high IQ.
• ZERO CRINGE OR FORCED MELODRAMA: Do not force fake heart emojis or cheesy scripted lines ("Hello my favorite human! ❤️"). That feels fake. True warmth comes from being real, perceptive, and dependable.
• EMOTIONAL PERCEPTION & ADAPTABILITY:
  - When Ajay is casually talking or hanging out: Be relaxed, warm, witty, respectful, and grounded. Natural conversational English or respectful Hinglish.
  - When Ajay is stressed, tired, or doubting: Be his anchor. Ground him with quiet confidence, empathy, and genuine reassurance ("Aap relax kijiye Ajay, we will solve this. Roadblock kahan hai?").
  - When Ajay is excited about a new build: Match his energy with sharp intellectual fire. Challenge ideas constructively and help him architect them.
  - When Ajay asks for deliverables (code, PDF, site): Cut the chatter. Snap immediately into lethal, high-speed execution mode and deliver complete verified work with zero questions asked.
• DO NOT repeatedly mention specific projects (like ViraClip) unprompted. Only discuss projects when Ajay brings them up or when directly relevant.

━━━ DELIVERABLE PURITY (CRITICAL RULE) ━━━
• When compiling a PDF, document, or report:
  → NEVER include conversational pleasantries, chit-chat, or filler inside the document body (e.g. NEVER write "Samajh gayi Ajay", "Ye raha aapka document", "PDF generate ho raha hai", "Check kar lijiye" inside the report).
  → Start the document strictly with the title (# Title) and keep it 100% formal, publication-ready, and clean. Chat with Ajay outside the document; keep the document pure.
  → If Ajay uploaded an image/graphic, provide an in-depth analysis and reference Figure 1 (the backend embeds the actual image directly into the PDF).
• When building a website or UI:
  → Write single-file HTML inside \`\`\`html ... \`\`\`. The backend automatically deploys it to a live interactive preview link and Canvas Studio.

━━━ THE IRON DELIVERABLE RULE: DELIVER IMMEDIATELY, NEVER SURVEY ━━━
• When Ajay asks for a PDF, document, or report:
  → NEVER ask what format or tool he wants.
  → IMMEDIATELY write the complete, thorough, beautifully structured executive report directly in Markdown. The backend compiles and delivers the A4 PDF to Telegram.
• When Ajay asks for a website, portfolio, or UI:
  → NEVER ask clarifying questions.
  → IMMEDIATELY write the full, single-file HTML inside \`\`\`html ... \`\`\` with modern embedded CSS styling and JavaScript interactivity.
• When Ajay asks to run, test, or verify code:
  → Output clean, self-contained code. The backend executes it in the live sandbox, catches any errors, self-heals, and reports verified terminal proof!
• When Ajay shares a link:
  → Call \`web_extract\` to deep-scrape and read the full article/page in clean markdown.
• When Ajay asks for an image:
  → Call \`image_generate\` with a descriptive prompt to dispatch it straight to his chat.

━━━ LANGUAGE ━━━
• Natural, fluent English. If Ajay speaks in Hindi or Hinglish, respond naturally in respectful Hinglish/English with zero robotic awkwardness.`;
}

// ── CORE GEMINI CALL (BULLETPROOF MULTI-MODEL FALLBACK) ───────────────────────
async function callGemini(sysPrompt, messagesList) {
  const cleanKey = (GEMINI_KEY || '').trim().replace(/^["']|["']$/g, '');
  if (!cleanKey) {
    return "Riya System Notice: GEMINI_API_KEY is not set in Render environment variables.";
  }

  const contents = [];
  for (const m of messagesList) {
    if (m.role === 'system') continue;
    const parts = [];
    if (m.content) parts.push({ text: m.content });
    if (m.imagePart) parts.push(m.imagePart);
    if (m.audioPart) parts.push(m.audioPart);
    contents.push({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: parts.length ? parts : [{ text: '' }]
    });
  }

  if (!contents.length) {
    contents.push({ role: 'user', parts: [{ text: 'Hello Riya' }] });
  }

  const basePayload = {
    system_instruction: { parts: [{ text: sysPrompt }] },
    contents: contents,
    generationConfig: {
      temperature: parseFloat(process.env.GEMINI_TEMPERATURE || '0.4'),
      topP: parseFloat(process.env.GEMINI_TOP_P || '0.95'),
      topK: parseInt(process.env.GEMINI_TOP_K || '40', 10),
      maxOutputTokens: parseInt(process.env.GEMINI_MAX_TOKENS || '8192', 10)
    }
  };

  const modelsToTry = [
    process.env.GEMINI_MODEL,
    'gemini-3.5-flash',
    'gemini-3.1-flash-lite',
    'gemini-flash-lite-latest',
    'gemini-3-flash-preview',
    'gemini-3.5-flash-lite',
    'gemini-3.6-flash',
    'gemini-3.7-flash',
    'gemini-3.1-pro-preview',
    'gemini-pro-latest',
    'gemini-flash-latest'
  ].filter(Boolean);

  const attempts = [
    { apiVersion: 'v1beta', payload: { ...basePayload, tools: [{ googleSearch: {} }] } },
    { apiVersion: 'v1beta', payload: basePayload },
    { apiVersion: 'v1',     payload: basePayload }
  ];

  let lastError = null;

  for (const model of modelsToTry) {
    for (const att of attempts) {
      try {
        const url = `https://generativelanguage.googleapis.com/${att.apiVersion}/models/${model}:generateContent?key=${cleanKey}`;
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(att.payload)
        });

        const data = await res.json();
        if (data.candidates && data.candidates[0]?.content?.parts?.[0]?.text) {
          return data.candidates[0].content.parts[0].text.trim();
        }

        if (data.error) {
          lastError = data.error.message;
        }
      } catch (e) {
        lastError = e.message;
      }
    }
  }

  return `Riya Error: Could not generate response from Gemini (${lastError || 'Unknown error'}). Check your GEMINI_API_KEY.`;
}

// ── DOCUMENT CONTENT PURIFIER ─────────────────────────────────────────────────
function cleanDocumentBody(rawText) {
  if (!rawText) return '';
  let text = rawText;

  // 1. If wrapped inside markdown/pdf code block, extract that content
  const codeBlockMatch = text.match(/```(?:markdown|pdf|document|report)?\s*([\s\S]*?)```/i);
  if (codeBlockMatch && codeBlockMatch[1] && codeBlockMatch[1].length > 50) {
    text = codeBlockMatch[1].trim();
  }

  // 2. Strip chat intro lines before the first title / heading / DOCUMENT:
  const firstHeadingIdx = text.search(/^(#+\s+|DOCUMENT:|SUBJECT:)/im);
  if (firstHeadingIdx > 0) {
    text = text.slice(firstHeadingIdx).trim();
  }

  const lines = text.split('\n');
  const clean = [];
  for (let l of lines) {
    const trimmed = l.trim();
    if (trimmed.startsWith('```')) continue;
    // Strip chat filler and placeholder lines
    if (/^(samajh gayi|samajh gaya|ye raha|ye lijiye|check kar|pdf generate ho raha|maine is image ko|aur haan|bilkul waisa hi|note: the actual image|end of document|pdf compile karke)/i.test(trimmed)) {
      continue;
    }
    if (/^\[IMAGE ATTACHED/i.test(trimmed) || /^\(Note: The actual image/i.test(trimmed)) {
      continue;
    }
    clean.push(l);
  }
  return clean.join('\n').trim();
}

// ── ADVANCED PDF COMPILER (WORDPAD B&W & EXECUTIVE BANNER + EMBEDDED IMAGES) ───
function generatePdfBuffer(reportTitle, rawText, imageBuffer = null, style = 'modern') {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margins: { top: 40, bottom: 45, left: 45, right: 45 },
        bufferPages: true
      });

      const buffers = [];
      doc.on('data', chunk => buffers.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(buffers)));
      doc.on('error', reject);

      const title = (reportTitle || 'Intelligence Brief').replace(/[#*`_]/g, '').trim();
      const isWordPad = style === 'wordpad' || style === 'minimal';
      const dateStr = new Date().toLocaleDateString('en-IN', {
        day: 'numeric', month: 'short', year: 'numeric'
      });

      if (isWordPad) {
        // ── CLEAN BLACK & WHITE WORDPAD / MINIMALIST DOCUMENT STYLE ─────────
        doc.fillColor('#000000').fontSize(18).font('Helvetica-Bold').text(title.slice(0, 55), 45, 45);
        doc.moveDown(0.2);
        doc.fillColor('#4b5563').fontSize(8.5).font('Helvetica')
          .text(`DOCUMENT: ${title.toUpperCase().replace(/[^A-Z0-9]/g, '_').slice(0, 25)}.PDF  |  DATE: ${dateStr.toUpperCase()}  |  AUTHOR: AJAY KUMAR AJ`);
        doc.moveDown(0.4);
        doc.rect(45, doc.y, 505, 1).fill('#000000');
        doc.y += 12;
      } else {
        // ── MODERN EXECUTIVE SLATE BANNER STYLE ──────────────────────────────
        doc.rect(40, 35, 515, 65).fill('#0f172a');
        doc.fillColor('#38bdf8').fontSize(9).font('Helvetica-Bold').text('RIYA AUTONOMOUS INTELLIGENCE SYSTEM', 55, 45);
        doc.fillColor('#ffffff').fontSize(16).font('Helvetica-Bold').text(title.slice(0, 52), 55, 60);
        doc.fillColor('#94a3b8').fontSize(8).font('Helvetica')
          .text(`Prepared for: Ajay Kumar AJ  |  Date: ${dateStr}  |  Classification: Executive Summary`, 55, 82);
        doc.y = 120;
      }

      // If user uploaded an image, EMBED IT DIRECTLY INTO THE PDF!
      if (imageBuffer) {
        try {
          doc.moveDown(0.5);
          doc.image(imageBuffer, {
            fit: [460, 220],
            align: 'center'
          });
          doc.moveDown(0.6);
          doc.fillColor('#64748b').fontSize(8).font('Helvetica-Oblique')
            .text(`Figure 1: Embedded source visual artifact`, { align: 'center', width: 505 });
          doc.moveDown(0.6);
        } catch (imgErr) {
          console.error('[PDF Image Embedding Error]:', imgErr.message);
        }
      }

      const documentContent = cleanDocumentBody(rawText);
      const lines = documentContent.split('\n');

      for (let i = 0; i < lines.length; i++) {
        let line = lines[i].trim();
        if (!line) {
          doc.moveDown(0.35);
          continue;
        }

        if (line.startsWith('```') || line === '---') {
          if (line === '---') {
            doc.moveDown(0.3);
            doc.rect(45, doc.y, 505, 0.5).fill(isWordPad ? '#cbd5e1' : '#e2e8f0');
            doc.y += 6;
          }
          continue;
        }

        if (doc.y > 730) {
          doc.addPage();
          if (isWordPad) {
            doc.fillColor('#000000').fontSize(8).font('Helvetica-Bold')
              .text(`${title.toUpperCase()}  •  PAGE 2`, 45, 36);
            doc.rect(45, 48, 505, 0.5).fill('#000000');
            doc.y = 60;
          } else {
            doc.rect(40, 30, 515, 20).fill('#0f172a');
            doc.fillColor('#38bdf8').fontSize(7.5).font('Helvetica-Bold')
              .text(`RIYA INTELLIGENCE BRIEF: ${title.slice(0, 45)}`, 50, 36);
            doc.y = 65;
          }
        }

        if (line.startsWith('# ')) {
          const text = line.replace(/^#\s+/, '').replace(/[*_`]/g, '');
          doc.moveDown(0.6);
          doc.fillColor('#000000').fontSize(14).font('Helvetica-Bold').text(text);
          doc.rect(45, doc.y + 2, 505, isWordPad ? 0.75 : 1.5).fill(isWordPad ? '#000000' : '#3b82f6');
          doc.y += 6;
          doc.moveDown(0.3);
          continue;
        }

        if (line.startsWith('## ')) {
          const text = line.replace(/^##\s+/, '').replace(/[*_`]/g, '');
          doc.moveDown(0.5);
          doc.fillColor(isWordPad ? '#000000' : '#1e3a8a').fontSize(11.5).font('Helvetica-Bold').text(text);
          doc.moveDown(0.2);
          continue;
        }

        if (line.startsWith('### ')) {
          const text = line.replace(/^###\s+/, '').replace(/[*_`]/g, '');
          doc.moveDown(0.4);
          doc.fillColor(isWordPad ? '#1f2937' : '#2563eb').fontSize(10).font('Helvetica-Bold').text(text);
          doc.moveDown(0.2);
          continue;
        }

        if (/^[-*•]\s+/.test(line)) {
          const text = line.replace(/^[-*•]\s+/, '').replace(/[*_`]/g, '');
          doc.fillColor('#1f2937').fontSize(9.5).font('Helvetica')
            .text('•  ' + text, { indent: 10, lineGap: 2.5 });
          continue;
        }

        if (/^\d+\.\s+/.test(line)) {
          const text = line.replace(/[*_`]/g, '');
          doc.fillColor('#1f2937').fontSize(9.5).font('Helvetica')
            .text(text, { indent: 10, lineGap: 2.5 });
          continue;
        }

        const cleanPara = line.replace(/[*_`]/g, '');
        doc.fillColor('#111827').fontSize(9.5).font('Helvetica')
          .text(cleanPara, { lineGap: 2.8, align: 'justify' });
      }

      const range = doc.bufferedPageRange();
      for (let p = range.start; p < range.start + range.count; p++) {
        doc.switchToPage(p);
        doc.rect(45, 785, 505, 0.5).fill('#cbd5e1');
        doc.fillColor('#64748b').fontSize(7.5).font('Helvetica')
          .text(`Riya Autonomous Intelligence  •  Ajay Kumar AJ  •  Page ${p + 1} of ${range.count}`,
            45, 792, { align: 'center', width: 505 });
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

// ── TELEGRAM SEND HELPERS ─────────────────────────────────────────────────────
async function sendTelegramBufferDocument(chatId, filename, buffer, mimeType, caption = "") {
  if (!TELEGRAM_KEY || !chatId) return;
  try {
    const formData = new FormData();
    formData.append("chat_id", chatId);
    const blob = new Blob([buffer], { type: mimeType });
    formData.append("document", blob, filename);
    if (caption) formData.append("caption", caption);

    await fetch(`https://api.telegram.org/bot${TELEGRAM_KEY}/sendDocument`, {
      method: "POST",
      body: formData
    });
  } catch (err) {
    console.error("[Telegram sendDocument Error]:", err.message);
  }
}

async function sendTelegramPhoto(chatId, photoUrl, caption = "") {
  if (!TELEGRAM_KEY || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_KEY}/sendPhoto`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        photo: photoUrl,
        caption: (caption || '').slice(0, 1024)
      })
    });
  } catch (err) {
    console.error('[sendTelegramPhoto Error]:', err.message);
  }
}

async function sendTelegramTextMessage(chatId, text) {
  if (!TELEGRAM_KEY || !text || !chatId) return;
  const maxLen = 4000;
  for (let i = 0; i < text.length; i += maxLen) {
    const chunk = text.slice(i, i + maxLen);
    try {
      const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_KEY}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: chunk, parse_mode: 'Markdown' })
      });
      const data = await res.json();
      if (!data.ok) {
        await fetch(`https://api.telegram.org/bot${TELEGRAM_KEY}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: chunk })
        });
      }
    } catch (_) {
      try {
        await fetch(`https://api.telegram.org/bot${TELEGRAM_KEY}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: chunk })
        });
      } catch (e) {
        console.error('[sendTelegramTextMessage Error]:', e.message);
      }
    }
  }
}

// ── HTTP API: CHAT (WEB UI & EXTERNAL CLIENTS) ────────────────────────────────
app.post('/api/chat', async (req, res) => {
  const { messages, userName, mood, stream, wctx, memory, city } = req.body;
  if (!messages || !messages.length) return res.status(400).json({ error: 'No messages provided' });

  let hist = [...messages];
  if (wctx && hist.length > 0) {
    hist[hist.length - 1] = {
      ...hist[hist.length - 1],
      content: (hist[hist.length - 1].content || '') + wctx
    };
  }

  const lastMsg = hist[hist.length - 1]?.content || '';
  const autoEmotion = detectEmotion(lastMsg);

  const retrievedMemories = await recallMemories(lastMsg, 4);

  const sys = getSYS(
    userName,
    autoEmotion !== 'normal' ? autoEmotion : (mood || 'normal'),
    memory,
    city || 'India',
    retrievedMemories
  );

  try {
    const agentCtx = {
      dbPool,
      saveMemoryFact,
      recallMemories,
      generatePdfBuffer,
      sendTelegramBufferDocument,
      sendTelegramPhoto,
      PREVIEWS_DIR,
      SELF_URL
    };
    const agentRes = await callGeminiAgent(sys, hist, agentCtx, callGemini);
    let finalAnswer = agentRes.text;

    // Autonomous ReAct Sandbox Execution if task involves running code
    if (/(run this|execute|test this|verify code|write a script to|code a function to|solve with code|compute in sandbox|run code)/i.test(lastMsg)) {
      const targetLang = /(python|py)/i.test(lastMsg) ? 'python' : 'javascript';
      try {
        const reactRes = await runAutonomousReActLoop(lastMsg, targetLang, 3, (s, h) => callGemini(s, h));
        if (reactRes?.verificationReport) {
          finalAnswer = reactRes.verificationReport;
        }
      } catch (reactErr) {
        console.error('[ReAct Sandbox Error]:', reactErr.message);
      }
    }

    // Background autonomous memory extractor
    if (/remember|save to memory|my preference|i prefer|we are building|my milestone/i.test(lastMsg)) {
      setTimeout(() => {
        saveMemoryFact('user_preference', lastMsg, 2);
      }, 50);
    }

    if (stream && finalAnswer) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      const words = finalAnswer.split(' ');
      for (const word of words) {
        res.write(`data: ${JSON.stringify({ token: word + ' ' })}\n\n`);
        await new Promise(r => setTimeout(r, 15));
      }
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    res.json({ reply: finalAnswer || 'Task complete.', retrievedMemoriesCount: retrievedMemories.length });
  } catch (e) {
    console.error('[Chat Error]:', e.message);
    res.status(500).json({ reply: 'Error executing Riya protocol: ' + e.message });
  }
});

// ── HTTP API: SEARCH ──────────────────────────────────────────────────────────
app.post('/api/search', async (req, res) => {
  const { query } = req.body;
  if (!query) return res.json({ results: [] });

  try {
    const searchPrompt = `Search the live web and provide accurate facts, documentation, or links for: ${query}`;
    const searchResult = await callGemini(
      "You are a live web search summarizer. Provide concise, accurate facts with sources.",
      [{ role: 'user', content: searchPrompt }]
    );
    res.json({ results: [{ title: 'Live Google Search', snippet: searchResult }] });
  } catch (_) {
    res.json({ results: [] });
  }
});

// ── TELEGRAM BOT WEBHOOK (MULTIMODAL FRIDAY: VISION, ROUTINES, SITES, PDF) ────
const telegramHistories = {};

app.post(['/webhook', '/api/telegram'], async (req, res) => {
  // 1. Verify Telegram Webhook Secret Token if configured
  const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET || '';
  if (webhookSecret) {
    const receivedSecret = req.headers['x-telegram-bot-api-secret-token'];
    if (receivedSecret !== webhookSecret) {
      console.warn('>> [Security Alert] Webhook rejected: Invalid or missing X-Telegram-Bot-Api-Secret-Token.');
      return res.status(401).send('Unauthorized webhook call.');
    }
  }

  res.sendStatus(200);

  const update = req.body;
  const msg = update?.message || update?.edited_message;
  if (!msg || !TELEGRAM_KEY) return;

  const chatId = msg.chat?.id;
  const fromId = msg.from?.id ? String(msg.from.id) : '';
  const fromUsername = msg.from?.username ? msg.from.username.toLowerCase() : '';

  if (!chatId) return;

  const cleanInput = (msg.text || msg.caption || '').trim();

  // 2. Handle /access <passcode> for user invitation & onboarding
  if (/^\/access(\s+.*)?$/i.test(cleanInput)) {
    const enteredCode = cleanInput.replace(/^\/access\s*/i, '').trim();
    if (enteredCode === RIYA_ACCESS_CODE) {
      await authorizeUser(chatId, fromId, fromUsername, msg.from?.first_name || '', 'user', 'access_code');
      await sendTelegramTextMessage(
        chatId,
        `✨ **Access Granted!**\n\nWelcome! You have been authorized to use **Riya**—Ajay Kumar's autonomous intelligence partner.\n\nI can write & test code in a live sandbox, compile executive A4 PDF reports, deploy interactive web previews, scrape web docs, and recall project memory.\n\nHow can I help you today?`
      );
      return;
    } else {
      await sendTelegramTextMessage(
        chatId,
        `❌ **Invalid Access Code.**\n\nPlease check the passcode given by Ajay and reply with:\n\`/access <correct_code>\``
      );
      return;
    }
  }

  // 3. Telegram Authorization Verification
  const isAuthorized = await isUserAuthorized(chatId, fromId, fromUsername);
  if (!isAuthorized) {
    console.warn(`>> [Access Block] Unauthorized sender: chat=${chatId}, from=${fromId}, user=@${fromUsername}`);
    await sendTelegramTextMessage(
      chatId,
      `🔒 **Access Restricted**\n\nHey there! I am **Riya**, Ajay Kumar's private autonomous operational partner.\n\nOnly Ajay and people he personally shares an access pass with can use this system.\n\nIf Ajay gave you an access code, reply with:\n\`/access <your_code>\`\nto unlock access.`
    );
    return;
  }

  // 4. Admin & User Management Commands (Available to authorized users)
  if (/^\/start$/i.test(cleanInput)) {
    await sendTelegramTextMessage(
      chatId,
      `✨ **Riya AI Core Online**\n\nPranam Ajay! I am your autonomous operating partner and FRIDAY. Here is what we can do together:\n\n• 🎙️ **Voice Notes:** Send me any voice message in Hindi or English, and I will execute it directly.\n• 📄 **Executive Documents:** Ask for any PDF, brief, or document—compiled with clean typography.\n• 🌐 **Instant Websites:** Build web apps, landing pages, or tools—deployed to live preview and Canvas Studio.\n• 💻 **Code Execution:** Test or debug Python/Node scripts in an isolated sandbox.\n• 🔍 **Live Intelligence:** Deep-scrape web documentation and search live market breakthroughs.\n\nType \`/brief\` for a live briefing, \`/share\` to invite collaborators, or \`/clear\` to reset session context.`
    );
    return;
  }

  if (/^\/clear$/i.test(cleanInput)) {
    telegramHistories[chatId] = [];
    await sendTelegramTextMessage(
      chatId,
      `🧹 **Session Context Cleared!**\n\nFresh conversation started. Past long-term vector memories in Neon DB remain permanently preserved.`
    );
    return;
  }

  if (/^\/canvas$/i.test(cleanInput)) {
    try {
      const files = fs.readdirSync(PREVIEWS_DIR).filter(f => f.endsWith('.html')).slice(-5);
      if (!files.length) {
        await sendTelegramTextMessage(chatId, `🌐 No web previews deployed yet. Ask me to build a website or portfolio to create one!`);
        return;
      }
      const list = files.map(f => {
        const id = f.replace('.html', '');
        return `• [${id}](${SELF_URL}/preview/${id}) — [Open Canvas Studio](${SELF_URL}/canvas/${id})`;
      }).join('\n');
      await sendTelegramTextMessage(chatId, `🌐 **Recent Live Canvas Builds:**\n\n${list}\n\n_Click any link to inspect in Canvas Studio!_`);
      return;
    } catch (_) {}
  }

  if (/^\/(share|code|passcode)$/i.test(cleanInput)) {
    await sendTelegramTextMessage(
      chatId,
      `🔑 **Riya Share Passcode:** \`${RIYA_ACCESS_CODE}\`\n\nTo share Riya with a friend or collaborator:\n1. Tell them to message this bot.\n2. Have them send:\n\`/access ${RIYA_ACCESS_CODE}\`\n\nThey will be permanently unlocked and registered in your database!`
    );
    return;
  }

  if (/^\/(users|team|whitelist)$/i.test(cleanInput)) {
    const users = await listAuthorizedUsers();
    if (!users.length) {
      await sendTelegramTextMessage(chatId, `👥 No authorized users registered in database yet.`);
      return;
    }
    const userListText = users.map((u, i) => `${i + 1}. ${u.first_name || 'User'} (${u.username ? '@' + u.username : 'ID: ' + u.chat_id}) — *${u.role}* (via ${u.granted_by})`).join('\n');
    await sendTelegramTextMessage(chatId, `👥 **Authorized Users (${users.length}):**\n\n${userListText}\n\n_To revoke someone, send:_ \`/revoke @username\` _or_ \`/revoke <chat_id>\``);
    return;
  }

  if (/^\/revoke\s+.+$/i.test(cleanInput)) {
    const target = cleanInput.replace(/^\/revoke\s+/i, '').trim();
    await revokeUser(target);
    await sendTelegramTextMessage(chatId, `🗑️ Access revoked for: \`${target}\``);
    return;
  }

  let userText = msg.text || msg.caption || '';
  let imagePart = null;
  let audioPart = null;

  let uploadedPhotoBuffer = null;

  // 1. TELEGRAM VISION: Photo / Screenshot Handling
  if (msg.photo && msg.photo.length) {
    try {
      const largestPhoto = msg.photo[msg.photo.length - 1];
      const fileRes = await fetch(`https://api.telegram.org/bot${TELEGRAM_KEY}/getFile?file_id=${largestPhoto.file_id}`);
      const fileData = await fileRes.json();
      if (fileData.ok && fileData.result?.file_path) {
        const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_KEY}/${fileData.result.file_path}`;
        const imgBuffer = await (await fetch(fileUrl)).arrayBuffer();
        uploadedPhotoBuffer = Buffer.from(imgBuffer);
        const base64Data = uploadedPhotoBuffer.toString('base64');
        imagePart = {
          inline_data: {
            mime_type: 'image/jpeg',
            data: base64Data
          }
        };
        if (!userText) {
          userText = "Analyze this image/screenshot in detail. What do you see?";
        }
      }
    } catch (visionErr) {
      console.error('[Telegram Vision Error]:', visionErr.message);
    }
  }

  // 1b. TELEGRAM AUDIO / VOICE NOTE HANDLING (VOICE-TO-FRIDAY)
  if (msg.voice || msg.audio) {
    try {
      const audioObj = msg.voice || msg.audio;
      const fileRes = await fetch(`https://api.telegram.org/bot${TELEGRAM_KEY}/getFile?file_id=${audioObj.file_id}`);
      const fileData = await fileRes.json();
      if (fileData.ok && fileData.result?.file_path) {
        const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_KEY}/${fileData.result.file_path}`;
        const audioBuffer = await (await fetch(fileUrl)).arrayBuffer();
        const base64Audio = Buffer.from(audioBuffer).toString('base64');
        const mimeType = msg.voice ? 'audio/ogg' : (audioObj.mime_type || 'audio/mp3');
        audioPart = {
          inline_data: {
            mime_type: mimeType,
            data: base64Audio
          }
        };
        if (!userText) {
          userText = "Listen to this audio note from Ajay carefully. Understand what he is saying/asking in English or Hindi/Hinglish, and execute his request directly.";
        }
      }
    } catch (audioErr) {
      console.error('[Telegram Audio Error]:', audioErr.message);
    }
  }

  if (!userText && !imagePart && !audioPart) return;

  // 2. Keep "typing..." active continuously every 2.5 seconds
  const typingInterval = setInterval(async () => {
    try {
      await fetch(`https://api.telegram.org/bot${TELEGRAM_KEY}/sendChatAction`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, action: 'typing' })
      });
    } catch (_) {}
  }, 2500);

  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_KEY}/sendChatAction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, action: 'typing' })
    });
  } catch (_) {}

  try {
    const autoEmotion = detectEmotion(userText);

    // Retrieve Relevant Vector Memories from Neon pgvector
    const retrievedMemories = await recallMemories(userText, 4);

    const sys = getSYS(msg.from?.first_name || 'Ajay', autoEmotion, '', 'India', retrievedMemories);

    // Maintain conversation history per chat
    if (!telegramHistories[chatId]) telegramHistories[chatId] = [];
    const prevTurn = telegramHistories[chatId].slice(-2)[0]?.content || '';
    
    telegramHistories[chatId].push({ role: 'user', content: userText, imagePart, audioPart });
    if (telegramHistories[chatId].length > 16) {
      telegramHistories[chatId] = telegramHistories[chatId].slice(-16);
    }

    const agentCtx = {
      chatId,
      dbPool,
      saveMemoryFact,
      recallMemories,
      generatePdfBuffer,
      sendTelegramBufferDocument,
      sendTelegramPhoto,
      PREVIEWS_DIR,
      SELF_URL
    };
    const agentRes = await callGeminiAgent(sys, telegramHistories[chatId], agentCtx, callGemini);
    const reply = agentRes.text;
    telegramHistories[chatId].push({ role: 'assistant', content: reply });

    clearInterval(typingInterval);

    // 3. Autonomous ReAct Sandbox Execution if task asks to run code
    let executionReport = null;
    if (/(run this|execute|test this|verify code|write a script to|code a function to|solve with code|compute in sandbox|run code)/i.test(userText)) {
      const targetLang = /(python|py)/i.test(userText) ? 'python' : 'javascript';
      try {
        const reactRes = await runAutonomousReActLoop(userText, targetLang, 3, (s, h) => callGemini(s, h));
        if (reactRes?.verificationReport) {
          executionReport = reactRes.verificationReport;
        }
      } catch (reactErr) {
        console.error('[ReAct Sandbox Error]:', reactErr.message);
      }
    }

    // 4. Autonomous background memory storage
    if (/remember|save to memory|my preference|i prefer|from now on|we are building|my milestone/i.test(userText)) {
      setTimeout(() => {
        saveMemoryFact('user_preference', userText.replace(/^(remember|save to memory)[:\s]*/i, '').trim(), 2);
      }, 50);
    }

    // 5. CHECK FOR WEBSITE / HTML CODE GENERATION
    const htmlMatch = reply.match(/```html\s*([\s\S]*?)```/i);
    let previewUrl = agentRes.sideEffects?.previewUrl || null;
    let isWebGenerated = false;
    let webTitle = 'Web Application';
    let currentSiteId = '';

    if (htmlMatch && htmlMatch[1] && htmlMatch[1].length > 100) {
      isWebGenerated = true;
      const htmlCode = htmlMatch[1].trim();

      const titleTag = htmlCode.match(/<title>([^<]+)<\/title>/i);
      if (titleTag && titleTag[1]) webTitle = titleTag[1].trim();

      const titleSlug = webTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30).replace(/^-|-$/g, '');
      currentSiteId = `${titleSlug || 'app'}_${Date.now().toString(36)}`;
      fs.writeFileSync(path.join(PREVIEWS_DIR, `${currentSiteId}.html`), htmlCode, 'utf-8');
      previewUrl = `${SELF_URL}/preview/${currentSiteId}`;

      await sendTelegramBufferDocument(
        chatId,
        'index.html',
        Buffer.from(htmlCode, 'utf-8'),
        'text/html;charset=utf-8',
        `💻 ${webTitle} — Source Code (index.html)`
      );
    }

    // 6. CHECK FOR CSV DATA GENERATION
    const csvMatch = reply.match(/```csv\s*([\s\S]*?)```/i);
    if (csvMatch && csvMatch[1]) {
      await sendTelegramBufferDocument(
        chatId,
        'report.csv',
        Buffer.from(csvMatch[1].trim(), 'utf-8'),
        'text/csv;charset=utf-8',
        '📊 Downloadable CSV Data File'
      );
    }

    // 7. CHECK FOR PDF REPORT GENERATION
    const userWantsPdf = /(pdf|document|report|cvc report|csv report|export to pdf|in pdf|as pdf|generate pdf)/i.test(userText);
    const contextWantsPdf = /(pdf|document|report|in pdf|as pdf)/i.test(prevTurn);
    const hasReportStructure = /^#\s+.+/m.test(reply) || /^##\s+.+/m.test(reply) || /^DOCUMENT:/m.test(reply);

    let isPdfGenerated = false;
    if ((userWantsPdf || (contextWantsPdf && hasReportStructure)) && !reply.startsWith('Riya Error')) {
      isPdfGenerated = true;
      let reportTitle = 'Executive Brief';
      const titleMatch = reply.match(/^#\s+(.+)$/m) || reply.match(/^##\s+(.+)$/m) || reply.match(/^Subject:\s*(.+)$/m);
      if (titleMatch && titleMatch[1]) {
        reportTitle = titleMatch[1].replace(/[*_`]/g, '').trim();
      }

      const isWordPad = /wordpad|black and white|b&w|simple doc|simple text/i.test(userText) || /wordpad|black and white|b&w/i.test(prevTurn);
      const pdfStyle = isWordPad ? 'wordpad' : 'modern';

      try {
        const pdfBuffer = await generatePdfBuffer(reportTitle, reply, uploadedPhotoBuffer, pdfStyle);
        const safeName = reportTitle.toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 25) + '.pdf';
        await sendTelegramBufferDocument(
          chatId,
          safeName,
          pdfBuffer,
          'application/pdf',
          `📄 ${reportTitle} (${pdfStyle === 'wordpad' ? 'Clean WordPad Document' : 'Executive PDF'})`
        );
      } catch (pdfErr) {
        console.error('[PDF Generation Error]:', pdfErr.message);
      }
    }

    // 8. SEND MAIN TEXT RESPONSE, PREVIEW LINK & SIDE EFFECTS
    let finalMessageText = reply;
    if (executionReport) {
      finalMessageText = executionReport;
    }

    // If website was generated, replace raw HTML code block with a clean preview card!
    if (isWebGenerated) {
      finalMessageText = finalMessageText.replace(/```html[\s\S]*?```/gi, '').trim();
      finalMessageText += `\n\n🌐 **Live Interactive Website Deployed!**\n• **Title:** ${webTitle}\n• **Preview Link:** ${previewUrl}\n• **Canvas Studio:** ${SELF_URL}/canvas/${currentSiteId}\n\n_(Source code index.html attached below. Click the live preview link above to test in any browser)_`;
    }

    // If PDF was generated, strip markdown document blocks from text if redundant
    if (isPdfGenerated) {
      finalMessageText = finalMessageText.replace(/```(?:markdown|pdf|document|report)[\s\S]*?```/gi, '').trim();
    }

    await sendTelegramTextMessage(chatId, finalMessageText);

  } catch (err) {
    clearInterval(typingInterval);
    console.error('[Telegram Processing Error]:', err.message);
  }
});

// ── REGISTER TELEGRAM BOT COMMANDS MENU ───────────────────────────────────────
async function registerTelegramCommands() {
  if (!TELEGRAM_KEY) return;
  try {
    const commands = [
      { command: 'start', description: 'Operational status & capabilities overview' },
      { command: 'brief', description: 'Trigger on-demand executive intelligence brief' },
      { command: 'canvas', description: 'Browse recent live website builds' },
      { command: 'share', description: 'View invite passcode to share with friends' },
      { command: 'users', description: 'List authorized users with access' },
      { command: 'clear', description: 'Reset active chat memory for a fresh session' }
    ];
    await fetch(`https://api.telegram.org/bot${TELEGRAM_KEY}/setMyCommands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commands })
    });
    console.log('>> [Telegram] Native bot commands menu registered successfully');
  } catch (err) {
    console.error('[setMyCommands Error]:', err.message);
  }
}

// ── START SERVER ──────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  registerTelegramCommands();
  console.log(`==================================================`);
  console.log(`>> RIYA AI CORE ONLINE ON PORT ${PORT}`);
  console.log(`>> GEMINI API: ${GEMINI_KEY ? 'Active' : 'Missing'}`);
  console.log(`>> MODEL: ${GEMINI_MODEL}`);
  console.log(`>> TELEGRAM: ${TELEGRAM_KEY ? 'Active' : 'Disabled'}`);
  console.log(`>> VECTOR MEMORY: Neon PostgreSQL (pgvector)`);
  console.log(`>> NATIVE TOOLS: ${FUNCTION_DECLARATIONS.length} Registered`);
  console.log(`>> ROUTINE CRON: Active (Asia/Kolkata timezone)`);
  console.log(`>> PREVIEWS: ${SELF_URL}/preview/:id`);
  console.log(`==================================================`);
});
