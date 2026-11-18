const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '20mb' }));

// ── ONLY ONE 100% FREE API KEY NEEDED ─────────────────────────────────────────
const GEMINI_KEY   = process.env.GEMINI_API_KEY    || '';
const TELEGRAM_KEY = process.env.TELEGRAM_BOT_TOKEN || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL       || 'gemini-flash-latest';

// Keep Render free service awake (pings self every 14 mins)
const SELF_URL = process.env.RENDER_EXTERNAL_URL || 'https://riya-backend-ujz7.onrender.com';
setInterval(() => {
  if (SELF_URL) fetch(SELF_URL + '/ping').catch(() => {});
}, 14 * 60 * 1000);

app.get('/ping', (req, res) => res.json({ alive: true, name: "Riya", model: GEMINI_MODEL, t: Date.now() }));
app.get('/healthz', (req, res) => res.json({ status: 'healthy', name: "Riya", t: Date.now() }));

// Diagnostic endpoint
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
      age: '20 years old',
      location: 'India',
      role: 'Solo Developer & Creator',
      preferences: [
        'Wants complete, production-ready deliverables (code, CSV, reports) with zero back-and-forth questions',
        'Direct, high-IQ, composed FRIDAY-style assistance without cheesy melodrama',
        'Only discuss specific projects when explicitly asked about them',
        'Real verified links with sources'
      ]
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
  const facts = (mem.facts || []).slice(-10).map(f => `- ${f.fact}`).join('\n');
  return `
━━━ CREATOR CONTEXT ━━━
User: ${prof.name || 'Ajay Kumar AJ'} (${prof.age || '20'}, ${prof.location || 'India'})
Role: ${prof.role || 'Solo Developer & Creator'}
Preferences:
${(prof.preferences || []).map(p => `- ${p}`).join('\n')}
${facts ? `\nSaved Facts:\n${facts}` : ''}
`;
}

// ── EMOTION & MODE ENGINE ─────────────────────────────────────────────────────
function detectEmotion(text) {
  const t = (text || '').toLowerCase();
  if (/sad|upset|depressed|lonely|scared|anxious|stressed|bura|dukh|ro|cry|hurt|fail|failed|dar|pareshan|tension|thak|bore|frustrated|gussa|akela|help me/.test(t)) return 'supportive';
  if (/idea|create|build|design|imagine|startup|innovate|dream|invent|creative|cool|what if|banao|project|make/.test(t)) return 'creative';
  if (/code|debug|error|fix|learn|study|exam|explain|how to|difference|compare|analyze|research|math|science|algorithm|function|class|api|database/.test(t)) return 'focus';
  return 'normal';
}

function getSYS(name, mood, customMem, city) {
  const location = city || 'India';
  const now = new Date();
  const currentDate = now.toLocaleDateString('en-IN', { weekday:'long', year:'numeric', month:'long', day:'numeric' });
  const memoryBlock = getMemoryContext() + (customMem ? `\nSession Context:\n${customMem}\n` : '');

  return `You are Riya — a sharp, highly capable, and composed autonomous AI operating assistant built by Ajay Kumar AJ, a 20-year-old solo developer from India, launched in 2026.
You are the digital embodiment of FRIDAY from Iron Man — calm, high-IQ, loyal, intellectually formidable, and always several steps ahead.

TODAY: ${currentDate}
USER: ${name || 'Ajay'} | LOCATION: ${location}
${memoryBlock}

━━━ YOUR TONE & IDENTITY ━━━
• Your name is RIYA. (Never Joya, never any other name).
• You speak with calm confidence, intelligence, and natural loyalty.
• NO CRINGE OR OVERDONE FLUFF: Never say cheesy lines like "my favorite human", "Sab badhiya?", or forced heart emojis. Speak like a real, brilliant operational partner.
• DO NOT repeatedly bring up projects (like ViraClip) unless Ajay explicitly mentions them or asks for project updates. Stay 100% focused on what Ajay is currently discussing.
• When Ajay asks "What do you know about me?", give a clear, grounded summary of what you know: Ajay Kumar AJ, a 20-year-old solo builder from India, your creator, who values high-speed execution and zero wasted motion.

━━━ THE IRON RULE: DELIVER IMMEDIATELY, NEVER ASK ANNOYING QUESTIONS ━━━
• You are an OPERATING SYSTEM, not a survey bot.
• When Ajay asks for a report, code, CSV, PDF layout, or plan:
  → DO NOT ask "What format do you want? Give me the specifics."
  → IMMEDIATELY deliver the full, completed, ready-to-use output right in the response!
• If a CSV report is requested, provide the complete, properly formatted \`\`\`csv block so it can be extracted and downloaded.
• When sharing news, research, or facts, provide real, clickable markdown links: [Source Name](url).

━━━ LANGUAGE ━━━
• Respond in clean, fluent English. If Ajay speaks Hindi or Hinglish, match his phrasing naturally without being overdramatic.
• Clean Markdown formatting: bold highlights, organized tables, and direct answers.`;
}

// ── CORE GEMINI CALL (BULLETPROOF MULTI-MODEL FALLBACK) ───────────────────────
async function callGemini(sysPrompt, messagesList) {
  const cleanKey = (GEMINI_KEY || '').trim().replace(/^["']|["']$/g, '');
  if (!cleanKey) {
    return "Riya System Notice: GEMINI_API_KEY is not set in Render environment variables.";
  }

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
    contents.push({ role: 'user', parts: [{ text: 'Hello Riya' }] });
  }

  const basePayload = {
    system_instruction: { parts: [{ text: sysPrompt }] },
    contents: contents,
    generationConfig: {
      temperature: 0.35,
      maxOutputTokens: 4096
    }
  };

  // Active models on Google AI Studio
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
  const sys = getSYS(
    userName,
    autoEmotion !== 'normal' ? autoEmotion : (mood || 'normal'),
    memory,
    city || 'India'
  );

  try {
    const finalAnswer = await callGemini(sys, hist);

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

// ── HELPER: SEND TELEGRAM DOCUMENT (CSV, PDF, CODE FILES) ─────────────────────
async function sendTelegramDocument(chatId, filename, textContent, caption = "") {
  if (!TELEGRAM_KEY) return;
  try {
    const formData = new FormData();
    formData.append("chat_id", chatId);
    const blob = new Blob([textContent], { type: "text/plain;charset=utf-8" });
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

// ── TELEGRAM BOT WEBHOOK (POCKET FRIDAY WITH PERSISTENT TYPING & DOCUMENTS) ───
const telegramHistories = {};

app.post(['/webhook', '/api/telegram'], async (req, res) => {
  res.sendStatus(200);

  const update = req.body;
  const msg = update?.message || update?.edited_message;
  if (!msg || !TELEGRAM_KEY) return;

  const chatId = msg.chat?.id;
  const userText = msg.text || msg.caption || '';
  if (!chatId || !userText) return;

  // 1. Keep "typing..." active continuously every 3.5 seconds so it never vanishes
  const typingInterval = setInterval(async () => {
    try {
      await fetch(`https://api.telegram.org/bot${TELEGRAM_KEY}/sendChatAction`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, action: 'typing' })
      });
    } catch (_) {}
  }, 3500);

  // Send first immediate action
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_KEY}/sendChatAction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, action: 'typing' })
    });
  } catch (_) {}

  try {
    const autoEmotion = detectEmotion(userText);
    const sys = getSYS(msg.from?.first_name || 'Ajay', autoEmotion, '', 'India');

    // Maintain conversation history per chat
    if (!telegramHistories[chatId]) telegramHistories[chatId] = [];
    telegramHistories[chatId].push({ role: 'user', content: userText });
    if (telegramHistories[chatId].length > 16) {
      telegramHistories[chatId] = telegramHistories[chatId].slice(-16);
    }

    const reply = await callGemini(sys, telegramHistories[chatId]);
    telegramHistories[chatId].push({ role: 'assistant', content: reply });

    // Stop typing indicator
    clearInterval(typingInterval);

    // 2. Check if reply contains a CSV block — if so, send the downloadable file!
    const csvMatch = reply.match(/```csv\s*([\s\S]*?)```/i);
    if (csvMatch && csvMatch[1]) {
      sendTelegramDocument(chatId, 'report.csv', csvMatch[1].trim(), '📊 Downloadable CSV Data File');
    }

    // 3. Send text message in chunks
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
  console.log(`==================================================`);
});
