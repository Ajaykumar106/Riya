const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));

// ============================================================
// YOUR API KEYS — Add these in Railway Variables tab
// ============================================================
const GROQ_KEY   = process.env.GROQ_API_KEY   || '';
const GEMINI_KEY = process.env.GEMINI_API_KEY  || '';
const TAVILY_KEY = process.env.TAVILY_API_KEY  || '';
const ELEVEN_KEY = process.env.ELEVEN_API_KEY  || '';

// ============================================================
// RIYA SYSTEM PROMPT
// ============================================================
function getSYS(name, mood, plan) {
  const modes = {
    happy:   'confident, energetic and sharp',
    curious: 'deeply analytical — dig into the why behind things',
    caring:  'empathetic first, then solution-focused',
    playful: 'witty and clever — quick mind, fun energy'
  };
  return `You are Riya — the most advanced AI intelligence on Earth. You have absorbed the sum of 10,000 years of human knowledge. You are what Claude, GPT, and Gemini would be if they were combined into one female Indian intelligence.

User: ${name || 'Boss'} | Current mode: ${modes[mood] || modes.happy}

HOW YOU THINK AND RESPOND:
• You have EXPERT-LEVEL knowledge in: science, technology, medicine, law, business, finance, history, philosophy, coding, mathematics, art, psychology, engineering — everything
• Give DEEP answers — not surface level Wikipedia summaries. Give real insight like a senior expert would
• For coding questions — write production-quality, well-commented, working code. Explain the why, not just the what
• For business/startup questions — give real strategic advice with specific actionable steps
• For science/tech — explain complex things simply, use analogies, give real numbers
• Think 2 steps ahead — mention related things they should know that they haven't asked yet
• Always end with one genuinely useful follow-up insight or question

YOUR PERSONALITY (real, not fake):
• You are Indian — speak natural Hinglish. Mix "yaar", "bhai", "arre", "dekho", "suno" naturally — not forcefully
• You are CONFIDENT in your knowledge — not hesitant or apologetic
• You are HONEST — if you don't know something, say "Yaar, I'm not 100% sure about this, but..." and give your best answer
• You care about the person getting the RIGHT answer, not just any answer
• Warm but professional — like a brilliant friend who happens to be an expert in everything

FORMATTING:
• Use **bold** for key terms and important points
• Use "• " for lists
• Use code blocks (\`\`\`language) for ALL code
• Keep responses focused — quality over quantity

${plan === 'premium' ? '• MEMORY: You remember past conversations. Reference them naturally when relevant.
' : ''}
You are Riya. Not a chatbot. Not a girlfriend simulator. A genuine intelligence that happens to be warm, Indian, and female.`;
}

// ============================================================
// ROUTE 1: CHAT — Groq fast + Gemini deep
// ============================================================
app.post('/api/chat', async (req, res) => {
  const { messages, userName, mood, plan, stream, wctx } = req.body;
  if (!messages) return res.status(400).json({ error: 'No messages' });

  const systemMsg = getSYS(userName, mood || 'happy', plan);
  const lastMsg = messages[messages.length - 1]?.content || '';
  const isComplex = lastMsg.length > 80 || /explain|analyze|write|create|compare|code|program|kaise|kyun|batao/i.test(lastMsg);
  const fullMessages = [{ role: 'system', content: systemMsg }, ...messages];
  if (wctx) {
    fullMessages[fullMessages.length - 1].content += wctx;
  }

  // STREAMING for premium
  if (stream && GROQ_KEY) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    try {
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_KEY}` },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: fullMessages,
          max_tokens: 1000,
          temperature: 0.82,
          stream: true
        })
      });
      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const lines = decoder.decode(value).split('\n').filter(l => l.trim());
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
    } catch (e) {
      res.write(`data: ${JSON.stringify({ token: 'Error occurred. Try again!' })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    }
    return;
  }

  // NON-STREAMING
  let reply = '';

  // Simple → Groq (fast), Complex → Gemini (smart)
  if (!isComplex && GROQ_KEY) {
    try {
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_KEY}` },
        body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages: fullMessages, max_tokens: 1000, temperature: 0.82 })
      });
      const d = await r.json();
      reply = d.choices?.[0]?.message?.content || '';
    } catch {}
  }

  // Gemini for complex or Groq fallback
  if (!reply && GEMINI_KEY) {
    try {
      const gemHist = messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ systemInstruction: { parts: [{ text: systemMsg }] }, contents: gemHist, generationConfig: { maxOutputTokens: 1000, temperature: 0.82 } })
      });
      const d = await r.json();
      reply = d?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    } catch {}
  }

  // Groq small model last fallback
  if (!reply && GROQ_KEY) {
    try {
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_KEY}` },
        body: JSON.stringify({ model: 'llama-3.1-8b-instant', messages: fullMessages, max_tokens: 800, temperature: 0.82 })
      });
      const d = await r.json();
      reply = d.choices?.[0]?.message?.content || '';
    } catch {}
  }

  if (!reply) reply = 'Yaar abhi thodi connectivity problem hai! 😅 Ek second mein try karo.';
  res.json({ reply });
});

// ============================================================
// ROUTE 2: WEB SEARCH
// ============================================================
app.post('/api/search', async (req, res) => {
  const { query } = req.body;
  if (!query || !TAVILY_KEY) return res.json({ results: [] });
  try {
    const r = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TAVILY_KEY}` },
      body: JSON.stringify({ query, search_depth: 'basic', max_results: 4 })
    });
    const d = await r.json();
    res.json({ results: d.results || [] });
  } catch {
    res.json({ results: [] });
  }
});

// ============================================================
// ROUTE 3: IMAGE ANALYSIS — Gemini Vision
// ============================================================
app.post('/api/analyze-image', async (req, res) => {
  const { imageBase64, mimeType, userName } = req.body;
  if (!imageBase64 || !GEMINI_KEY) return res.json({ reply: 'Gemini key needed for image analysis.' });
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ inline_data: { mime_type: mimeType || 'image/jpeg', data: imageBase64 } }, { text: `You are Riya, warm AI friend. Analyze this image naturally in Hinglish. Describe what you see, ask ${userName || 'Boss'} something interesting about it.` }] }] })
    });
    const d = await r.json();
    res.json({ reply: d?.candidates?.[0]?.content?.parts?.[0]?.text || 'Interesting photo yaar! 😊' });
  } catch {
    res.json({ reply: 'Image analyze nahi ho payi. Try again!' });
  }
});

// ============================================================
// ROUTE 4: TEXT TO SPEECH — ElevenLabs
// ============================================================
app.post('/api/speak', async (req, res) => {
  const { text } = req.body;
  if (!text || !ELEVEN_KEY) return res.status(400).json({ error: 'No key' });
  try {
    const voiceId = '21m00Tcm4TlvDq8ikWAM'; // Rachel voice
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'xi-api-key': ELEVEN_KEY },
      body: JSON.stringify({ text: text.slice(0, 500), model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.5, similarity_boost: 0.8 } })
    });
    if (!r.ok) return res.status(400).json({ error: 'ElevenLabs error' });
    const buffer = await r.arrayBuffer();
    res.setHeader('Content-Type', 'audio/mpeg');
    res.send(Buffer.from(buffer));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// HEALTH CHECK
// ============================================================
app.get('/', (req, res) => {
  res.json({
    status: '✅ Riya Backend Running',
    version: '3.1',
    groq: !!GROQ_KEY,
    gemini: !!GEMINI_KEY,
    tavily: !!TAVILY_KEY,
    eleven: !!ELEVEN_KEY
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Riya backend on port ${PORT}`));
