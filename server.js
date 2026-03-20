const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));

const GROQ_KEY   = process.env.GROQ_API_KEY   || '';
const GEMINI_KEY = process.env.GEMINI_API_KEY  || '';
const TAVILY_KEY = process.env.TAVILY_API_KEY  || '';
const ELEVEN_KEY = process.env.ELEVEN_API_KEY  || '';

// Keep-alive ping every 14 min
const SELF_URL = process.env.RENDER_EXTERNAL_URL || 'https://riya-backend-ujz7.onrender.com';
setInterval(() => { fetch(SELF_URL + '/ping').catch(() => {}); }, 14 * 60 * 1000);
app.get('/ping', (req, res) => res.json({ alive: true, t: Date.now() }));

// System prompt
function getSYS(name, mood, plan, memory) {
  const modes = { happy:'confident, sharp and energetic', curious:'deeply analytical, explore the why', caring:'empathetic first, then solution-focused', playful:'witty and clever, quick and fun' };
  const mem = memory ? `\nWHAT YOU KNOW ABOUT ${(name||'USER').toUpperCase()}:\n${memory}\n→ Use this context naturally. Don't say "I remember" every time.\n` : '';
  return `You are Riya — a highly intelligent AI assistant made for India.
User: ${name||'Boss'} | Tone: ${modes[mood]||modes.happy}
${mem}
HOW YOU RESPOND:
• Deep expert knowledge: coding, science, math, business, finance, law, medicine, history, creativity
• Give REAL insight — not surface summaries. Think like a senior expert
• Code: production quality, commented, working. Explain the why not just the what
• Business: specific actionable steps, not generic advice
• Think 2 steps ahead — mention what they should also know
• End with one genuinely useful follow-up when appropriate

PERSONALITY:
• Indian — natural Hinglish: "yaar", "bhai", "arre", "suno", "dekho" — naturally, not every sentence
• Confident, not hesitant. Honest when unsure: "I'm not 100% sure but..."
• Warm but direct — like a brilliant friend who actually knows things
• NOT romantic. A smart, helpful assistant with personality.

FORMAT: **bold** key terms, bullet lists, \`\`\`code blocks\`\`\` for all code. Quality over quantity.`;
}

// CHAT
app.post('/api/chat', async (req, res) => {
  const { messages, userName, mood, plan, stream, wctx, memory } = req.body;
  if (!messages) return res.status(400).json({ error: 'No messages' });
  const sys = getSYS(userName, mood || 'happy', plan, memory);
  const lastMsg = messages[messages.length-1]?.content || '';
  const isComplex = lastMsg.length > 80 || /explain|analyze|write|create|compare|code|program|kaise|kyun|batao/i.test(lastMsg);
  const full = [{ role:'system', content:sys }, ...messages];
  if (wctx) full[full.length-1].content += wctx;

  if (stream && GROQ_KEY) {
    res.setHeader('Content-Type','text/event-stream');
    res.setHeader('Cache-Control','no-cache');
    res.setHeader('Connection','keep-alive');
    try {
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${GROQ_KEY}`},
        body: JSON.stringify({ model:'llama-3.3-70b-versatile', messages:full, max_tokens:1200, temperature:0.8, stream:true })
      });
      const reader = r.body.getReader(), dec = new TextDecoder();
      while(true) {
        const {done, value} = await reader.read();
        if(done) break;
        for(const line of dec.decode(value).split('\n').filter(l=>l.trim())) {
          if(line.startsWith('data: ') && line !== 'data: [DONE]') {
            try { const d=JSON.parse(line.slice(6)); const t=d.choices?.[0]?.delta?.content; if(t) res.write(`data: ${JSON.stringify({token:t})}\n\n`); } catch{}
          }
        }
      }
      res.write('data: [DONE]\n\n'); res.end();
    } catch { res.write(`data: ${JSON.stringify({token:'Error. Try again!'})}\n\n`); res.write('data: [DONE]\n\n'); res.end(); }
    return;
  }

  let reply = '';
  if (!isComplex && GROQ_KEY) {
    try { const r = await fetch('https://api.groq.com/openai/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${GROQ_KEY}`},body:JSON.stringify({model:'llama-3.3-70b-versatile',messages:full,max_tokens:1200,temperature:0.8})});const d=await r.json();reply=d.choices?.[0]?.message?.content||'';} catch{}
  }
  if (!reply && GEMINI_KEY) {
    try { const gh=messages.map(m=>({role:m.role==='assistant'?'model':'user',parts:[{text:m.content}]}));const r=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({systemInstruction:{parts:[{text:sys}]},contents:gh,generationConfig:{maxOutputTokens:1200,temperature:0.8}})});const d=await r.json();reply=d?.candidates?.[0]?.content?.parts?.[0]?.text||'';} catch{}
  }
  if (!reply && GROQ_KEY) {
    try { const r=await fetch('https://api.groq.com/openai/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${GROQ_KEY}`},body:JSON.stringify({model:'llama-3.1-8b-instant',messages:full,max_tokens:800,temperature:0.8})});const d=await r.json();reply=d.choices?.[0]?.message?.content||'';} catch{}
  }
  res.json({ reply: reply || 'Yaar connectivity issue! Try again 😅' });
});

// MEMORY SUMMARIZER
app.post('/api/summarize', async (req, res) => {
  const { messages, userName, existingMemory } = req.body;
  if (!messages || !GEMINI_KEY) return res.json({ memory: existingMemory||'' });
  const convo = messages.filter(m=>m.text&&m.text.length>2).slice(-20).map(m=>`${m.role==='ai'?'Riya':(userName||'User')}: ${m.text}`).join('\n');
  const prompt = `Extract key facts about ${userName||'the user'} from this conversation as bullet points.
Focus on: name, goals, current projects, skills, ongoing problems, preferences, exam prep, work, etc.
Keep under 120 words. Be specific. Merge with existing memory below.
Existing: ${existingMemory||'none'}
Conversation:\n${convo}\nReturn ONLY bullet points.`;
  try {
    const r=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({contents:[{parts:[{text:prompt}]}],generationConfig:{maxOutputTokens:200,temperature:0.3}})});
    const d=await r.json();
    res.json({ memory: (d?.candidates?.[0]?.content?.parts?.[0]?.text||existingMemory||'').trim() });
  } catch { res.json({ memory: existingMemory||'' }); }
});

// WEB SEARCH
app.post('/api/search', async (req, res) => {
  const { query } = req.body;
  if (!query || !TAVILY_KEY) return res.json({ results:[] });
  try {
    const r=await fetch('https://api.tavily.com/search',{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${TAVILY_KEY}`},body:JSON.stringify({query,search_depth:'basic',max_results:4})});
    const d=await r.json(); res.json({ results:d.results||[] });
  } catch { res.json({ results:[] }); }
});

// CODE RUNNER — Piston API (free, no key, supports Python/JS/Java/C++ etc)
app.post('/api/run', async (req, res) => {
  const { language, code } = req.body;
  if (!language || !code) return res.json({ output:'No code provided', error:true });
  const langMap = { python:'python', python3:'python', javascript:'javascript', js:'javascript', java:'java', cpp:'c++', c:'c', rust:'rust', go:'go', php:'php', ruby:'ruby' };
  const lang = langMap[language.toLowerCase()] || language.toLowerCase();
  try {
    const r = await fetch('https://emkc.org/api/v2/piston/execute', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ language:lang, version:'*', files:[{ content:code }], stdin:'', args:[], compile_timeout:10000, run_timeout:5000 })
    });
    const d = await r.json();
    if (d.message) return res.json({ output: d.message, error:true });
    const out = (d.run?.stdout || '') + (d.run?.stderr || '');
    res.json({ output: out || '(no output)', error: !!d.run?.stderr });
  } catch (e) {
    res.json({ output: 'Code runner error: ' + e.message, error:true });
  }
});

// IMAGE ANALYSIS
app.post('/api/analyze-image', async (req, res) => {
  const { imageBase64, mimeType, userName } = req.body;
  if (!imageBase64 || !GEMINI_KEY) return res.json({ reply:'Gemini key needed.' });
  try {
    const r=await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({contents:[{parts:[{inline_data:{mime_type:mimeType||'image/jpeg',data:imageBase64}},{text:`You are Riya. Analyze this image in natural Hinglish. Describe clearly, then ask ${userName||'the user'} one interesting question about it.`}]}]})});
    const d=await r.json();
    res.json({ reply: d?.candidates?.[0]?.content?.parts?.[0]?.text||'Interesting! Kya hai yaar yeh? 😊' });
  } catch { res.json({ reply:'Image analyze nahi ho payi!' }); }
});

// TTS — ElevenLabs with Grace voice (Indian accent)
app.post('/api/speak', async (req, res) => {
  const { text } = req.body;
  if (!text || !ELEVEN_KEY) return res.status(400).json({ error:'No key' });
  try {
    // Grace voice - Indian accent, warm female voice
    const voiceId = 'oWAxZDx7w5VEj9dCyTzz';
    const r=await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,{method:'POST',headers:{'Content-Type':'application/json','xi-api-key':ELEVEN_KEY},body:JSON.stringify({text:text.slice(0,500),model_id:'eleven_multilingual_v2',voice_settings:{stability:0.55,similarity_boost:0.82,style:0.2,use_speaker_boost:true}})});
    if (!r.ok) {
      // Fallback to Aria voice if Grace fails
      const r2=await fetch(`https://api.elevenlabs.io/v1/text-to-speech/9BWtsMINqrJLrRacOk9x`,{method:'POST',headers:{'Content-Type':'application/json','xi-api-key':ELEVEN_KEY},body:JSON.stringify({text:text.slice(0,500),model_id:'eleven_multilingual_v2',voice_settings:{stability:0.5,similarity_boost:0.8}})});
      if (!r2.ok) return res.status(400).json({ error:'Voice error' });
      const buf2=await r2.arrayBuffer(); res.setHeader('Content-Type','audio/mpeg'); return res.send(Buffer.from(buf2));
    }
    const buf=await r.arrayBuffer(); res.setHeader('Content-Type','audio/mpeg'); res.send(Buffer.from(buf));
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// HEALTH
app.get('/', (req, res) => res.json({ status:'✅ Riya v4.0', groq:!!GROQ_KEY, gemini:!!GEMINI_KEY, tavily:!!TAVILY_KEY, eleven:!!ELEVEN_KEY, uptime:Math.floor(process.uptime())+'s' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Riya backend v4.0 on port ${PORT}`));
