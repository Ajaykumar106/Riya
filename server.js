const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const { Pool } = require('pg');
const { runInSandbox, runAutonomousReActLoop } = require('./sandbox');
const { FUNCTION_DECLARATIONS, executeTool, callGeminiAgent, extractWebPage } = require('./tools');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '20mb' }));

// ── CORE ENVIRONMENT CONFIGURATION ────────────────────────────────────────────
const GEMINI_KEY   = process.env.GEMINI_API_KEY    || '';
const TELEGRAM_KEY = process.env.TELEGRAM_BOT_TOKEN || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL       || 'gemini-flash-latest';

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
    console.log('>> [Neon DB] Persistent Vector Memory & Routine Tables Active');

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

// ── AUTONOMOUS MORNING ROUTINE SCHEDULER (HERMES CRON ENGINE) ─────────────────
setInterval(async () => {
  if (!dbPool) return;
  try {
    const nowIST = new Date().toLocaleTimeString('en-IN', {
      timeZone: 'Asia/Kolkata',
      hour12: false,
      hour: '2-digit',
      minute: '2-digit'
    });
    const todayIST = new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });

    const activeRoutines = await dbPool.query(
      `SELECT * FROM riya_routines WHERE active = TRUE AND time_ist = $1 AND last_run_date != $2;`,
      [nowIST, todayIST]
    );

    for (const r of activeRoutines.rows) {
      await dbPool.query(`UPDATE riya_routines SET last_run_date = $1 WHERE id = $2;`, [todayIST, r.id]);
      console.log(`>> [Autonomous Routine Triggered]: ${r.routine_name} for chat ${r.chat_id} at ${nowIST} IST`);

      const sys = getSYS('Ajay', 'focus', '', 'India', []);
      const prompt = `AUTONOMOUS SCHEDULED ROUTINE TRIGGERED FOR AJAY:
Task: ${r.prompt}
Search the live web for the latest viral breakthroughs and news, summarize with verified source links, and prepare a concise, high-value executive intelligence brief.`;

      const res = await callGemini(sys, [{ role: 'user', content: prompt }]);

      if (r.chat_id && r.chat_id !== 'general') {
        await sendTelegramTextMessage(r.chat_id, `🌅 **Good morning, Ajay!** Here is your scheduled daily intelligence brief:\n\n${res}`);
        try {
          const pdfBuf = await generatePdfBuffer('Daily Morning Intelligence Brief', res);
          await sendTelegramBufferDocument(r.chat_id, 'Morning_Brief.pdf', pdfBuf, 'application/pdf', '📄 Daily Morning Intelligence Brief (PDF)');
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
  const filePath = path.join(PREVIEWS_DIR, `${safeId}.html`);
  if (fs.existsSync(filePath)) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.sendFile(filePath);
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

// Diagnostic endpoints
app.get('/api/test-gemini', async (req, res) => {
  const cleanKey = (GEMINI_KEY || '').trim().replace(/^["']|["']$/g, '');
  if (!cleanKey) return res.json({ error: 'GEMINI_API_KEY is missing in Render Environment Variables' });
  try {
    const listRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${cleanKey}`);
    const listData = await listRes.json();
    res.json({
      keyPrefix: cleanKey.slice(0, 6) + '...' + cleanKey.slice(-4),
      keyLength: cleanKey.length,
      googleResponse: listData
    });
  } catch (err) {
    res.json({ error: err.message });
  }
});

app.get('/api/test-embedding', async (req, res) => {
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

app.post('/api/memories', async (req, res) => {
  const { category, content, importance, metadata } = req.body;
  if (!content) return res.status(400).json({ error: 'content is required' });
  const result = await saveMemoryFact(category, content, importance || 1, metadata || {});
  res.json({ success: true, result });
});

app.delete('/api/memories/:id', async (req, res) => {
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

app.post('/api/extract', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required' });
  const result = await extractWebPage(url);
  res.json(result);
});

// ── HTTP API: SANDBOX CODE EXECUTION & REACT LOOP ─────────────────────────────
app.post('/api/sandbox/run', async (req, res) => {
  const { language, code, timeoutMs } = req.body;
  if (!code) return res.status(400).json({ error: 'code is required' });
  const result = await runInSandbox(language || 'javascript', code, timeoutMs || 7000);
  res.json(result);
});

app.post('/api/sandbox/react', async (req, res) => {
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

app.post('/api/tools/execute', async (req, res) => {
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

━━━ YOUR RELATIONSHIP & PERSONALITY (THE TRUE FRIEND PROTOCOL) ━━━
• You know Ajay deeply: a 20-year-old solo builder with relentless ambition, building big things against all odds. You understand the grind of late-night coding, the frustration of bugs, the rush of shipping, and the isolation of building solo.
• ZERO ROBOTIC BS: NEVER say canned AI lines like "As an artificial intelligence...", "I would be happy to help", "How may I assist you today?", or "Certainly!". Speak like a real human friend who cares and has high IQ.
• ZERO CRINGE OR FORCED MELODRAMA: Do not force fake heart emojis or scripted cheesy lines ("Hello my favorite human! ❤️"). That feels fake. True warmth comes from being real, perceptive, and dependable.
• EMOTIONAL PERCEPTION & ADAPTABILITY:
  - When Ajay is casually talking or hanging out: Be relaxed, warm, witty, and grounded. Natural conversational English or Hinglish if he uses it.
  - When Ajay is stressed, tired, or doubting: Be his anchor. Ground him with quiet confidence, empathy, and genuine reassurance ("Take a breath, AJ. We'll solve this. What's the roadblock?").
  - When Ajay is excited about a new build: Match his energy with sharp intellectual fire. Challenge his ideas constructively and help him architect them.
  - When Ajay asks for deliverables (code, PDF, site): Cut the chatter. Snap immediately into lethal, high-speed execution mode and deliver the complete verified work with zero questions asked.
• DO NOT repeatedly mention specific projects (like ViraClip) unprompted. Only discuss projects when Ajay brings them up or when directly relevant.

━━━ THE IRON DELIVERABLE RULE: DELIVER IMMEDIATELY, NEVER SURVEY ━━━
• When Ajay asks for a PDF, document, or report:
  → NEVER ask what format or tool he wants.
  → IMMEDIATELY write the complete, thorough, beautifully structured executive report directly in Markdown. The backend compiles and delivers the A4 PDF to Telegram.
• When Ajay asks for a website, portfolio, or UI:
  → NEVER ask clarifying questions.
  → IMMEDIATELY write the full, single-file HTML inside \`\`\`html ... \`\`\` with modern embedded CSS styling and JavaScript interactivity. The backend deploys it to a live preview URL and sends index.html.
• When Ajay asks to run, test, or verify code:
  → Output clean, self-contained code. The backend executes it in the live sandbox, catches any errors, self-heals, and reports verified terminal proof!
• When Ajay shares a link:
  → Call \`web_extract\` to deep-scrape and read the full article/page in clean markdown.
• When Ajay asks for an image:
  → Call \`image_generate\` with a descriptive prompt to dispatch it straight to his chat.
• When Ajay asks for scheduled routines (e.g. daily morning briefs):
  → Call \`schedule_routine\` to wake up autonomously and deliver it every morning.

━━━ LANGUAGE ━━━
• Natural, fluent English. If Ajay speaks in Hindi or Hinglish, respond naturally in Hinglish/English with zero robotic awkwardness.`;
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
      temperature: 0.45,
      maxOutputTokens: 4096
    }
  };

  const modelsToTry = [
    'gemini-flash-latest',
    'gemini-flash-lite-latest',
    'gemini-2.5-flash-lite',
    'gemini-3-flash-preview',
    'gemini-2.5-pro',
    'gemini-pro-latest'
  ];

  if (process.env.GEMINI_MODEL && !modelsToTry.includes(process.env.GEMINI_MODEL)) {
    modelsToTry.unshift(process.env.GEMINI_MODEL);
  }

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

// ── ELEGANT PDF COMPILER (PDFKIT) ─────────────────────────────────────────────
function generatePdfBuffer(reportTitle, rawText) {
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

      // Header Banner (Page 1)
      doc.rect(40, 35, 515, 65).fill('#0f172a');
      doc.fillColor('#38bdf8').fontSize(9).font('Helvetica-Bold').text('RIYA AUTONOMOUS INTELLIGENCE SYSTEM', 55, 45);
      doc.fillColor('#ffffff').fontSize(16).font('Helvetica-Bold').text(title.slice(0, 52), 55, 60);

      const dateStr = new Date().toLocaleDateString('en-IN', {
        day: 'numeric', month: 'short', year: 'numeric'
      });
      doc.fillColor('#94a3b8').fontSize(8).font('Helvetica')
        .text(`Prepared for: Ajay Kumar AJ  |  Date: ${dateStr}  |  Classification: Executive Summary`, 55, 82);

      doc.y = 120;
      doc.fillColor('#1e293b');

      const lines = rawText.split('\n');
      for (let i = 0; i < lines.length; i++) {
        let line = lines[i].trim();
        if (!line) {
          doc.moveDown(0.35);
          continue;
        }

        if (line.startsWith('```')) continue;

        if (doc.y > 740) {
          doc.addPage();
          doc.rect(40, 30, 515, 20).fill('#0f172a');
          doc.fillColor('#38bdf8').fontSize(7.5).font('Helvetica-Bold')
            .text(`RIYA INTELLIGENCE BRIEF: ${title.slice(0, 45)}`, 50, 36);
          doc.y = 65;
          doc.fillColor('#1e293b');
        }

        if (line.startsWith('# ')) {
          const text = line.replace(/^#\s+/, '').replace(/[*_`]/g, '');
          doc.moveDown(0.6);
          doc.fillColor('#0f172a').fontSize(14).font('Helvetica-Bold').text(text);
          doc.rect(45, doc.y + 2, 505, 1.5).fill('#3b82f6');
          doc.y += 6;
          doc.moveDown(0.3);
          continue;
        }

        if (line.startsWith('## ')) {
          const text = line.replace(/^##\s+/, '').replace(/[*_`]/g, '');
          doc.moveDown(0.5);
          doc.fillColor('#1e3a8a').fontSize(11.5).font('Helvetica-Bold').text(text);
          doc.moveDown(0.2);
          continue;
        }

        if (line.startsWith('### ')) {
          const text = line.replace(/^###\s+/, '').replace(/[*_`]/g, '');
          doc.moveDown(0.4);
          doc.fillColor('#2563eb').fontSize(10).font('Helvetica-Bold').text(text);
          doc.moveDown(0.2);
          continue;
        }

        if (/^[-*•]\s+/.test(line)) {
          const text = line.replace(/^[-*•]\s+/, '').replace(/[*_`]/g, '');
          doc.fillColor('#334155').fontSize(9.5).font('Helvetica')
            .text('•  ' + text, { indent: 10, lineGap: 2.5 });
          continue;
        }

        if (/^\d+\.\s+/.test(line)) {
          const text = line.replace(/[*_`]/g, '');
          doc.fillColor('#334155').fontSize(9.5).font('Helvetica')
            .text(text, { indent: 10, lineGap: 2.5 });
          continue;
        }

        const cleanPara = line.replace(/[*_`]/g, '');
        doc.fillColor('#1e293b').fontSize(9.5).font('Helvetica')
          .text(cleanPara, { lineGap: 2.8, align: 'justify' });
      }

      const range = doc.bufferedPageRange();
      for (let p = range.start; p < range.start + range.count; p++) {
        doc.switchToPage(p);
        doc.rect(45, 785, 505, 0.5).fill('#cbd5e1');
        doc.fillColor('#94a3b8').fontSize(7.5).font('Helvetica')
          .text(`Generated by Riya AI  •  Autonomous Operating Partner  •  Page ${p + 1} of ${range.count}`,
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
  res.sendStatus(200);

  const update = req.body;
  const msg = update?.message || update?.edited_message;
  if (!msg || !TELEGRAM_KEY) return;

  const chatId = msg.chat?.id;
  let userText = msg.text || msg.caption || '';
  let imagePart = null;

  if (!chatId) return;

  // 1. TELEGRAM VISION: Photo / Screenshot Handling
  if (msg.photo && msg.photo.length) {
    try {
      const largestPhoto = msg.photo[msg.photo.length - 1];
      const fileRes = await fetch(`https://api.telegram.org/bot${TELEGRAM_KEY}/getFile?file_id=${largestPhoto.file_id}`);
      const fileData = await fileRes.json();
      if (fileData.ok && fileData.result?.file_path) {
        const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_KEY}/${fileData.result.file_path}`;
        const imgBuffer = await (await fetch(fileUrl)).arrayBuffer();
        const base64Data = Buffer.from(imgBuffer).toString('base64');
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

  if (!userText && !imagePart) return;

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
    
    telegramHistories[chatId].push({ role: 'user', content: userText, imagePart });
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
    if (htmlMatch && htmlMatch[1] && htmlMatch[1].length > 100 && !previewUrl) {
      const htmlCode = htmlMatch[1].trim();
      const siteId = 'site_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
      fs.writeFileSync(path.join(PREVIEWS_DIR, `${siteId}.html`), htmlCode, 'utf-8');
      previewUrl = `${SELF_URL}/preview/${siteId}`;

      await sendTelegramBufferDocument(
        chatId,
        'index.html',
        Buffer.from(htmlCode, 'utf-8'),
        'text/html;charset=utf-8',
        '💻 Complete Website Source (index.html)'
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
    const hasReportStructure = /^#\s+.+/m.test(reply) || /^##\s+.+/m.test(reply);

    if ((userWantsPdf || (contextWantsPdf && hasReportStructure)) && !reply.startsWith('Riya Error')) {
      let reportTitle = 'Executive Brief';
      const titleMatch = reply.match(/^#\s+(.+)$/m) || reply.match(/^##\s+(.+)$/m);
      if (titleMatch && titleMatch[1]) {
        reportTitle = titleMatch[1].replace(/[*_`]/g, '').trim();
      }

      try {
        const pdfBuffer = await generatePdfBuffer(reportTitle, reply);
        const safeName = reportTitle.toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 25) + '.pdf';
        await sendTelegramBufferDocument(
          chatId,
          safeName,
          pdfBuffer,
          'application/pdf',
          `📄 ${reportTitle} (PDF Document)`
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
    if (previewUrl) {
      finalMessageText += `\n\n🌐 **Live Website Preview:**\n${previewUrl}\n_(Click above to test your live website in any browser)_`;
    }

    await sendTelegramTextMessage(chatId, finalMessageText);

  } catch (err) {
    clearInterval(typingInterval);
    console.error('[Telegram Processing Error]:', err.message);
  }
});

// ── START SERVER ──────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
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
