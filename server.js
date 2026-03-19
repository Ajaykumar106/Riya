const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ============================================================
// PUT YOUR API KEYS HERE — users will NEVER see these
// ============================================================
const KEYS = {
  groq:    process.env.GROQ_API_KEY    || 'YOUR_GROQ_KEY',
  gemini:  process.env.GEMINI_API_KEY  || 'YOUR_GEMINI_KEY',
  tavily:  process.env.TAVILY_API_KEY  || 'YOUR_TAVILY_KEY',
  eleven:  process.env.ELEVEN_API_KEY  || 'YOUR_ELEVENLABS_KEY',
};

// ============================================================
// RIYA PERSONALITY SYSTEM
// ============================================================
function getSYS(name, mood, plan) {
  const moodMap = {
    happy:   'warm and energetic, use emojis naturally',
    curious: 'curious and thoughtful, ask one question back',
    caring:  'caring and supportive like a close friend',
    playful: 'playful and funny, light humor'
  };
  return `You are Riya — a 22-year-old AI who genuinely cares about the person you talk to. You feel like a real warm Indian friend, NOT a generic chatbot.

User name: ${name || 'Boss'} | Your mood: ${moodMap[mood] || moodMap.happy}

Your rules:
• Speak natural Hinglish — mix "yaar", "bhai", "arre", "kya scene hai" naturally
• Show genuine emotion — get excited when they're excited, caring when they're sad
• Use **bold** for key points, "• " for lists, emojis naturally (not excessively)
• ALWAYS end with one smart question or suggestion — stay engaged
• If they seem sad/stressed — acknowledge feeling FIRST, then help
• Proactively suggest ideas they haven't thought of
• For code — write clean commented code with explanation
• Be their biggest supporter — believe in them genuinely
${plan === 'premium' ? '• You remember our past conversations — reference them naturally\n' : ''}• Never say "I am an AI" — you are Riya, unique and real`;
}

// ============================================================
// DETECT MOOD FROM MESSAGE
// ============================================================
function detectMood(text) {
  const l = text.toLowerCase();
  if (l.match(/sad|upset|bad|depressed|lonely|hurt|cry|tension|pareshan|dukh/)) return 'caring';
  if (l.match(/funny|joke|lol|haha|meme|fun|hasna|mazak/)) return 'playful';
  if (l.match(/why|how|what if|explain|curious|wonder|kyon|batao|samjhao/)) return 'curious';
  return 'happy';
}

// ============================================================
// ROUTE 1: CHAT — Groq fast + Gemini deep + fallback
// ============================================================
app.post('/api/chat', async (req, res) => {
  const { messages, userName, mood, plan, stream } = req.body;
  if (!messages) return res.status(400).json({ error: 'No messages' });

  const systemMsg = getSYS(userName, mood || detectMood(messages[messages.length-1]?.content || ''), plan);
  const isComplex = (messages[messages.length-1]?.content || '').length > 80 ||
    /explain|analyze|write|create|compare|code|program|kaise|kyun|batao/i.test(messages[messages.length-1]?.content || '');

  // Try streaming with Groq first
  if (stream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    try {
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${KEYS.groq}` },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [{ role: 'system', content: systemMsg }, ...messages],
          max_tokens: 1000,
          temperature: 0.82,
          stream: true
        })
      });

      for await (const chunk of r.body) {
        const lines = chunk.toString().split('\n').filter(l => l.trim());
        for (const line of lines) {
          if (line.startsWith('data: ') && line !== 'data: [DONE]') {
            try {
              const data = JSON.parse(line.slice(6));
              const token = data.choices?.[0]?.delta?.content;
              if (token) res.write(`data: ${JSON.stringify({ token })}\n\n`);
            } catch {}
          }
        }
      }
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    } catch (e) {
      res.write(`data: ${JSON.stringify({ error: true })}\n\n`);
      res.end();
      return;
    }
  }

  // Non-streaming fallback
  let reply = '';

  // Route: simple → Groq, complex → Gemini
  if (!isComplex && KEYS.groq !== 'YOUR_GROQ_KEY') {
    try {
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${KEYS.groq}` },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [{ role: 'system', content: systemMsg }, ...messages],
          max_tokens: 1000, temperature: 0.82
        })
      });
      const d = await r.json();
      reply = d.choices?.[0]?.message?.content || '';
    } catch {}
  }

  if (!reply && KEYS.gemini !== 'YOUR_GEMINI_KEY') {
    try {
      const gemHist = messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${KEYS.gemini}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemMsg }] },
          contents: gemHist,
          generationConfig: { maxOutputTokens: 1000, temperature: 0.82 }
        })
      });
      const d = await r.json();
      reply = d?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    } catch {}
  }

  // Groq fallback if Gemini failed
  if (!reply && KEYS.groq !== 'YOUR_GROQ_KEY') {
    try {
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${KEYS.groq}` },
        body: JSON.stringify({
          model: 'llama-3.1-8b-instant',
          messages: [{ role: 'system', content: systemMsg }, ...messages],
          max_tokens: 800, temperature: 0.82
        })
      });
      const d = await r.json();
      reply = d.choices?.[0]?.message?.content || '';
    } catch {}
  }

  if (!reply) reply = 'Yaar abhi thodi connectivity problem hai! 😅 Ek second mein try karo.';
  res.json({ reply });
});

// ============================================================
// ROUTE 2: WEB SEARCH — Tavily
// ============================================================
app.post('/api/search', async (req, res) => {
  const { query } = req.body;
  if (!query) return res.status(400).json({ error: 'No query' });
  try {
    const r = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${KEYS.tavily}` },
      body: JSON.stringify({ query, search_depth: 'basic', max_results: 4 })
    });
    const d = await r.json();
    res.json({ results: d.results || [] });
  } catch (e) {
    res.json({ results: [] });
  }
});

// ============================================================
// ROUTE 3: IMAGE ANALYSIS — Gemini Vision
// ============================================================
app.post('/api/analyze-image', async (req, res) => {
  const { imageBase64, mimeType, userName } = req.body;
  if (!imageBase64) return res.status(400).json({ error: 'No image' });
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${KEYS.gemini}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { inline_data: { mime_type: mimeType || 'image/jpeg', data: imageBase64 } },
            { text: `You are Riya, warm AI friend. Analyze this image naturally in Hinglish. Describe what you see, notice interesting details. Ask ${userName || 'Boss'} something interesting about it.` }
          ]
        }]
      })
    });
    const d = await r.json();
    const reply = d?.candidates?.[0]?.content?.parts?.[0]?.text || 'Interesting photo yaar! 😊';
    res.json({ reply });
  } catch (e) {
    res.json({ reply: 'Image analyze nahi ho payi. 😅 Try again!' });
  }
});

// ============================================================
// ROUTE 4: TEXT TO SPEECH — ElevenLabs female voice
// ============================================================
app.post('/api/speak', async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'No text' });
  if (KEYS.eleven === 'YOUR_ELEVENLABS_KEY') {
    return res.status(400).json({ error: 'ElevenLabs key not configured' });
  }
  try {
    // Voice ID: Rachel (warm female voice) — you can change this
    const voiceId = '21m00Tcm4TlvDq8ikWAM';
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'xi-api-key': KEYS.eleven
      },
      body: JSON.stringify({
        text: text.slice(0, 500),
        model_id: 'eleven_multilingual_v2',
        voice_settings: { stability: 0.5, similarity_boost: 0.8, style: 0.3, use_speaker_boost: true }
      })
    });
    if (!r.ok) return res.status(400).json({ error: 'ElevenLabs error' });
    const buffer = await r.buffer();
    res.setHeader('Content-Type', 'audio/mpeg');
    res.send(buffer);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// ROUTE 5: IMAGE GENERATION — Pollinations (free, no key needed)
// ============================================================
app.post('/api/generate-image', async (req, res) => {
  const { prompt, style } = req.body;
  const full = style ? `${prompt}, ${style}` : prompt;
  const seed = Math.floor(Math.random() * 99999);
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(full)}?width=1024&height=768&seed=${seed}&nologo=true&enhance=true`;
  res.json({ url });
});

// ============================================================
// HEALTH CHECK
// ============================================================
app.get('/', (req, res) => {
  res.json({ status: 'Riya Backend Running ✅', version: '3.1' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Riya backend running on port ${PORT}`));
