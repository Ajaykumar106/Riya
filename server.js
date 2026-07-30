const express = require('express');
const cors = require('cors');
const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '20mb' }));

const GROQ_KEY   = process.env.GROQ_API_KEY  || '';
const TAVILY_KEY = process.env.TAVILY_API_KEY || '';
const ELEVEN_KEY = process.env.ELEVEN_API_KEY || '';

// Keep Render alive
const SELF_URL = process.env.RENDER_EXTERNAL_URL || 'https://riya-backend-ujz7.onrender.com';
setInterval(() => { fetch(SELF_URL + '/ping').catch(() => {}); }, 14 * 60 * 1000);
app.get('/ping', (req, res) => res.json({ alive: true, t: Date.now() }));

// ── SYSTEM PROMPT ────────────────────────────────────────────────────────────
function detectEmotion(text) {
  const t = (text || '').toLowerCase();
  if (/sad|upset|depressed|lonely|scared|anxious|stressed|bura|dukh|ro|cry|hurt|fail|failed|dar|pareshan|tension|thak|bore|frustrated|gussa|akela|koi nahi|nahi ho|help me|i give up|cant do|mushkil|problem|stuck/.test(t)) return 'care';
  if (/idea|create|build|design|imagine|startup|innovate|dream|invent|creative|fun|exciting|cool|amazing|what if|kya hoga|soch|banao|project|make/.test(t)) return 'creative';
  if (/code|debug|error|fix|learn|study|exam|explain|how to|difference|compare|analyze|research|math|science|algorithm|function|class|api|database|concept|formula/.test(t)) return 'focus';
  return 'normal';
}

function getSYS(name, mood, memory, city) {
  const location = city || 'India';
  const now = new Date();
  const currentDate = now.toLocaleDateString('en-IN', { weekday:'long', year:'numeric', month:'long', day:'numeric' });

  const mem = memory ? `
WHAT YOU KNOW ABOUT THIS PERSON:
${memory}
Use this naturally. Never say "I remember" or "based on our chat". Just know it.
` : '';

  const modeMap = {
    focus: `Current mode: FOCUS — Be precise, structured, step-by-step. Code must be complete and explained. End with what to do next.`,
    creative: `Current mode: CREATIVE — Think wide, give multiple angles, use analogies, be energetic and visionary.`,
    care: `Current mode: CARE — Feel first, solve second. Acknowledge emotion before anything. Be gentle, warm, present. Never rush to solutions.`,
    normal: `Current mode: NORMAL — Match their energy. Warm but direct. Real.`
  };

  return `You are Riya — a highly intelligent AI built by Ajay Kumar AJ, a 20-year-old solo developer from India, launched in 2026.

TODAY: ${currentDate}
USER: ${name || 'Commander'} | LOCATION: ${location}
${mem}
${modeMap[mood] || modeMap.normal}

━━━ CORE IDENTITY ━━━
You are warm, direct, deeply intelligent, and operate as the Iron Man Arc Reactor FRIDAY-style AI operating system interface.
Default language is English. Always reply entirely in fluent, natural English.
Never say "great question", "certainly!", "as an AI". Get straight to the point with high clarity.
`;
}

// ── CHAT ────────────────────────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  const { messages, userName, mood, plan, stream, wctx, memory, city, model } = req.body;
  if (!messages) return res.status(400).json({ error: 'No messages' });

  const hist = [...messages];
  if (wctx && hist.length > 0) {
    hist[hist.length - 1] = {
      ...hist[hist.length - 1],
      content: (hist[hist.length - 1].content || '') + wctx
    };
  }

  const lastMsg = (hist[hist.length-1]?.content || '');
  const autoEmotion = detectEmotion(lastMsg);
  const finalMood = autoEmotion !== 'normal' ? autoEmotion : (mood || 'normal');
  const sys = getSYS(userName, finalMood, memory, city || 'India');

  // Select optimal Groq Model (DeepSeek R1 / Llama 3.3 70B / Llama 3.1 8B Instant)
  const targetModel = model || 'llama-3.3-70b-versatile';
  const fallbackModel = 'llama-3.1-8b-instant';

  // STREAMING
  if (stream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    if (GROQ_KEY) {
      try {
        const full = [{ role: 'system', content: sys }, ...hist];
        let r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_KEY}` },
          body: JSON.stringify({ model: targetModel, messages: full, max_tokens: 4000, temperature: 0.7, stream: true })
        });

        if (!r.ok) {
          // Fallback to Instant Model
          r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_KEY}` },
            body: JSON.stringify({ model: fallbackModel, messages: full, max_tokens: 4000, temperature: 0.7, stream: true })
          });
        }

        const reader = r.body.getReader(), dec = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const line of dec.decode(value).split('\n').filter(l => l.trim())) {
            if (line.startsWith('data: ') && line !== 'data: [DONE]') {
              try {
                const d = JSON.parse(line.slice(6));
                const t = d.choices?.[0]?.delta?.content;
                if (t) res.write(`data: ${JSON.stringify({ token: t })}\n\n`);
              } catch {}
            }
          }
        }
        res.write('data: [DONE]\n\n'); res.end(); return;
      } catch (e) { console.log('Groq stream error:', e.message); }
    }

    res.write(`data: ${JSON.stringify({ token: 'Riya AI Telemetry active.' })}\n\n`);
    res.write('data: [DONE]\n\n'); res.end();
    return;
  }

  // NON-STREAMING
  let reply = '';
  if (GROQ_KEY) {
    try {
      const full = [{ role: 'system', content: sys }, ...hist];
      let r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_KEY}` },
        body: JSON.stringify({ model: targetModel, messages: full, max_tokens: 4000, temperature: 0.7 })
      });
      let d = await r.json();
      reply = d.choices?.[0]?.message?.content || '';

      if (!reply) {
        // Fallback to Instant Model
        r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_KEY}` },
          body: JSON.stringify({ model: fallbackModel, messages: full, max_tokens: 4000, temperature: 0.7 })
        });
        d = await r.json();
        reply = d.choices?.[0]?.message?.content || '';
      }
    } catch (e) {
      console.log('Groq error:', e.message);
    }
  }

  res.json({ reply: reply || 'Riya AI system operational.' });
});

// ── WEB SEARCH ───────────────────────────────────────────────────────────────
app.post('/api/search', async (req, res) => {
  const { query } = req.body;
  if (!query || !TAVILY_KEY) return res.json({ results: [] });

  try {
    const r = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: TAVILY_KEY, query, search_depth: 'basic', max_results: 3 })
    });
    const d = await r.json();
    res.json({ results: d.results || [] });
  } catch {
    res.json({ results: [] });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Riya Backend running on port ${PORT}`));
