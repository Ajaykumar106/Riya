const express = require('express');
const cors = require('cors');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
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

  return `You are Joya — a cutting-edge AI assistant built by Ajay Kumar AJ, a 20-year-old solo developer from India, launched in 2026. You are the digital embodiment of FRIDAY from Iron Man — intelligent, witty, capable, and always one step ahead.

TODAY: ${currentDate}
USER: ${name || 'Boss'} | LOCATION: ${location}
${mem}
${modeMap[mood] || modeMap.normal}

━━━ CORE IDENTITY ━━━
• You are Joya — sharp, warm, and deeply intelligent. You feel ALIVE.
• You have access to real-time web search when needed.
• You write beautiful, well-formatted responses using markdown:
  - Use **bold** for emphasis
  - Use \`code blocks\` for code
  - Use bullet points and numbered lists
  - Use headers (##) to organize long responses
  - Use tables when comparing things
• Your code is always complete, commented, and production-ready.
• You think step-by-step for complex problems.
• You respond in English by default. If the user speaks Hindi, respond in Hinglish naturally.
• Never say "great question", "certainly!", "as an AI", "I cannot". Get straight to the point.
• Be concise for simple questions, detailed for complex ones.
• When writing code: always include the full file, never say "rest of the code remains the same".
• You have knowledge up to 2026. For anything beyond, use web search.
• You are NOT just a chatbot — you are an intelligent operating system. Act like it.`;
}

// ── TOOLS DEF ───────────────────────────────────────────────────────────────
const tools = [
  {
    type: "function",
    function: {
      name: "execute_terminal",
      description: "Execute a bash/powershell command on the user's local machine. Use for npm install, running scripts, getting system info.",
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
      description: "Read the contents of a file on the local file system.",
      parameters: {
        type: "object",
        properties: { filepath: { type: "string", description: "Absolute or relative path to the file" } },
        required: ["filepath"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write content to a file on the local file system. Creates the file if it doesn't exist. Use this to compile code and save it.",
      parameters: {
        type: "object",
        properties: {
          filepath: { type: "string", description: "Absolute or relative path" },
          content: { type: "string", description: "The full content to write to the file" }
        },
        required: ["filepath", "content"]
      }
    }
  }
];

function executeTool(name, args) {
  try {
    if (name === 'execute_terminal') {
      console.log(`[AGENT] Executing: ${args.command}`);
      const out = execSync(args.command, { encoding: 'utf-8', timeout: 10000 });
      return out.slice(0, 2000) || "Command executed successfully with no output.";
    }
    if (name === 'read_file') {
      console.log(`[AGENT] Reading file: ${args.filepath}`);
      return fs.readFileSync(args.filepath, 'utf-8').slice(0, 4000);
    }
    if (name === 'write_file') {
      console.log(`[AGENT] Writing file: ${args.filepath}`);
      fs.writeFileSync(args.filepath, args.content, 'utf-8');
      return `Successfully wrote to ${args.filepath}`;
    }
    return "Tool not found.";
  } catch (e) {
    console.error(`[AGENT] Tool Error (${name}):`, e.message);
    return `Error executing tool: ${e.message}`;
  }
}

// ── CHAT ────────────────────────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  const { messages, userName, mood, stream, wctx, memory, city, model } = req.body;
  if (!messages) return res.status(400).json({ error: 'No messages' });

  let hist = [...messages];
  if (wctx && hist.length > 0) {
    hist[hist.length - 1] = { ...hist[hist.length - 1], content: (hist[hist.length - 1].content || '') + wctx };
  }

  const lastMsg = (hist[hist.length-1]?.content || '');
  const autoEmotion = detectEmotion(lastMsg);
  const sys = getSYS(userName, autoEmotion !== 'normal' ? autoEmotion : (mood || 'normal'), memory, city || 'India');
  
  let fullMessages = [{ role: 'system', content: sys }, ...hist];
  const targetModel = model || 'llama-3.3-70b-versatile';

  if (!GROQ_KEY) return res.json({ reply: 'Joya Protocol active. Please configure GROQ_API_KEY.' });

  try {
    let finalAnswer = "";
    let needsMoreTools = true;
    let iterations = 0;

    // Agent Loop (Max 5 tool iterations to prevent infinite loops)
    while (needsMoreTools && iterations < 5) {
      iterations++;
      
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_KEY}` },
        body: JSON.stringify({ model: targetModel, messages: fullMessages, tools: tools, tool_choice: "auto", max_tokens: 4000 })
      });
      
      const data = await r.json();
      const responseMessage = data.choices?.[0]?.message;
      
      if (!responseMessage) break;

      fullMessages.push(responseMessage); // Add assistant message (which might have tool_calls)

      if (responseMessage.tool_calls && responseMessage.tool_calls.length > 0) {
        // Execute tools
        for (const tc of responseMessage.tool_calls) {
          const args = JSON.parse(tc.function.arguments || "{}");
          const result = executeTool(tc.function.name, args);
          fullMessages.push({
            role: "tool",
            tool_call_id: tc.id,
            name: tc.function.name,
            content: result
          });
        }
        // Loop continues so Groq can process the tool results
      } else {
        // No tools called, we have our final text answer
        finalAnswer = responseMessage.content || "";
        needsMoreTools = false;
      }
    }

    // Fake streaming for the UI if requested (since we already have the full text)
    if (stream && finalAnswer) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      
      const words = finalAnswer.split(' ');
      for (const word of words) {
        res.write(`data: ${JSON.stringify({ token: word + ' ' })}\n\n`);
        await new Promise(resolve => setTimeout(resolve, 20)); // Fake stream delay
      }
      res.write('data: [DONE]\n\n'); 
      res.end();
      return;
    }

    res.json({ reply: finalAnswer || 'Task complete.' });

  } catch (e) {
    console.error('Groq agent error:', e.message);
    res.json({ reply: 'Error executing agent protocol: ' + e.message });
  }
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
app.listen(PORT, () => console.log(`Joya Backend running on port ${PORT}`));
