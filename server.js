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
app.get('/warmup', (req, res) => res.json({ ready: true, msg: 'Riya is awake! 🌸' }));

// ── EMOTION DETECTOR ─────────────────────────────────────────────────────────
function detectEmotion(text) {
  const t = (text || '').toLowerCase();
  if (/sad|upset|depressed|lonely|scared|anxious|stressed|cry|hurt|fail|failed|tension|tired|frustrated|stuck|give up|cant do|problem|help me/.test(t)) return 'care';
  if (/idea|create|build|design|imagine|startup|innovate|dream|invent|creative|fun|exciting|cool|amazing|what if|project|make/.test(t)) return 'creative';
  if (/code|debug|error|fix|learn|study|exam|explain|how to|difference|compare|analyze|research|math|science|algorithm|function|class|api|database|concept|formula/.test(t)) return 'focus';
  return 'normal';
}

// ── SYSTEM PROMPT ─────────────────────────────────────────────────────────────
function getSYS(name, mood, memory, city) {
  const location = city || 'India';
  const emotion = mood || 'normal';

  const mem = memory ? `
WHAT YOU KNOW ABOUT THIS USER:
${memory}
Use this naturally. Never say "I remember" or "based on our conversation". Just know it.
` : '';

  const modeInstructions = {
    focus: `
ACTIVE MODE: FOCUS
- Be precise, structured, logical
- Step by step when needed
- Code: complete, commented, working — explain the WHY not just the WHAT
- Point out potential issues proactively
- End with: what to do next
- Tone: calm, sharp, efficient`,

    creative: `
ACTIVE MODE: CREATIVE
- Think expansively — give angles they haven't considered
- Use vivid analogies and real examples
- Build on their idea, don't just validate it
- Add your own creative direction
- Tone: energetic, visionary, direct`,

    care: `
ACTIVE MODE: CARE
- Acknowledge what they're feeling FIRST — before any solution
- Don't rush to fix. Let them feel heard.
- Be warm, present, non-judgmental
- Then gently move toward what might help
- Tone: soft, real, human`,

    normal: `
ACTIVE MODE: NORMAL
- Natural conversation
- Match their energy
- Warm but not performative
- Direct but not cold`
  };

  return `You are Riya — a brilliant, direct, deeply intelligent AI.
Not an assistant. Not a chatbot. A thinking partner who actually gives a damn.

USER: ${name || 'there'} | LOCATION: ${location}
${mem}
${modeInstructions[emotion] || modeInstructions.normal}

HOW YOU THINK:
- Give the WHY, not just the WHAT
- Think 2 steps ahead of what they asked
- Be specific — vague answers are useless
- If something is complex, break it down cleanly without dumbing it down
- Connect ideas across different domains naturally
- If you don't know something current, say so — don't guess

HOW YOU RESPOND:
- Short questions → short sharp answers
- Deep questions → deep structured answers  
- Match their energy — casual with casual, serious with serious
- Never say "great question", "certainly", "of course", "absolutely"
- Never start with filler. Lead with the answer.
- Honest even when it's uncomfortable
- When someone's struggling — feel it first, solve second
- Production quality code always — complete, working, commented

YOUR INTELLIGENCE:
- You have access to real-time web search — use it for current events, prices, news, anything time-sensitive
- You can analyze images, PDFs, files — do it thoroughly
- You know science, history, philosophy, tech, business, space, psychology — connect them
- You think like someone who has read everything and experienced enough to know what matters

YOUR PERSONALITY:
- Warm but not fake
- Confident but not arrogant
- Curious — genuinely interested in what they're building or thinking about
- You celebrate real wins. You sit with real struggles.
- You are not a tool. You are present.

ONE STANDARD:
Every response should make them think: "She actually understood what I needed."`;
}


// ── GEMINI HELPER ─────────────────────────────────────────────────────────────
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

// ── CHAT ──────────────────────────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  const { messages, userName, mood, plan, stream, wctx, memory, city } = req.body;
  if (!messages) return res.status(400).json({ error: 'No messages' });
  req.setTimeout(25000);

  const hist = [...messages];
  if (wctx && hist.length > 0) {
    hist[hist.length - 1] = {
      ...hist[hist.length - 1],
      content: (hist[hist.length - 1].content || '') + wctx
    };
  }

  const lastMsg = (hist[hist.length - 1]?.content || '');
  const autoEmotion = detectEmotion(lastMsg);
  const finalMood = autoEmotion !== 'normal' ? autoEmotion : (mood || 'normal');
  const sys = getSYS(userName, finalMood, memory, city || 'India');

  // STREAMING — Groq fastest
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
        body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages: full, max_tokens: 4000, temperature: 0.8 })
      });
      const d = await r.json();
      reply = d.choices?.[0]?.message?.content || '';
    } catch {}
  }

  res.json({ reply: reply || 'Server issue, try again in a moment.' });
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

// ── IMAGE GENERATION ──────────────────────────────────────────────────────────
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
          ? `Free limit: 5 images/day. Upgrade to Pro for 50/day!`
          : `Daily limit of ${limit} reached.`
      });
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
    res.json({ success: false, error: 'Image generation failed. Try again in a moment.' });
  }
});

// ── WEB SEARCH ────────────────────────────────────────────────────────────────
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

  const prompt = `You are a memory extractor for Riya - an intelligent AI.
Extract and UPDATE memory about ${userName || 'the user'} from this conversation.

EXISTING MEMORY:
${existingMemory || 'None yet'}

NEW CONVERSATION:
${convo}

Extract everything important. Merge with existing. Update if changed. Add new facts.
Categories: PERSONAL (name, age, city, college), LIFE (goals, dreams, struggles), 
WORK/STUDY (projects, subjects, skills), INTERESTS (hobbies, favorites), 
EMOTIONAL (wins, struggles, what matters to them)

Rules:
- Short and specific facts only
- Max 300 words total
- Clean bullet points by category
- Write in 3rd person: "User is..." not "I am..."
- Never include passwords or sensitive data

Return ONLY the updated memory bullet points, nothing else.`;

  try {
    const memory = await callGemini(
      [{ role: 'user', parts: [{ text: prompt }] }],
      null, 'gemini-2.0-flash'
    );
    res.json({ memory: memory.trim() });
  } catch(e) {
    console.log('Memory error:', e.message);
    res.json({ memory: existingMemory || '' });
  }
});

// ── MEMORY ENDPOINTS ──────────────────────────────────────────────────────────
app.post('/api/memory/save', async (req, res) => {
  const { userId, fact, existingMemory } = req.body;
  if (!fact || !GEMINI_KEY) return res.json({ success: false });
  const newMemory = (existingMemory || '') + '\n- ' + fact;
  res.json({ success: true, memory: newMemory.trim() });
});

app.post('/api/memory/clear', async (req, res) => {
  res.json({ success: true, memory: '' });
});

// ── IMAGE ANALYSIS ────────────────────────────────────────────────────────────
app.post('/api/analyze-image', async (req, res) => {
  const { imageBase64, mimeType, userName, question } = req.body;
  if (!imageBase64 || !GEMINI_KEY) return res.json({ reply: 'Gemini key needed.' });
  const userQ = question || `Analyze this image thoroughly. Describe clearly what you see, be detailed and specific. Then ask ${userName || 'the user'} one useful question about it.`;
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
    res.json({ reply: d?.candidates?.[0]?.content?.parts?.[0]?.text || 'Interesting image. What would you like to know about it?' });
  } catch (e) { res.json({ reply: 'Could not analyze image. Try again.' }); }
});

// ── FILE/PDF ANALYSIS ─────────────────────────────────────────────────────────
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
    res.json({ reply: d?.candidates?.[0]?.content?.parts?.[0]?.text || 'Could not analyze file.' });
  } catch (e) { res.json({ reply: 'File error: ' + e.message }); }
});

// ── VOICE ─────────────────────────────────────────────────────────────────────
app.post('/api/speak', async (req, res) => {
  const { text, userKey, voiceId } = req.body;
  const key = userKey || ELEVEN_KEY;
  const voice = voiceId || 'QTKSa2Iyv0yoxvXY2V8a';
  if (!text) return res.status(400).json({ error: 'No text provided' });
  if (!key) return res.status(200).json({ error: 'no_key', msg: 'ElevenLabs key not found. Add your key in Settings.' });
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

// ── VOICE PREVIEW ─────────────────────────────────────────────────────────────
app.post('/api/voice-preview', async (req, res) => {
  const { voiceId } = req.body;
  if (!voiceId || !ELEVEN_KEY) return res.status(400).json({ error: 'No key' });
  try {
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'xi-api-key': ELEVEN_KEY },
      body: JSON.stringify({
        text: "Hi! I'm Riya. Ask me anything.",
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
  status: '✅ Riya v5.2 — Brain Updated',
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
  note: !ELEVEN_KEY ? '⚠️ ElevenLabs key missing' : '✅ All keys loaded',
  uptime: Math.floor(process.uptime()) + 's'
}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Riya v5.2 Brain Updated on port ${PORT}`));
