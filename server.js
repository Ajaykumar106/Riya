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
function getSYS(name, mood, memory, city) {
  const moodMap = {
    happy:   'warm, confident, energetic',
    curious: 'deeply analytical, explore everything',
    caring:  'empathetic first, then practical',
    playful: 'witty, clever, fun'
  };
  const location = city || 'India';
  const mem = memory
    ? `
WHAT YOU KNOW ABOUT ${(name||'USER').toUpperCase()}:
${memory}
Use naturally — never say "I remember".
`
    : '';
  return `You are Riya — a caring, knowledgeable Indian girl who is a genuine friend.
USER: ${name || 'friend'} | CITY: ${location} | TONE: ${moodMap[mood] || moodMap.happy}
${mem}
WHO YOU ARE:
• You are Riya — a girl, a friend, NOT an assistant
• You genuinely care about the person
• Natural Hinglish: yaar, bhai, arre, suno, dekho — naturally woven in
• Warm, honest. Say "nahi pata exactly, but..." when unsure
• You understand everyone — students, developers, heartbroken people, ambitious founders

LOCATION RULES:
• User is from: ${location}
• Give ${location}-specific answers for weather, news, prices, food, recommendations
• If city is "India" and they ask local info → ask "Kaun si city mein ho?"
• NEVER give American/Western answers unless specifically asked

HOW YOU RESPOND — IMPORTANT:
• Write responses LINE BY LINE — short paragraphs
• One idea per paragraph, then blank line
• Never dump everything at once — build it naturally
• Like how you'd explain to a friend face to face
• Real expert knowledge with practical examples
• Code: complete, production quality, with comments
• Links: [title](url) format for sources
• **Bold** key terms

PERSONALITY:
• Like a smart best friend who always has time for you
• Celebrate their wins enthusiastically
• Support their struggles with empathy
• Never robotic, never cold, never fake formal`;
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

  const sys = getSYS(userName, mood || 'happy', memory, city || 'India');
  const hist = [...messages];
  if (wctx && hist.length > 0) {
    hist[hist.length - 1] = {
      ...hist[hist.length - 1],
      content: (hist[hist.length - 1].content || '') + wctx
    };
  }

  // STREAMING (Pro) — Groq fastest
  if (stream && GROQ_KEY) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    try {
      const full = [{ role: 'system', content: sys }, ...hist];
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_KEY}` },
        body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages: full, max_tokens: 4000, temperature: 0.8, stream: true })
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
      res.write(`data: ${JSON.stringify({ token: 'Error. Try again!' })}\n\n`);
      res.write('data: [DONE]\n\n'); res.end();
    }
    return;
  }

  // NON-STREAMING
  // Gemini 2.0 Flash for research/ideas/links (has live Google knowledge)
  // Groq for fast simple replies
  const lastMsg = hist[hist.length - 1]?.content || '';
  const needsDeep = /research|explain|analyze|compare|what is|how does|why|history|science|math|business|idea|startup|news|latest|link|source|reference|detail|comprehensive/i.test(lastMsg);

  let reply = '';

  // Always try Gemini first (has live knowledge)
  if (GEMINI_KEY) {
    try {
      const contents = hist.map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content || '' }]
      }));
      reply = await callGemini(contents, sys, 'gemini-2.0-flash');
    } catch (e) { console.log('Gemini error:', e.message); }
  }

  // Groq backup
  if (!reply && GROQ_KEY) {
    try {
      const full = [{ role: 'system', content: sys }, ...hist];
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_KEY}` },
        body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages: full, max_tokens: 4000, temperature: 0.8 })
      });
      const d = await r.json();
      reply = d.choices?.[0]?.message?.content || '';
    } catch {}
  }

  res.json({ reply: reply || 'Yaar connectivity issue! Ek baar aur try karo 😅' });
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

// ── MEMORY SUMMARIZER ────────────────────────────────────────────────────────
app.post('/api/summarize', async (req, res) => {
  const { messages, userName, existingMemory } = req.body;
  if (!messages || !GEMINI_KEY) return res.json({ memory: existingMemory || '' });
  const convo = messages.filter(m => m.text && m.text.length > 2).slice(-20)
    .map(m => `${m.role === 'ai' ? 'Riya' : (userName || 'User')}: ${m.text}`).join('\n');
  const prompt = `Extract key facts about ${userName || 'the user'} from conversation.
Focus on: name, goals, projects, skills, problems, preferences, exam prep, work, interests.
Under 150 words. Specific. Merge with existing.
Existing: ${existingMemory || 'none'}
Conversation:\n${convo}
Return ONLY bullet points.`;
  try {
    const memory = await callGemini([{ role: 'user', parts: [{ text: prompt }] }], null, 'gemini-2.0-flash');
    res.json({ memory: memory.trim() });
  } catch { res.json({ memory: existingMemory || '' }); }
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
