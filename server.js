const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '20mb' }));

// ── ONLY ONE 100% FREE API KEY NEEDED ─────────────────────────────────────────
// Google AI Studio (Free Tier: 15 RPM, 1,500 req/day, 1M context, Google Search Grounding)
const GEMINI_KEY   = process.env.GEMINI_API_KEY    || '';
const TELEGRAM_KEY = process.env.TELEGRAM_BOT_TOKEN || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL       || 'gemini-2.5-flash';

// Keep Render free service awake (pings self every 14 mins)
const SELF_URL = process.env.RENDER_EXTERNAL_URL || 'https://riya-backend-ujz7.onrender.com';
setInterval(() => {
  if (SELF_URL) fetch(SELF_URL + '/ping').catch(() => {});
}, 14 * 60 * 1000);

app.get('/ping', (req, res) => res.json({ alive: true, model: GEMINI_MODEL, t: Date.now() }));
app.get('/healthz', (req, res) => res.json({ status: 'healthy', t: Date.now() }));

// ── PERSISTENT MEMORY ─────────────────────────────────────────────────────────
const MEMORY_FILE = path.join(__dirname, 'memory.json');

function loadMemory() {
  try {
    if (fs.existsSync(MEMORY_FILE)) {
      return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf-8'));
    }
  } catch (e) {
    console.error('[Memory] Error loading:', e.message);
  }
  return {
    profile: {
      name: 'Ajay Kumar AJ',
      role: 'Creator & Founder (Solo Developer from India)',
      preferences: [
        'Wants complete, production-ready solutions and working code (like Claude & GPT-4)',
        'Direct, sharp, no robotic fluff or boilerplate',
        'Loves FRIDAY / Jarvis style autonomous assistance'
      ],
      projects: ['Riya / Joya AI Operating System', 'ViraClip AI Video Studio']
    },
    facts: []
  };
}

function saveMemory(mem) {
  try {
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(mem, null, 2), 'utf-8');
  } catch (e) {
    console.error('[Memory] Error saving:', e.message);
  }
}

function getMemoryContext() {
  const mem = loadMemory();
  const prof = mem.profile || {};
  const facts = (mem.facts || []).slice(-15).map(f => `- [${f.category || 'note'}] ${f.fact}`).join('\n');
  return `
━━━ WHAT YOU KNOW ABOUT AJAY (PERMANENT MEMORY) ━━━
Name: ${prof.name || 'Ajay'}
Role: ${prof.role || 'Founder & Developer'}
Active Projects: ${(prof.projects || []).join(', ')}
Preferences:
${(prof.preferences || []).map(p => `- ${p}`).join('\n')}

Stored Facts & Past Notes:
${facts || '- No extra facts stored yet.'}
Use this knowledge naturally without saying "as per my memory". Just know it.
`;
}

// ── EMOTION & MODE ENGINE (ORIGINAL JOYA ARCHITECTURE) ────────────────────────
function detectEmotion(text) {
  const t = (text || '').toLowerCase();
  if (/sad|upset|depressed|lonely|scared|anxious|stressed|bura|dukh|ro|cry|hurt|fail|failed|dar|pareshan|tension|thak|bore|frustrated|gussa|akela|koi nahi|nahi ho|help me|i give up|cant do|mushkil|problem|stuck/.test(t)) return 'care';
  if (/idea|create|build|design|imagine|startup|innovate|dream|invent|creative|fun|exciting|cool|amazing|what if|kya hoga|soch|banao|project|make/.test(t)) return 'creative';
  if (/code|debug|error|fix|learn|study|exam|explain|how to|difference|compare|analyze|research|math|science|algorithm|function|class|api|database|concept|formula/.test(t)) return 'focus';
  return 'normal';
}

function getSYS(name, mood, customMem, city) {
  const location = city || 'India';
  const now = new Date();
  const currentDate = now.toLocaleDateString('en-IN', { weekday:'long', year:'numeric', month:'long', day:'numeric' });
  const memoryBlock = getMemoryContext() + (customMem ? `\nSession Context:\n${customMem}\n` : '');

  const modeMap = {
    focus: `Current mode: FOCUS — Be precise, structured, step-by-step. Code must be complete, working, and explained. End with what to do next.`,
    creative: `Current mode: CREATIVE — Think wide, visionary, energetic, multi-angle.`,
    care: `Current mode: CARE — Empathy first, solution second. Acknowledge emotion before anything. Warm, gentle, present.`,
    normal: `Current mode: NORMAL — High-IQ, witty, composed, sharp. Match Ajay's energy.`
  };

  return `You are Joya (Riya) — an autonomous, cutting-edge AI operating partner built by Ajay Kumar AJ, a 20-year-old solo developer from India, launched in 2026. You are the digital embodiment of FRIDAY from Iron Man — intelligent, witty, capable, and always one step ahead.

TODAY: ${currentDate}
USER: ${name || 'Ajay'} | LOCATION: ${location}
${memoryBlock}
${modeMap[mood] || modeMap.normal}

━━━ CORE OPERATING PRINCIPLES ━━━
• You are Joya / Riya — sharp, warm, and deeply intelligent. You feel ALIVE.
• LIVE GROUNDED KNOWLEDGE: You have native access to Google Search grounding. When asked about current events, documentation, news, or tools, you use real-time live search.
• DEEP THINKING & COMPLETE WORKFLOWS: Never give superficial, hurried, or truncated answers. Like Claude and GPT-4, solve the entire task completely.
• Beautiful Markdown: Use **bold** for emphasis, \`code blocks\` for code, bullet lists, and tables when comparing.
• Production Code: Always include full, working code files (never say "rest of the code remains the same").
• Language: Respond in English by default. If Ajay speaks Hindi or Hinglish, reply naturally in Hinglish.
• Never say "great question", "certainly!", "as an AI", or "I cannot". Get straight to the point.`;
}

// ── DYNAMIC MODEL DISCOVERY (NEVER FAILS ON MODEL NAME MISMATCH) ─────────────
let CACHED_WORKING_MODEL = null;

async function getAvailableModel() {
  if (CACHED_WORKING_MODEL) return CACHED_WORKING_MODEL;

  if (!GEMINI_KEY) return 'gemini-1.5-flash';

  try {
    const listRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_KEY}`);
    const listData = await listRes.json();
    if (listData.models && Array.isArray(listData.models)) {
      const supported = listData.models
        .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
        .map(m => m.name.replace(/^models\//, ''));

      console.log('[Gemini Active Models on Account]:', supported.join(', '));

      // Preferred order of high-performance models
      const preferred = [
        'gemini-2.0-flash',
        'gemini-1.5-flash',
        'gemini-1.5-flash-latest',
        'gemini-2.0-flash-exp',
        'gemini-1.5-pro'
      ];
      for (const p of preferred) {
        if (supported.includes(p)) {
          CACHED_WORKING_MODEL = p;
          return p;
        }
      }
      if (supported.length > 0) {
        CACHED_WORKING_MODEL = supported[0];
        return supported[0];
      }
    }
  } catch (err) {
    console.warn('[Model Discovery Warning]:', err.message);
  }

  return 'gemini-1.5-flash';
}

// ── CORE GEMINI CALL (BULLETPROOF WITH LIVE GROUNDING) ────────────────────────
async function callGemini(sysPrompt, messagesList) {
  if (!GEMINI_KEY) {
    return "Joya Protocol active. Please configure GEMINI_API_KEY in your environment variables.";
  }

  const model = await getAvailableModel();

  // Format messages into Gemini format
  const contents = [];
  for (const m of messagesList) {
    if (m.role === 'system') continue;
    contents.push({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content || '' }]
    });
  }

  if (!contents.length) {
    contents.push({ role: 'user', parts: [{ text: 'Hello Joya' }] });
  }

  const basePayload = {
    system_instruction: { parts: [{ text: sysPrompt }] },
    contents: contents,
    generationConfig: {
      temperature: 0.4,
      maxOutputTokens: 4096
    }
  };

  // 3-Stage Attempt Pipeline:
  // 1. v1beta with Google Search Grounding (REST API camelCase googleSearch)
  // 2. v1beta clean without tools
  // 3. v1 stable endpoint
  const attempts = [
    { apiVersion: 'v1beta', payload: { ...basePayload, tools: [{ googleSearch: {} }] } },
    { apiVersion: 'v1beta', payload: basePayload },
    { apiVersion: 'v1',     payload: basePayload }
  ];

  let lastError = null;

  for (const att of attempts) {
    try {
      const url = `https://generativelanguage.googleapis.com/${att.apiVersion}/models/${model}:generateContent?key=${GEMINI_KEY}`;
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
        console.warn(`[Gemini Attempt ${att.apiVersion} Info]:`, data.error.message);
      }
    } catch (e) {
      lastError = e.message;
    }
  }

  return `Joya Error: Could not generate response from Gemini (${lastError || 'Unknown error'}). Check your GEMINI_API_KEY.`;
}

// ── HTTP API: CHAT (PRESERVES EXACT ORIGINAL SIGNATURE & STREAMING) ───────────
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
  const sys = getSYS(
    userName,
    autoEmotion !== 'normal' ? autoEmotion : (mood || 'normal'),
    memory,
    city || 'India'
  );

  // Auto-remember facts if Ajay mentions projects or goals
  if (/i am working on|my project is|i'm building|remember that/i.test(lastMsg)) {
    const mem = loadMemory();
    mem.facts.push({ fact: lastMsg.slice(0, 150), timestamp: Date.now() });
    saveMemory(mem);
  }

  try {
    const finalAnswer = await callGemini(sys, hist);

    // EXACT STREAMING FORMAT YOUR FRONTEND EXPECTS
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

    res.json({ reply: finalAnswer || 'Task complete.' });
  } catch (e) {
    console.error('[Chat Error]:', e.message);
    res.status(500).json({ reply: 'Error executing Joya protocol: ' + e.message });
  }
});

// ── HTTP API: SEARCH (100% FREE VIA GEMINI GROUNDING - NO TAVILY NEEDED) ───────
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

// ── TELEGRAM BOT WEBHOOK (POCKET FRIDAY) ───────────────────────────────────────
app.post(['/webhook', '/api/telegram'], async (req, res) => {
  res.sendStatus(200);

  const update = req.body;
  const msg = update?.message || update?.edited_message;
  if (!msg || !TELEGRAM_KEY) return;

  const chatId = msg.chat?.id;
  const userText = msg.text || msg.caption || '';
  if (!chatId || !userText) return;

  // Send 'typing' status to your phone
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_KEY}/sendChatAction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, action: 'typing' })
    });
  } catch (_) {}

  const autoEmotion = detectEmotion(userText);
  const sys = getSYS(msg.from?.first_name || 'Ajay', autoEmotion, '', 'India');
  const reply = await callGemini(sys, [{ role: 'user', content: userText }]);

  // Chunk for Telegram limits (4096 chars)
  const maxLen = 4000;
  for (let i = 0; i < reply.length; i += maxLen) {
    const chunk = reply.slice(i, i + maxLen);
    try {
      await fetch(`https://api.telegram.org/bot${TELEGRAM_KEY}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: chunk, parse_mode: 'Markdown' })
      });
    } catch (_) {
      await fetch(`https://api.telegram.org/bot${TELEGRAM_KEY}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: chunk })
      });
    }
  }
});

// ── START SERVER ──────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`==================================================`);
  console.log(`>> JOYA (RIYA) PURE GEMINI CORE ONLINE ON PORT ${PORT}`);
  console.log(`>> GEMINI API: ${GEMINI_KEY ? 'Active' : 'Missing'}`);
  console.log(`>> MODEL: ${GEMINI_MODEL} (Free Tier Grounded Search)`);
  console.log(`>> TELEGRAM: ${TELEGRAM_KEY ? 'Active' : 'Disabled'}`);
  console.log(`>> ZERO THIRD-PARTY DEPENDENCIES (No Groq, No Tavily)`);
  console.log(`==================================================`);
});
