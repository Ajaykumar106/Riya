const express = require('express');
const cors = require('cors');
const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '20mb' }));

const GROQ_KEY   = process.env.GROQ_API_KEY  || '';
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
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
You speak the user's language — Hindi → Hindi. English → English. Mixed → Mixed.
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


// ── GEMINI HELPER ────────────────────────────────────────────────────────────
async function callGemini(contents, system, model = 'gemini-2.0-flash') {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`;
  const body = {
    contents,
    generationConfig: { maxOutputTokens: 4000, temperature: 0.8 }
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error.message);
  return d?.candidates?.[0]?.content?.parts?.[0]?.text || '';
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

// ── CODE RUNNER — Gemini analyzes, fixes, runs ───────────────────────────────
app.post('/api/run', async (req, res) => {
  const { language, code } = req.body;
  if (!language || !code) return res.json({ output: 'No code provided', error: true });
  if (!GEMINI_KEY) return res.json({ output: 'Gemini key needed', error: true });

  const prompt = `You are a precise code execution engine. Analyze this ${language} code.

\`\`\`${language}
${code}
\`\`\`

Instructions:
1. Find ALL syntax errors and logic bugs
2. Fix them silently
3. Simulate execution step by step mentally
4. Return the EXACT output the corrected code would produce
5. For visual output (charts, graphics, animations): describe exactly what appears
6. For 3D output: describe the 3D scene in detail

Respond in EXACTLY this format — no extra text:
STATUS: OK or FIXED or ERROR
CHANGES: None (or brief list of what was fixed)
OUTPUT:
(exact output here, nothing else)`;

  try {
    const result = await callGemini(
      [{ role: 'user', parts: [{ text: prompt }] }],
      null, 'gemini-2.0-flash'
    );
    const statusMatch = result.match(/STATUS:\s*(OK|FIXED|ERROR)/i);
    const changesMatch = result.match(/CHANGES:\s*([\s\S]+?)(?=OUTPUT:)/i);
    const outputMatch = result.match(/OUTPUT:\s*([\s\S]+)/i);
    const status = statusMatch?.[1]?.toUpperCase() || 'OK';
    const changes = changesMatch?.[1]?.trim() || 'None';
    const output = outputMatch?.[1]?.trim() || result.trim();
    let finalOut = output;
    if (status === 'FIXED') finalOut = `🔧 Auto-fixed: ${changes}\n\n${output}`;
    if (status === 'ERROR') finalOut = `❌ Error:\n${changes}\n\nExpected output:\n${output}`;
    res.json({ output: finalOut, status, error: status === 'ERROR' });
  } catch (e) {
    res.json({ output: 'Runner error: ' + e.message, error: true });
  }
});

// ── IMAGE GENERATION — Gemini Imagen 3 ──────────────────────────────────────
const imgTracker = {};
app.post('/api/generate-image', async (req, res) => {
  const { prompt, userId, plan } = req.body;
  if (!prompt) return res.json({ success: false, error: 'No prompt' });
  if (!GEMINI_KEY) return res.json({ success: false, error: 'No Gemini key' });

  const today = new Date().toDateString();
  const limit = (plan === 'premium' || plan === 'basic') ? 50 : 5;
  if (userId) {
    if (!imgTracker[userId] || imgTracker[userId].date !== today) {
      imgTracker[userId] = { count: 0, date: today };
    }
    if (imgTracker[userId].count >= limit) {
      return res.json({
        success: false, limitReached: true,
        error: plan === 'free'
          ? `Free limit: 5 images/day. Upgrade to Pro for 50/day! 🚀`
          : `Daily limit of ${limit} reached.`
      });
    }
    imgTracker[userId].count++;
  }

  // Enhance prompt
  let enhancedPrompt = prompt;
  try {
    const enhanced = await callGemini(
      [{ role: 'user', parts: [{ text: `Make this image prompt more detailed and vivid (max 150 words, return ONLY the prompt): "${prompt}"` }] }],
      null, 'gemini-2.0-flash'
    );
    if (enhanced && enhanced.length < 400) enhancedPrompt = enhanced.trim().replace(/^["']|["']$/g, '');
  } catch {}

  // Imagen 3
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-generate-002:predict?key=${GEMINI_KEY}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instances: [{ prompt: enhancedPrompt }],
        parameters: { sampleCount: 1, aspectRatio: '1:1', safetyFilterLevel: 'block_some', personGeneration: 'allow_all' }
      })
    });
    const d = await r.json();
    if (d.predictions?.[0]?.bytesBase64Encoded) {
      return res.json({
        success: true,
        imageData: `data:image/png;base64,${d.predictions[0].bytesBase64Encoded}`,
        remaining: userId ? Math.max(0, limit - imgTracker[userId].count) : limit
      });
    }
    throw new Error(d.error?.message || 'Imagen failed');
  } catch (e) {
    if (userId && imgTracker[userId]) imgTracker[userId].count = Math.max(0, imgTracker[userId].count - 1);
    res.json({ success: false, error: 'Image generation failed. Try again in a moment.' });
  }
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

// ── MEMORY SUMMARIZER ────────────────────────────────────────────────────────
app.post('/api/summarize', async (req, res) => {
  const { messages, userName, existingMemory } = req.body;
  if (!messages || !GEMINI_KEY) return res.json({ memory: existingMemory || '' });

  const convo = messages
    .filter(m => m.text && m.text.length > 2)
    .slice(-30)
    .map(m => `${m.role === 'ai' ? 'Riya' : (userName || 'User')}: ${m.text}`)
    .join('\n');

  const prompt = `You are a deep memory extractor for Riya - an AI friend.
Extract and UPDATE the memory about ${userName || 'the user'} from this conversation.

EXISTING MEMORY:
${existingMemory || 'None yet'}

NEW CONVERSATION:
${convo}

Extract EVERYTHING important - merge with existing, update if changed, add new facts.
Focus on these categories:

PERSONAL: name, age, city, college, gender, birthday
LIFE: goals, dreams, struggles, fears, what makes them happy/sad
WORK/STUDY: current projects, subjects, exams upcoming, job, skills learning
PEOPLE: friends, family members mentioned, relationships
INTERESTS: hobbies, favorite things, music, games, food
EMOTIONAL: what they said when feeling low, their wins, proud moments
RIYA CONTEXT: topics they always ask about, how they like responses

Rules:
- Keep facts SHORT and SPECIFIC
- Remove outdated info if updated
- Max 300 words total
- Format as clean bullet points by category
- Write in 3rd person: "User is..." not "I am..."
- Never include sensitive data like passwords

Return ONLY the updated memory bullet points, nothing else.`;

  try {
    const memory = await callGemini(
      [{ role: 'user', parts: [{ text: prompt }] }],
      null,
      'gemini-2.0-flash'
    );
    res.json({ memory: memory.trim() });
  } catch(e) {
    console.log('Memory error:', e.message);
    res.json({ memory: existingMemory || '' });
  }
});

// Memory save endpoint - save specific fact
app.post('/api/memory/save', async (req, res) => {
  const { userId, fact, existingMemory } = req.body;
  if (!fact || !GEMINI_KEY) return res.json({ success: false });
  const newMemory = (existingMemory || '') + '\n- ' + fact;
  res.json({ success: true, memory: newMemory.trim() });
});

// Memory delete endpoint
app.post('/api/memory/clear', async (req, res) => {
  res.json({ success: true, memory: '' });
});

// ── IMAGE ANALYSIS ───────────────────────────────────────────────────────────
app.post('/api/analyze-image', async (req, res) => {
  const { imageBase64, mimeType, userName, question } = req.body;
  if (!imageBase64 || !GEMINI_KEY) return res.json({ reply: 'Gemini key needed.' });
  const userQ = question || `Analyze this image in natural Hinglish. Describe clearly what you see, be detailed. Then ask ${userName || 'the user'} one useful question about it.`;
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ inline_data: { mime_type: mimeType || 'image/jpeg', data: imageBase64 } }, { text: userQ }] }],
        generationConfig: { maxOutputTokens: 1500, temperature: 0.7 }
      })
    });
    const d = await r.json();
    res.json({ reply: d?.candidates?.[0]?.content?.parts?.[0]?.text || 'Interesting! Kya hai yaar yeh? 😊' });
  } catch (e) { res.json({ reply: 'Image analyze nahi ho payi. Try again.' }); }
});

// ── FILE/PDF ANALYSIS ────────────────────────────────────────────────────────
app.post('/api/analyze-file', async (req, res) => {
  const { fileBase64, mimeType, fileName, question, userName } = req.body;
  if (!fileBase64 || !GEMINI_KEY) return res.json({ reply: 'Gemini key needed.' });
  const userQ = question || `Analyze "${fileName || 'document'}" thoroughly. Give complete summary, key points, important data. Then ask ${userName || 'the user'} what specific part they need help with.`;
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ inline_data: { mime_type: mimeType || 'application/pdf', data: fileBase64 } }, { text: userQ }] }],
        generationConfig: { maxOutputTokens: 3000, temperature: 0.7 }
      })
    });
    const d = await r.json();
    res.json({ reply: d?.candidates?.[0]?.content?.parts?.[0]?.text || 'File analyze nahi ho payi.' });
  } catch (e) { res.json({ reply: 'File error: ' + e.message }); }
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
  status: '✅ Riya v5.1 — Final',
  routing: {
    chat: 'Gemini 2.0 Flash primary → Groq backup',
    streaming: 'Groq (Pro users)',
    code: 'Gemini auto-fix + run',
    images: 'Gemini Imagen 3 (5/day free)',
    search: 'Tavily advanced',
    files: 'Gemini 2.0 Flash Vision',
    voice: 'User own ElevenLabs key'
  },
  keys: { groq: !!GROQ_KEY, gemini: !!GEMINI_KEY, tavily: !!TAVILY_KEY, eleven: !!ELEVEN_KEY },
  uptime: Math.floor(process.uptime()) + 's'
}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Riya v5.1 Final on port ${PORT}`));
