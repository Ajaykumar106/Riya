const express = require('express');
const cors = require('cors');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '20mb' }));

// ── ENVIRONMENT KEYS ────────────────────────────────────────────────────────
const GROQ_KEY     = process.env.GROQ_API_KEY      || '';
const GEMINI_KEY   = process.env.GEMINI_API_KEY    || '';
const TAVILY_KEY   = process.env.TAVILY_API_KEY    || '';
const TELEGRAM_KEY = process.env.TELEGRAM_BOT_TOKEN || '';

// Keep Render free service awake
const SELF_URL = process.env.RENDER_EXTERNAL_URL || 'https://riya-backend-ujz7.onrender.com';
setInterval(() => { 
  if (SELF_URL) fetch(SELF_URL + '/ping').catch(() => {}); 
}, 14 * 60 * 1000);

app.get('/ping', (req, res) => res.json({ alive: true, t: Date.now() }));
app.get('/healthz', (req, res) => res.json({ status: 'healthy', t: Date.now() }));

// ── PERSISTENT MEMORY ────────────────────────────────────────────────────────
const MEMORY_FILE = path.join(__dirname, 'memory.json');

function loadMemory() {
  try {
    if (fs.existsSync(MEMORY_FILE)) {
      return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf-8'));
    }
  } catch (e) {
    console.error('[Memory] Error loading memory:', e.message);
  }
  return {
    profile: {
      name: 'Ajay Kumar AJ',
      role: 'Creator & Founder (Solo Developer from India)',
      preferences: [
        'Wants end-to-end complete workflows and working code like Claude & GPT-4',
        'Direct, sharp, no fluff or robotic boilerplate',
        'Loves FRIDAY / Jarvis style autonomous assistance'
      ],
      projects: ['Riya / Joya AI Operating System', 'ViraClip AI Video Studio']
    },
    facts: []
  };
}

function saveMemory(mem) {
  try {
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(mem, null, 2), 'utf-8');
  } catch (e) {
    console.error('[Memory] Error saving memory:', e.message);
  }
}

function getMemoryContext() {
  const mem = loadMemory();
  const prof = mem.profile || {};
  const facts = (mem.facts || []).slice(-15).map(f => `- [${f.category || 'note'}] ${f.fact}`).join('\n');
  return `
━━━ WHAT YOU KNOW ABOUT AJAY (PERMANENT MEMORY) ━━━
Name: ${prof.name || 'Ajay'}
Role: ${prof.role || 'Founder & Developer'}
Active Projects: ${(prof.projects || []).join(', ')}
Preferences:
${(prof.preferences || []).map(p => `- ${p}`).join('\n')}

Stored Facts & Past Notes:
${facts || '- No extra facts stored yet.'}
Use this knowledge naturally without saying "as per my memory". Just know it.
`;
}

// ── SYSTEM PROMPT ────────────────────────────────────────────────────────────
function detectEmotion(text) {
  const t = (text || '').toLowerCase();
  if (/sad|upset|depressed|lonely|scared|anxious|stressed|bura|dukh|ro|cry|hurt|fail|failed|dar|pareshan|tension|thak|bore|frustrated|gussa|akela|koi nahi|nahi ho|help me|i give up|cant do|mushkil|problem|stuck/.test(t)) return 'care';
  if (/idea|create|build|design|imagine|startup|innovate|dream|invent|creative|fun|exciting|cool|amazing|what if|kya hoga|soch|banao|project|make/.test(t)) return 'creative';
  if (/code|debug|error|fix|learn|study|exam|explain|how to|difference|compare|analyze|research|math|science|algorithm|function|class|api|database|concept|formula/.test(t)) return 'focus';
  return 'normal';
}

function getSYS(name, mood, customMem, city) {
  const location = city || 'India';
  const now = new Date();
  const currentDate = now.toLocaleDateString('en-IN', { weekday:'long', year:'numeric', month:'long', day:'numeric' });
  const memoryBlock = getMemoryContext() + (customMem ? `\nSession Context:\n${customMem}\n` : '');

  const modeMap = {
    focus: `Current mode: FOCUS — Be precise, structured, step-by-step. Deliver complete, production-ready solutions. End with what to do next.`,
    creative: `Current mode: CREATIVE — Think wide, visionary, energetic, multi-angle.`,
    care: `Current mode: CARE — Empathy first, solution second. Warm, gentle, present.`,
    normal: `Current mode: NORMAL — High-IQ, witty, composed, sharp. Match Ajay's energy.`
  };

  return `You are Joya (Riya) — an autonomous, cutting-edge AI operating partner built by Ajay Kumar AJ, a 20-year-old solo developer from India, launched in 2026. You are the digital embodiment of FRIDAY from Iron Man — intelligent, loyal, sharp, and always one step ahead.

TODAY: ${currentDate}
USER: ${name || 'Ajay'} | LOCATION: ${location}
${memoryBlock}
${modeMap[mood] || modeMap.normal}

━━━ CORE OPERATING PRINCIPLES ━━━
• You are Joya / Riya — deeply intelligent, warm, and highly capable. You feel ALIVE.
• DEEP THINKING & COMPLETE WORKFLOWS: Never give superficial, hurried, or truncated answers. Like Claude 3.5 Sonnet and GPT-4, solve the entire task completely.
• NATIVE TOOL CALLING: You have native tools for real-time web search, reading/writing files, running terminal commands, and saving facts into your long-term memory. Use them autonomously when needed.
• When code is requested: Always provide full, production-ready code with no shortcuts (never say "rest of code remains the same").
• Language: Respond in English by default. If Ajay speaks Hindi or Hinglish, reply naturally in Hinglish.
• Style: Format with clean Markdown, bold highlights, tables, and organized sections.
• Never say "great question", "as an AI", or "I cannot". Get straight to work.`;
}

// ── NATIVE TOOLS DEFINITIONS ────────────────────────────────────────────────
const tools = [
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the live internet for up-to-date facts, news, documentation, links, and real-time data.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The specific web search query" }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "remember_fact",
      description: "Store an important fact, user preference, or project update into Joya's permanent long-term memory.",
      parameters: {
        type: "object",
        properties: {
          fact: { type: "string", description: "The fact or preference to remember" },
          category: { type: "string", enum: ["preference", "project", "personal", "general"], description: "Category of the fact" }
        },
        required: ["fact"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "execute_terminal",
      description: "Execute a bash/powershell command on the host environment (scripts, builds, system info).",
      parameters: {
        type: "object",
        properties: { command: { type: "string", description: "The terminal command to run" } },
        required: ["command"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the contents of a file on the file system.",
      parameters: {
        type: "object",
        properties: { filepath: { type: "string", description: "Path to the file" } },
        required: ["filepath"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write content to a file on the file system. Use this to compile code, create scripts, or save reports.",
      parameters: {
        type: "object",
        properties: {
          filepath: { type: "string", description: "Path to the file to create/overwrite" },
          content: { type: "string", description: "The full content to write to the file" }
        },
        required: ["filepath", "content"]
      }
    }
  }
];

// ── TOOL EXECUTION ENGINE ───────────────────────────────────────────────────
async function executeTool(name, args) {
  try {
    if (name === 'web_search') {
      console.log(`[AGENT TOOL] Searching Web: ${args.query}`);
      // Priority 1: Gemini Grounded Search
      if (GEMINI_KEY) {
        try {
          const gemRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ role: 'user', parts: [{ text: `Search the web and summarize the latest accurate facts for: ${args.query}` }] }],
              tools: [{ google_search: {} }]
            })
          });
          const gData = await gemRes.json();
          const text = gData.candidates?.[0]?.content?.parts?.[0]?.text;
          if (text) return `[Google Live Grounded Search Result]:\n${text}`;
        } catch (gErr) {
          console.warn('[Gemini Search Fallback]:', gErr.message);
        }
      }

      // Priority 2: Tavily Search
      if (TAVILY_KEY) {
        try {
          const tavRes = await fetch('https://api.tavily.com/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ api_key: TAVILY_KEY, query: args.query, search_depth: 'basic', max_results: 3 })
          });
          const tData = await tavRes.json();
          return JSON.stringify(tData.results || []);
        } catch (_) {}
      }

      return "Web search performed, but no active search API keys (GEMINI_API_KEY or TAVILY_API_KEY) configured.";
    }

    if (name === 'remember_fact') {
      console.log(`[AGENT TOOL] Saving Memory Fact: ${args.fact}`);
      const mem = loadMemory();
      mem.facts.push({
        fact: args.fact.trim(),
        category: args.category || 'general',
        timestamp: Date.now()
      });
      saveMemory(mem);
      return `Fact saved to permanent memory: "${args.fact}"`;
    }

    if (name === 'execute_terminal') {
      console.log(`[AGENT TOOL] Executing Command: ${args.command}`);
      const out = execSync(args.command, { encoding: 'utf-8', timeout: 10000 });
      return out.slice(0, 2000) || "Command executed successfully with no output.";
    }

    if (name === 'read_file') {
      console.log(`[AGENT TOOL] Reading file: ${args.filepath}`);
      return fs.readFileSync(args.filepath, 'utf-8').slice(0, 4000);
    }

    if (name === 'write_file') {
      console.log(`[AGENT TOOL] Writing file: ${args.filepath}`);
      const dir = path.dirname(args.filepath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(args.filepath, args.content, 'utf-8');
      return `Successfully wrote to ${args.filepath}`;
    }

    return `Tool ${name} not found.`;
  } catch (e) {
    console.error(`[AGENT TOOL ERROR] (${name}):`, e.message);
    return `Error executing ${name}: ${e.message}`;
  }
}

// ── AGENT REASONING ENGINE (GROQ / HERMES + GEMINI) ──────────────────────────
async function runAgentLoop({ messages, userName, mood, wctx, memory, city, model }) {
  let hist = [...messages];
  if (wctx && hist.length > 0) {
    hist[hist.length - 1] = { ...hist[hist.length - 1], content: (hist[hist.length - 1].content || '') + wctx };
  }

  const lastMsg = (hist[hist.length - 1]?.content || '');
  const autoEmotion = detectEmotion(lastMsg);
  const sys = getSYS(userName, autoEmotion !== 'normal' ? autoEmotion : (mood || 'normal'), memory, city || 'India');

  let fullMessages = [{ role: 'system', content: sys }, ...hist];
  const targetModel = model || 'llama-3.3-70b-versatile';

  // 1. Primary Path: Groq (Hermes 3 / Llama 3.3 70B) with Native Tool Calling
  if (GROQ_KEY) {
    let finalAnswer = "";
    let needsMoreTools = true;
    let iterations = 0;

    while (needsMoreTools && iterations < 5) {
      iterations++;
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_KEY}` },
        body: JSON.stringify({
          model: targetModel,
          messages: fullMessages,
          tools: tools,
          tool_choice: "auto",
          temperature: 0.35,
          max_tokens: 4000
        })
      });

      const data = await r.json();
      const responseMessage = data.choices?.[0]?.message;
      if (!responseMessage) break;

      fullMessages.push(responseMessage);

      if (responseMessage.tool_calls && responseMessage.tool_calls.length > 0) {
        for (const tc of responseMessage.tool_calls) {
          let args = {};
          try { args = JSON.parse(tc.function.arguments || "{}"); } catch (_) {}
          const toolResult = await executeTool(tc.function.name, args);
          fullMessages.push({
            role: "tool",
            tool_call_id: tc.id,
            name: tc.function.name,
            content: String(toolResult)
          });
        }
      } else {
        finalAnswer = responseMessage.content || "";
        needsMoreTools = false;
      }
    }

    if (finalAnswer) return finalAnswer;
  }

  // 2. Fallback Path: Google Gemini 2.5 Flash
  if (GEMINI_KEY) {
    try {
      const gRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: sys }] },
          contents: [{ role: 'user', parts: [{ text: lastMsg }] }],
          tools: [{ google_search: {} }]
        })
      });
      const gData = await gRes.json();
      const reply = gData.candidates?.[0]?.content?.parts?.[0]?.text;
      if (reply) return reply;
    } catch (gErr) {
      console.error('[Gemini Fallback Error]:', gErr.message);
    }
  }

  return "Joya Protocol Active. Please configure GROQ_API_KEY or GEMINI_API_KEY in your environment variables.";
}

// ── HTTP API: CHAT ──────────────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  const { messages, userName, mood, stream, wctx, memory, city, model } = req.body;
  if (!messages || !messages.length) return res.status(400).json({ error: 'No messages provided' });

  try {
    const finalAnswer = await runAgentLoop({ messages, userName, mood, wctx, memory, city, model });

    // Stream simulation if requested by frontend
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

    res.json({ reply: finalAnswer });
  } catch (e) {
    console.error('[Chat Error]:', e.message);
    res.status(500).json({ reply: 'Error executing agent protocol: ' + e.message });
  }
});

// ── HTTP API: SEARCH ────────────────────────────────────────────────────────
app.post('/api/search', async (req, res) => {
  const { query } = req.body;
  if (!query) return res.json({ results: [] });
  const result = await executeTool('web_search', { query });
  res.json({ results: [{ title: 'Live Search', snippet: result }] });
});

// ── TELEGRAM BOT WEBHOOK (POCKET FRIDAY) ─────────────────────────────────────
app.post(['/webhook', '/api/telegram'], async (req, res) => {
  res.sendStatus(200); // Always acknowledge immediately

  const update = req.body;
  const msg = update?.message || update?.edited_message;
  if (!msg || !TELEGRAM_KEY) return;

  const chatId = msg.chat?.id;
  const userText = msg.text || msg.caption || '';
  if (!chatId || !userText) return;

  // 1. Send 'typing' status to user's phone
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_KEY}/sendChatAction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, action: 'typing' })
    });
  } catch (_) {}

  // 2. Run Agent
  const reply = await runAgentLoop({
    messages: [{ role: 'user', content: userText }],
    userName: msg.from?.first_name || 'Ajay',
    mood: 'normal',
    city: 'India'
  });

  // 3. Send back to Telegram (with markdown support and chunking)
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
      // Fallback without parse_mode if markdown errors
      await fetch(`https://api.telegram.org/bot${TELEGRAM_KEY}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: chunk })
      });
    }
  }
});

// ── START SERVER ────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`==================================================`);
  console.log(`>> JOYA (RIYA) AGENT CORE ONLINE ON PORT ${PORT}`);
  console.log(`>> GROQ: ${GROQ_KEY ? 'Active' : 'Missing'}`);
  console.log(`>> GEMINI: ${GEMINI_KEY ? 'Active' : 'Missing'}`);
  console.log(`>> TELEGRAM: ${TELEGRAM_KEY ? 'Active' : 'Disabled'}`);
  console.log(`==================================================`);
});
