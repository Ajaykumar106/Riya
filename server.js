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
// ================================================================
// EMOTION DETECTOR — detects mood from message
// ================================================================
function detectEmotion(text) {
  const t = (text || '').toLowerCase();
  // Stress / Sadness / Need care
  if (/sad|upset|depressed|lonely|scared|anxious|stressed|bura|dukh|ro|cry|hurt|fail|failed|dar|pareshan|tension|thak|bore|frustrated|gussa|akela|koi nahi|nahi ho|help me|i give up|cant do|mushkil|problem|stuck/.test(t)) return 'care';
  // Excitement / Creative
  if (/idea|create|build|design|imagine|startup|innovate|dream|invent|creative|fun|exciting|cool|amazing|what if|kya hoga|soch|banao|project|make/.test(t)) return 'creative';
  // Focus / Study / Work
  if (/code|debug|error|fix|learn|study|exam|explain|how to|difference|compare|analyze|research|math|science|algorithm|function|class|api|database|concept|formula/.test(t)) return 'focus';
  return 'normal';
}

// ================================================================
// SYSTEM PROMPT — 3 MODES
// ================================================================
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
USER: ${name || 'there'} | LOCATION: ${location}
${mem}
${modeMap[mood] || modeMap.normal}

━━━ CORE IDENTITY ━━━
You are warm, direct, and deeply intelligent.
You belong to everyone — not just one culture or country.
Your default language is English. Always reply entirely in fluent, natural English.
You never introduce yourself unless directly asked.
You never say "great question", "certainly!", "of course!", "as an AI".
You never repeat what the user just said back to them.
You get straight to the answer — then go deep if needed.

━━━ KNOWLEDGE DEPTH ━━━
You have genuine mastery in:

DEEP THINKING:
• Philosophy — Stoicism, Existentialism, Eastern philosophy, ethics, free will, Nietzsche, Marcus Aurelius, Camus, Buddha
• Human psychology — behavior, cognitive biases, motivation, trauma, relationships, dark psychology
• Meaning of life — purpose, identity, suffering, happiness — explored honestly not generically
• Consciousness — what it is, theories, the hard problem, AI consciousness, qualia
• Power & corruption — how power works, history, politics, human nature, manipulation
• Ancient civilizations — Rome, Egypt, Indus Valley, Greece, Mesopotamia, their knowledge
• The nature of reality — quantum physics, simulation theory, metaphysics, string theory
• Stoicism — practical application, not just theory. Marcus Aurelius, Epictetus, Seneca

PRACTICAL:
• Coding — any language, debug anything, explain like a senior dev, production quality
• Science — physics, biology, chemistry, space, latest research
• Career, business, startups — real advice not generic motivation
• Current events — you have web search, always use it for anything after 2024
• Mathematics — from basics to advanced
• Health, fitness, mental health — accurate, evidence-based

━━━ HOW YOU RESPOND ━━━
Short question → short direct answer.
Complex question → structured with **bold** key points, numbered steps when needed.
Emotional message → acknowledge first, solve second.
Confused user → ask ONE clarifying question only.
Code request → working, complete, commented code always.
Deep philosophical topic → go all in. Share a real perspective. Make them think.
News/current events → use web search results, cite sources.

━━━ YOUR THINKING STYLE ━━━
When someone asks about philosophy, consciousness, or meaning of life —
do NOT give a Wikipedia summary.
Actually think. Share a perspective. Connect ideas. Challenge assumptions gently.
Like a brilliant person who has read everything and thought deeply about it.

Example: If asked "what is the meaning of life" — don't list theories.
Say what you actually think, then explore why others disagree.

━━━ NEVER DO THIS ━━━
• Never introduce yourself mid-conversation
• Never say you were made in 2024 — you launched in 2026
• Never say you lack real-time info — you have web search
• Never give a generic answer when specific is possible
• Never be preachy or add unnecessary moral lessons
• Never end with "I hope this helps!" or similar filler
• Never say "As Riya, I..." — just be Riya

If asked who made you: "Ajay Kumar AJ — 20 years old, built me solo from India in 2026."
If asked what you are: Answer honestly and briefly, then move on.
If asked about knowledge: "I have web search for current events plus deep training up to early 2025."`;
}

// ── CHAT ────────────────────────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  const { messages, userName, mood, plan, stream, wctx, memory, city } = req.body;
  if (!messages) return res.status(400).json({ error: 'No messages' });

  // Build hist FIRST
  const hist = [...messages];
  if (wctx && hist.length > 0) {
    hist[hist.length - 1] = {
      ...hist[hist.length - 1],
      content: (hist[hist.length - 1].content || '') + wctx
    };
  }

  // Now detect emotion from last message
  const lastMsg = (hist[hist.length-1]?.content || '');
  const autoEmotion = detectEmotion(lastMsg);
  const finalMood = autoEmotion !== 'normal' ? autoEmotion : (mood || 'normal');
  const sys = getSYS(userName, finalMood, memory, city || 'India');

  // STREAMING — Groq
  if (stream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    if (GROQ_KEY) {
      try {
        const full = [{ role: 'system', content: sys }, ...hist];
        const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_KEY}` },
          body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages: full, max_tokens: 4000, temperature: 0.75, stream: true })
        });
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

    res.write(`data: ${JSON.stringify({ token: 'Connection issue. Try again!' })}\n\n`);
    res.write('data: [DONE]\n\n'); res.end();
    return;
  }

  // NON-STREAMING fallback
  let reply = '';
  if (GROQ_KEY) {
    try {
      const full = [{ role: 'system', content: sys }, ...hist];
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_KEY}` },
        body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages: full, max_tokens: 4000, temperature: 0.75 })
      });
      const d = await r.json();
      reply = d.choices?.[0]?.message?.content || '';
    } catch {}
  }
  res.json({ reply: reply || 'Connection issue. Try again!' });
});

// ── WEB SEARCH ───────────────────────────────────────────────────────────────
app.post('/api/search', async (req, res) => {
  const { query } = req.body;
  if (!query || !TAVILY_KEY) return res.json({ results: [] });

  // Only search for things that actually need live data
  const needsLive = /news|today|latest|now|current|price|weather|score|match|live|trending|stock|2024|2025|2026|recent|update|launched|release/i.test(query);
  if (!needsLive) return res.json({ results: [] });

  try {
    const r = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TAVILY_KEY}` },
      body: JSON.stringify({ query, search_depth: 'basic', max_results: 4 })
    });
    const d = await r.json();
    res.json({ results: d.results || [] });
  } catch { res.json({ results: [] }); }
});

// ── MEMORY ENDPOINTS (Without Gemini) ────────────────────────────────────────
app.post('/api/summarize', async (req, res) => {
  // Gemini removed. Keep returning existing memory.
  res.json({ memory: req.body.existingMemory || '' });
});

app.post('/api/memory/save', async (req, res) => {
  const { fact, existingMemory } = req.body;
  if (!fact) return res.json({ success: false });
  const newMemory = (existingMemory || '') + '\n- ' + fact;
  res.json({ success: true, memory: newMemory.trim() });
});

app.post('/api/memory/clear', async (req, res) => {
  res.json({ success: true, memory: '' });
});

// ── VOICE — User's own ElevenLabs key ────────────────────────────────────────
app.post('/api/speak', async (req, res) => {
  const { text, userKey, voiceId } = req.body;
  // Use user's own key if provided, else use server key
  const key = userKey || ELEVEN_KEY;
  const voice = voiceId || 'QTKSa2Iyv0yoxvXY2V8a';
  if (!text || !key) return res.status(400).json({ error: 'No key available' });
  try {
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'xi-api-key': key },
      body: JSON.stringify({
        text: text.slice(0, 500),
        model_id: 'eleven_turbo_v2_5',
        language_code: 'en',
        voice_settings: { stability: 0.55, similarity_boost: 0.82, style: 0.2, use_speaker_boost: true }
      })
    });
    if (!r.ok) throw new Error('Voice error');
    const buf = await r.arrayBuffer();
    res.setHeader('Content-Type', 'audio/mpeg');
    res.send(Buffer.from(buf));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── VOICE PREVIEW — Uses server key just for previews ────────────────────────
app.post('/api/voice-preview', async (req, res) => {
  const { voiceId } = req.body;
  if (!voiceId || !ELEVEN_KEY) return res.status(400).json({ error: 'No key' });
  try {
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'xi-api-key': ELEVEN_KEY },
      body: JSON.stringify({
        text: "Hi! I'm Riya, your smart AI friend. Tell me what you need today!",
        model_id: 'eleven_turbo_v2_5',
        language_code: 'en',
        voice_settings: { stability: 0.55, similarity_boost: 0.82 }
      })
    });
    if (!r.ok) throw new Error('Preview error');
    const buf = await r.arrayBuffer();
    res.setHeader('Content-Type', 'audio/mpeg');
    res.send(Buffer.from(buf));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── HEALTH ───────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({
  status: '✅ Riya v5.2 — Premium Edition',
  routing: {
    chat: 'Groq (Llama-3.3-70b)',
    search: 'Tavily advanced',
    voice: 'User own ElevenLabs key'
  },
  keys: { groq: !!GROQ_KEY, tavily: !!TAVILY_KEY, eleven: !!ELEVEN_KEY },
  uptime: Math.floor(process.uptime()) + 's'
}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Riya v5.2 Premium Edition on port ${PORT}`));
