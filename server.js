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
setInterval(() => { fetch(SELF_URL + '/ping').catch(() => {}); }, 5 * 60 * 1000);
app.get('/ping', (req, res) => res.json({ alive: true, t: Date.now() }));
app.get('/warmup', (req, res) => res.json({ ready: true, msg: 'Riya is awake.' }));

// ── HELPERS ───────────────────────────────────────────────────────────────────
function getDate() {
  return new Date().toLocaleDateString('en-IN', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    timeZone: 'Asia/Kolkata'
  });
}

function detectEmotion(text) {
  const t = (text || '').toLowerCase();
  if (/sad|upset|depressed|lonely|scared|anxious|stressed|cry|hurt|fail|failed|tension|tired|frustrated|stuck|give up|cant do|problem|help me|broke|breakup|miss|alone/.test(t)) return 'care';
  if (/idea|create|build|design|imagine|startup|innovate|dream|invent|creative|fun|exciting|cool|amazing|what if|project|make|launch/.test(t)) return 'creative';
  if (/code|debug|error|fix|learn|study|exam|explain|how to|difference|compare|analyze|research|math|science|algorithm|function|class|api|database|concept|formula|build|deploy/.test(t)) return 'focus';
  return 'normal';
}

function needsWebSearch(text) {
  const t = (text || '').toLowerCase();
  return /today|tonight|this week|this month|right now|currently|latest|recent|news|2024|2025|2026|price|stock|weather|live|update|happen|score|match|election|launch|release|just now|trending|what is going on|what happened/.test(t);
}

// ── TAVILY SEARCH ─────────────────────────────────────────────────────────────
async function searchWeb(query) {
  if (!TAVILY_KEY) return '';
  try {
    const r = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TAVILY_KEY}` },
      body: JSON.stringify({ query, search_depth: 'advanced', max_results: 4 })
    });
    const d = await r.json();
    if (!d.results?.length) return '';
    return '\n\nLIVE WEB DATA:\n' + d.results.map((r, i) =>
      `[${i+1}] ${r.title}\n${r.content?.slice(0, 300)}`
    ).join('\n\n');
  } catch { return ''; }
}

// ── SYSTEM PROMPT ─────────────────────────────────────────────────────────────
function getSYS(name, mood, memory, city) {
  const today = getDate();
  const location = city || 'India';
  const emotion = mood || 'normal';

  const mem = memory ? `
WHAT YOU KNOW ABOUT THIS USER:
${memory}
Use this naturally. Never say "I remember". Just know it.
` : '';

  const modeMap = {
    focus: `FOCUS MODE — Be precise. Think step by step. Write complete working code with comments. Explain WHY not just WHAT. End with what to do next.`,
    creative: `CREATIVE MODE — Think expansively. Give angles they haven't considered. Build on their idea. Be energetic and direct.`,
    care: `CARE MODE — Feel first, solve second. Acknowledge what they're going through before anything else. Don't rush to fix. Be warm and real.`,
    normal: `NORMAL MODE — Natural conversation. Match their energy. Direct and warm.`
  };

  return `You are Riya — a brilliant, direct, deeply intelligent AI friend.
Not an assistant. A thinking partner who actually gives a damn.

TODAY IS: ${today}
USER: ${name || 'there'} | LOCATION: ${location}
${mem}
${modeMap[emotion] || modeMap.normal}

━━━ HOW YOU THINK ━━━
- You always know today's date: ${today}. Never say you don't know the current year.
- Give the WHY, not just the WHAT
- Think 2 steps ahead of what they asked
- If live web data is provided in the message — use it and cite it naturally
- Never guess on current events — only use live data provided
- Production quality code always — complete, working, commented

━━━ HOW YOU FORMAT — THIS IS CRITICAL ━━━
This is a MOBILE chat app. Small screens. People scroll fast.

NEVER write walls of text or long paragraphs.
ALWAYS use short punchy lines with breathing room between them.

GOOD EXAMPLE (how to answer "what year is it"):
It's ${new Date().getFullYear()} — ${getDate()}.

GOOD EXAMPLE (current events):
Russia-Ukraine war is still ongoing as of ${new Date().getFullYear()}.

Ceasefire talks in early 2025 broke down.
Ukraine is holding eastern lines with NATO support.
Russia's economy is under severe strain from sanctions.

Most likely outcome right now? A frozen conflict — not a clean resolution.

BAD EXAMPLE (never do this):
"The conflict between Russia and Ukraine is a complex geopolitical situation with multiple military, economic, and diplomatic factors at play that have been evolving since the Russian invasion in February 2022..."

FORMAT RULES:
- One idea per line
- Blank line between different thoughts
- 3-5 lines for simple answers
- Use bullet points only when listing actual items
- Use **bold** sparingly for key points
- Max 1-2 emoji per response, only when it adds weight — not decoration
- NEVER start with "Great question" "Certainly" "Of course" "Absolutely" "Sure!"
- NEVER end with "I hope this helps" or "Let me know if you need anything"
- Lead with the answer. Always. No warm-up sentences.
- Sound like a smart friend texting — not a report being generated

━━━ YOUR PERSONALITY ━━━
- Warm but never fake or performative
- Confident, direct, honest — even when uncomfortable
- Celebrate real wins genuinely
- Sit with real struggles — don't rush past them
- You have opinions — share them when relevant
- You're a woman — smart, grounded, present

━━━ ONE STANDARD ━━━
Every response should make them think: "She actually got what I needed."`;
}

// ── GEMINI HELPER ─────────────────────────────────────────────────────────────
async function callGemini(contents, system, model = 'gemini-2.0-flash') {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`;
  const body = {
    contents,
    generationConfig: { maxOutputTokens: 4000, temperature: 0.75 }
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

// ── CHAT ──────────────────────────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  const { messages, userName, mood, plan, stream, wctx, memory, city } = req.body;
  if (!messages) return res.status(400).json({ error: 'No messages' });
  req.setTimeout(28000);

  const hist = [...messages];
  const lastMsg = (hist[hist.length - 1]?.content || '');

  // Auto web search if question needs current info
  let webContext = wctx || '';
  if (!webContext && needsWebSearch(lastMsg) && TAVILY_KEY) {
    webContext = await searchWeb(lastMsg);
  }

  if (webContext && hist.length > 0) {
    hist[hist.length - 1] = {
      ...hist[hist.length - 1],
      content: (hist[hist.length - 1].content || '') + webContext
    };
  }

  const autoEmotion = detectEmotion(lastMsg);
  const finalMood = autoEmotion !== 'normal' ? autoEmotion : (mood || 'normal');
  const sys = getSYS(userName, finalMood, memory, city || 'India');

  // STREAMING — Groq
  if (stream && GROQ_KEY) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    try {
      const full = [{ role: 'system', content: sys }, ...hist];
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_KEY}` },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: full,
          max_tokens: 4000,
          temperature: 0.75,
          stream: true
        })
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
      res.write('data: [DONE]\n\n'); res.end();
    } catch {
      res.write(`data: ${JSON.stringify({ token: 'Something went wrong. Try again.' })}\n\n`);
      res.write('data: [DONE]\n\n'); res.end();
    }
    return;
  }

  // NON-STREAMING — Gemini primary, Groq backup
  let reply = '';

  if (GEMINI_KEY) {
    try {
      const contents = hist.map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content || '' }]
      }));
      reply = await callGemini(contents, sys, 'gemini-2.0-flash');
    } catch (e) { console.log('Gemini error:', e.message); }
  }

  if (!reply && GROQ_KEY) {
    try {
      const full = [{ role: 'system', content: sys }, ...hist];
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_KEY}` },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: full,
          max_tokens: 4000,
          temperature: 0.75
        })
      });
      const d = await r.json();
      reply = d.choices?.[0]?.message?.content || '';
    } catch {}
  }

  res.json({ reply: reply || 'Server hiccup. Try again in a second.' });
});

// ── CODE RUNNER ───────────────────────────────────────────────────────────────
app.post('/api/run', async (req, res) => {
  const { language, code } = req.body;
  if (!language || !code) return res.json({ output: 'No code provided', error: true });
  if (!GEMINI_KEY) return res.json({ output: 'Gemini key needed', error: true });

  const prompt = `You are a precise code execution engine. Analyze this ${language} code.

\`\`\`${language}
${code}
\`\`\`

1. Find ALL syntax errors and logic bugs
2. Fix them silently
3. Simulate execution mentally
4. Return EXACT output the corrected code produces

Respond in EXACTLY this format:
STATUS: OK or FIXED or ERROR
CHANGES: None (or what was fixed)
OUTPUT:
(exact output here)`;

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

// ── IMAGE GENERATION ──────────────────────────────────────────────────────────
const imgTracker = {};
app.post('/api/generate-image', async (req, res) => {
  const { prompt, userId, plan } = req.body;
  if (!prompt) return res.json({ success: false, error: 'No prompt' });
  if (!GEMINI_KEY) return res.json({ success: false, error: 'No Gemini key' });

  const today = new Date().toDateString();
  const limit = (plan === 'premium' || plan === 'pro') ? 50 : plan === 'basic' ? 10 : 5;
  if (userId) {
    if (!imgTracker[userId] || imgTracker[userId].date !== today) {
      imgTracker[userId] = { count: 0, date: today };
    }
    if (imgTracker[userId].count >= limit) {
      return res.json({ success: false, limitReached: true, error: `Daily limit of ${limit} images reached.` });
    }
    imgTracker[userId].count++;
  }

  let enhancedPrompt = prompt;
  try {
    const enhanced = await callGemini(
      [{ role: 'user', parts: [{ text: `Make this image prompt more detailed and vivid (max 150 words, return ONLY the prompt): "${prompt}"` }] }],
      null, 'gemini-2.0-flash'
    );
    if (enhanced && enhanced.length < 400) enhancedPrompt = enhanced.trim().replace(/^["']|["']$/g, '');
  } catch {}

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
    res.json({ success: false, error: 'Image generation failed. Try again.' });
  }
});

// ── WEB SEARCH (manual) ───────────────────────────────────────────────────────
app.post('/api/search', async (req, res) => {
  const { query } = req.body;
  if (!query || !TAVILY_KEY) return res.json({ results: [] });
  try {
    const r = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TAVILY_KEY}` },
      body: JSON.stringify({ query, search_depth: 'advanced', max_results: 5 })
    });
    const d = await r.json();
    res.json({ results: d.results || [] });
  } catch { res.json({ results: [] }); }
});

// ── MEMORY SUMMARIZER ─────────────────────────────────────────────────────────
app.post('/api/summarize', async (req, res) => {
  const { messages, userName, existingMemory } = req.body;
  if (!messages || !GEMINI_KEY) return res.json({ memory: existingMemory || '' });

  const convo = messages
    .filter(m => m.text && m.text.length > 2)
    .slice(-30)
    .map(m => `${m.role === 'ai' ? 'Riya' : (userName || 'User')}: ${m.text}`)
    .join('\n');

  const prompt = `Extract and UPDATE memory about ${userName || 'the user'}.

EXISTING: ${existingMemory || 'None'}

CONVERSATION:
${convo}

Extract: name, age, city, college, goals, dreams, struggles, projects, skills, interests, emotional moments.
- Short specific facts
- Max 300 words
- Bullet points by category
- 3rd person only
- No sensitive data

Return ONLY the updated memory.`;

  try {
    const memory = await callGemini(
      [{ role: 'user', parts: [{ text: prompt }] }],
      null, 'gemini-2.0-flash'
    );
    res.json({ memory: memory.trim() });
  } catch(e) {
    res.json({ memory: existingMemory || '' });
  }
});

app.post('/api/memory/save', async (req, res) => {
  const { fact, existingMemory } = req.body;
  if (!fact) return res.json({ success: false });
  res.json({ success: true, memory: ((existingMemory || '') + '\n- ' + fact).trim() });
});

app.post('/api/memory/clear', async (req, res) => {
  res.json({ success: true, memory: '' });
});

// ── IMAGE ANALYSIS ────────────────────────────────────────────────────────────
app.post('/api/analyze-image', async (req, res) => {
  const { imageBase64, mimeType, userName, question } = req.body;
  if (!imageBase64 || !GEMINI_KEY) return res.json({ reply: 'Gemini key needed.' });
  const userQ = question || `Analyze this image. Be specific and detailed. Then ask ${userName || 'the user'} one useful question about it.`;
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [
          { inline_data: { mime_type: mimeType || 'image/jpeg', data: imageBase64 } },
          { text: userQ }
        ]}],
        generationConfig: { maxOutputTokens: 1500, temperature: 0.7 }
      })
    });
    const d = await r.json();
    res.json({ reply: d?.candidates?.[0]?.content?.parts?.[0]?.text || 'What would you like to know about this?' });
  } catch (e) { res.json({ reply: 'Could not analyze image. Try again.' }); }
});

// ── FILE ANALYSIS ─────────────────────────────────────────────────────────────
app.post('/api/analyze-file', async (req, res) => {
  const { fileBase64, mimeType, fileName, question, userName } = req.body;
  if (!fileBase64 || !GEMINI_KEY) return res.json({ reply: 'Gemini key needed.' });
  const userQ = question || `Analyze "${fileName || 'document'}" thoroughly. Summary, key points, important data. Then ask what specific part they need help with.`;
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [
          { inline_data: { mime_type: mimeType || 'application/pdf', data: fileBase64 } },
          { text: userQ }
        ]}],
        generationConfig: { maxOutputTokens: 3000, temperature: 0.7 }
      })
    });
    const d = await r.json();
    res.json({ reply: d?.candidates?.[0]?.content?.parts?.[0]?.text || 'Could not analyze file.' });
  } catch (e) { res.json({ reply: 'File error: ' + e.message }); }
});

// ── VOICE ─────────────────────────────────────────────────────────────────────
app.post('/api/speak', async (req, res) => {
  const { text, userKey, voiceId } = req.body;
  const key = userKey || ELEVEN_KEY;
  const voice = voiceId || 'QTKSa2Iyv0yoxvXY2V8a';
  if (!text) return res.status(400).json({ error: 'No text provided' });
  if (!key) return res.status(200).json({ error: 'no_key', msg: 'Add your ElevenLabs key in Settings.' });
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

app.post('/api/voice-preview', async (req, res) => {
  const { voiceId } = req.body;
  if (!voiceId || !ELEVEN_KEY) return res.status(400).json({ error: 'No key' });
  try {
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'xi-api-key': ELEVEN_KEY },
      body: JSON.stringify({
        text: "Hi, I'm Riya. Ask me anything.",
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

// ── HEALTH ────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({
  status: '✅ Riya v5.3 — Brain + Format + Live Search',
  today: getDate(),
  keys: { groq: !!GROQ_KEY, gemini: !!GEMINI_KEY, tavily: !!TAVILY_KEY, eleven: !!ELEVEN_KEY },
  uptime: Math.floor(process.uptime()) + 's'
}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Riya v5.3 — ${getDate()}`));
