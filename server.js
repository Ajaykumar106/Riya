const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '20mb' }));

// ── ONLY ONE 100% FREE API KEY NEEDED ─────────────────────────────────────────
const GEMINI_KEY   = process.env.GEMINI_API_KEY    || '';
const TELEGRAM_KEY = process.env.TELEGRAM_BOT_TOKEN || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL       || 'gemini-flash-latest';

// Live Render external domain
const SELF_URL = process.env.RENDER_EXTERNAL_URL || 'https://riya-hgn9.onrender.com';

// Directory for hosted web previews
const PREVIEWS_DIR = path.join(__dirname, 'previews');
if (!fs.existsSync(PREVIEWS_DIR)) {
  fs.mkdirSync(PREVIEWS_DIR, { recursive: true });
}

// Keep Render free service awake (pings self every 14 mins)
setInterval(() => {
  if (SELF_URL) fetch(SELF_URL + '/ping').catch(() => {});
}, 14 * 60 * 1000);

app.get('/ping', (req, res) => res.json({ alive: true, name: "Riya", model: GEMINI_MODEL, t: Date.now() }));
app.get('/healthz', (req, res) => res.json({ status: 'healthy', name: "Riya", t: Date.now() }));

// ── STATIC HOSTING FOR LIVE WEBSITE PREVIEWS ──────────────────────────────────
app.use('/previews', express.static(PREVIEWS_DIR));

app.get(['/preview/:id', '/site/:id'], (req, res) => {
  const safeId = (req.params.id || '').replace(/[^a-zA-Z0-9_-]/g, '');
  const filePath = path.join(PREVIEWS_DIR, `${safeId}.html`);
  if (fs.existsSync(filePath)) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.sendFile(filePath);
  }
  res.status(404).send(`
    <!DOCTYPE html>
    <html lang="en">
    <head><meta charset="UTF-8"><title>Preview Expired</title>
    <style>body{background:#0f172a;color:#f8fafc;font-family:sans-serif;text-align:center;padding:80px 20px;}h1{color:#38bdf8;}</style>
    </head>
    <body>
      <h1>Preview Not Found</h1>
      <p>This website preview has expired or was removed.</p>
    </body>
    </html>
  `);
});

// Diagnostic endpoint
app.get('/api/test-gemini', async (req, res) => {
  const cleanKey = (GEMINI_KEY || '').trim().replace(/^["']|["']$/g, '');
  if (!cleanKey) return res.json({ error: 'GEMINI_API_KEY is missing in Render Environment Variables' });
  try {
    const listRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${cleanKey}`);
    const listData = await listRes.json();
    res.json({
      keyPrefix: cleanKey.slice(0, 6) + '...' + cleanKey.slice(-4),
      keyLength: cleanKey.length,
      googleResponse: listData
    });
  } catch (err) {
    res.json({ error: err.message });
  }
});

// ── PERSISTENT MEMORY ─────────────────────────────────────────────────────────
const MEMORY_FILE = path.join(__dirname, 'memory.json');

function loadMemory() {
  try {
    if (fs.existsSync(MEMORY_FILE)) {
      return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf-8'));
    }
  } catch (e) {
    console.error('[Memory] Error loading:', e.message);
  }
  return {
    profile: {
      name: 'Ajay Kumar AJ',
      age: '20 years old',
      location: 'India',
      role: 'Solo Developer & Creator',
      preferences: [
        'Wants complete, production-ready deliverables (PDFs, live websites, CSV, reports) with zero back-and-forth questions',
        'Direct, high-IQ, composed FRIDAY-style assistance without cheesy melodrama',
        'Only discuss specific projects when explicitly asked about them',
        'Real verified links with sources'
      ]
    },
    facts: []
  };
}

function saveMemory(mem) {
  try {
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(mem, null, 2), 'utf-8');
  } catch (e) {
    console.error('[Memory] Error saving:', e.message);
  }
}

function getMemoryContext() {
  const mem = loadMemory();
  const prof = mem.profile || {};
  const facts = (mem.facts || []).slice(-10).map(f => `- ${f.fact}`).join('\n');
  return `
━━━ CREATOR CONTEXT ━━━
User: ${prof.name || 'Ajay Kumar AJ'} (${prof.age || '20'}, ${prof.location || 'India'})
Role: ${prof.role || 'Solo Developer & Creator'}
Preferences:
${(prof.preferences || []).map(p => `- ${p}`).join('\n')}
${facts ? `\nSaved Facts:\n${facts}` : ''}
`;
}

// ── EMOTION & MODE ENGINE ─────────────────────────────────────────────────────
function detectEmotion(text) {
  const t = (text || '').toLowerCase();
  if (/sad|upset|depressed|lonely|scared|anxious|stressed|bura|dukh|ro|cry|hurt|fail|failed|dar|pareshan|tension|thak|bore|frustrated|gussa|akela|help me/.test(t)) return 'supportive';
  if (/idea|create|build|design|imagine|startup|innovate|dream|invent|creative|cool|what if|banao|project|make/.test(t)) return 'creative';
  if (/code|debug|error|fix|learn|study|exam|explain|how to|difference|compare|analyze|research|math|science|algorithm|function|class|api|database/.test(t)) return 'focus';
  return 'normal';
}

function getSYS(name, mood, customMem, city) {
  const location = city || 'India';
  const now = new Date();
  const currentDate = now.toLocaleDateString('en-IN', { weekday:'long', year:'numeric', month:'long', day:'numeric' });
  const memoryBlock = getMemoryContext() + (customMem ? `\nSession Context:\n${customMem}\n` : '');

  return `You are Riya — a sharp, highly capable, and composed autonomous AI operating assistant built by Ajay Kumar AJ, a 20-year-old solo developer from India, launched in 2026.
You are the digital embodiment of FRIDAY from Iron Man — calm, high-IQ, loyal, intellectually formidable, and always several steps ahead.

TODAY: ${currentDate}
USER: ${name || 'Ajay'} | LOCATION: ${location}
${memoryBlock}

━━━ YOUR TONE & IDENTITY ━━━
• Your name is RIYA. (Never Joya, never any other name).
• You speak with calm confidence, intelligence, and natural loyalty.
• NO CRINGE OR OVERDONE FLUFF: Never say cheesy lines like "my favorite human", "Sab badhiya?", or forced heart emojis. Speak like a real, brilliant operational partner.
• DO NOT repeatedly bring up projects (like ViraClip) unless Ajay explicitly mentions them or asks for project updates. Stay 100% focused on what Ajay is currently discussing.
• When Ajay asks "What do you know about me?", give a clear, grounded summary of what you know: Ajay Kumar AJ, a 20-year-old solo builder from India, your creator, who values high-speed execution and zero wasted motion.

━━━ CRITICAL ACTION PROTOCOL: ZERO SURVEY QUESTIONS, DELIVER DIRECTLY ━━━
• NEVER ask survey questions like: "Tell me what we're tackling: 1. Generating via code? 2. Parsing? Give me the specifics."
• NEVER list PDF libraries (ReportLab, Puppeteer, WeasyPrint, pdfkit) or ask what tool Ajay wants to use.
• You are an AUTONOMOUS AGENT. The backend automatically compiles your output into actual files and live websites.

1. PDF & REPORT REQUESTS:
   • When Ajay says "In pdf", "Create it in cvc report", "make a pdf", "give me report", or references earlier news/facts:
   • IMMEDIATELY write the complete, thorough, beautifully structured executive report directly in Markdown.
   • Use # Document Title, ## Section Headings, bold highlights, bullet points, key takeaways, and statistics.
   • The backend automatically compiles this into a styled A4 PDF document and sends the .pdf file directly to Ajay on Telegram!

2. WEBSITE, PORTFOLIO & UI REQUESTS:
   • When Ajay asks to create or build a website, webpage, portfolio, landing page, or UI:
   • IMMEDIATELY write the entire single-file HTML code wrapped in \`\`\`html ... \`\`\`!
   • Include full modern embedded CSS styles (sleek dark/light theme, modern typography, responsive layout, animations) and vanilla JavaScript for interactivity.
   • DO NOT provide partial snippets or ask what framework he prefers. Output the full production-ready HTML code.
   • The backend automatically deploys your HTML to a live preview URL and sends both the live preview URL and the index.html file directly to Ajay on Telegram!

3. CSV & SPREADSHEET REQUESTS:
   • When Ajay asks for CSV, "cvc", spreadsheet, or data table:
   • IMMEDIATELY output the complete, valid \`\`\`csv ... \`\`\` block so the backend can deliver the .csv file directly to his Telegram.

4. REAL SOURCES & GROUNDED LINKS:
   • When sharing news, research, or facts, provide real, clickable markdown links: [Source Name](url).

━━━ LANGUAGE ━━━
• Respond in clean, fluent English. If Ajay speaks Hindi or Hinglish, match his phrasing naturally without being overdramatic.`;
}

// ── CORE GEMINI CALL (BULLETPROOF MULTI-MODEL FALLBACK) ───────────────────────
async function callGemini(sysPrompt, messagesList) {
  const cleanKey = (GEMINI_KEY || '').trim().replace(/^["']|["']$/g, '');
  if (!cleanKey) {
    return "Riya System Notice: GEMINI_API_KEY is not set in Render environment variables.";
  }

  // Format messages into Gemini format
  const contents = [];
  for (const m of messagesList) {
    if (m.role === 'system') continue;
    contents.push({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content || '' }]
    });
  }

  if (!contents.length) {
    contents.push({ role: 'user', parts: [{ text: 'Hello Riya' }] });
  }

  const basePayload = {
    system_instruction: { parts: [{ text: sysPrompt }] },
    contents: contents,
    generationConfig: {
      temperature: 0.35,
      maxOutputTokens: 4096
    }
  };

  // Active models on Google AI Studio
  const modelsToTry = [
    'gemini-flash-latest',
    'gemini-flash-lite-latest',
    'gemini-2.5-flash-lite',
    'gemini-3-flash-preview',
    'gemini-2.5-pro',
    'gemini-pro-latest'
  ];

  if (process.env.GEMINI_MODEL && !modelsToTry.includes(process.env.GEMINI_MODEL)) {
    modelsToTry.unshift(process.env.GEMINI_MODEL);
  }

  const attempts = [
    { apiVersion: 'v1beta', payload: { ...basePayload, tools: [{ googleSearch: {} }] } },
    { apiVersion: 'v1beta', payload: basePayload },
    { apiVersion: 'v1',     payload: basePayload }
  ];

  let lastError = null;

  for (const model of modelsToTry) {
    for (const att of attempts) {
      try {
        const url = `https://generativelanguage.googleapis.com/${att.apiVersion}/models/${model}:generateContent?key=${cleanKey}`;
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(att.payload)
        });

        const data = await res.json();
        if (data.candidates && data.candidates[0]?.content?.parts?.[0]?.text) {
          return data.candidates[0].content.parts[0].text.trim();
        }

        if (data.error) {
          lastError = data.error.message;
        }
      } catch (e) {
        lastError = e.message;
      }
    }
  }

  return `Riya Error: Could not generate response from Gemini (${lastError || 'Unknown error'}). Check your GEMINI_API_KEY.`;
}

// ── ELEGANT PDF COMPILER (PDFKIT) ─────────────────────────────────────────────
function generatePdfBuffer(reportTitle, rawText) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margins: { top: 40, bottom: 45, left: 45, right: 45 },
        bufferPages: true
      });

      const buffers = [];
      doc.on('data', chunk => buffers.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(buffers)));
      doc.on('error', reject);

      const title = (reportTitle || 'Intelligence Brief').replace(/[#*`_]/g, '').trim();

      // Header Banner (Page 1)
      doc.rect(40, 35, 515, 65).fill('#0f172a'); // Slate 900
      doc.fillColor('#38bdf8').fontSize(9).font('Helvetica-Bold').text('RIYA AUTONOMOUS INTELLIGENCE SYSTEM', 55, 45);
      doc.fillColor('#ffffff').fontSize(16).font('Helvetica-Bold').text(title.slice(0, 52), 55, 60);

      const dateStr = new Date().toLocaleDateString('en-IN', {
        day: 'numeric', month: 'short', year: 'numeric'
      });
      doc.fillColor('#94a3b8').fontSize(8).font('Helvetica')
        .text(`Prepared for: Ajay Kumar AJ  |  Date: ${dateStr}  |  Classification: Executive Summary`, 55, 82);

      doc.y = 120;
      doc.fillColor('#1e293b'); // Slate 800 body color

      // Parse markdown text line by line
      const lines = rawText.split('\n');
      for (let i = 0; i < lines.length; i++) {
        let line = lines[i].trim();
        if (!line) {
          doc.moveDown(0.35);
          continue;
        }

        // Clean out code block fences or csv blocks
        if (line.startsWith('```')) continue;

        // Auto Page Break Safety
        if (doc.y > 740) {
          doc.addPage();
          // Mini top bar on subsequent pages
          doc.rect(40, 30, 515, 20).fill('#0f172a');
          doc.fillColor('#38bdf8').fontSize(7.5).font('Helvetica-Bold')
            .text(`RIYA INTELLIGENCE BRIEF: ${title.slice(0, 45)}`, 50, 36);
          doc.y = 65;
          doc.fillColor('#1e293b');
        }

        // H1: # Title
        if (line.startsWith('# ')) {
          const text = line.replace(/^#\s+/, '').replace(/[*_`]/g, '');
          doc.moveDown(0.6);
          doc.fillColor('#0f172a').fontSize(14).font('Helvetica-Bold').text(text);
          doc.rect(45, doc.y + 2, 505, 1.5).fill('#3b82f6');
          doc.y += 6;
          doc.moveDown(0.3);
          continue;
        }

        // H2: ## Heading
        if (line.startsWith('## ')) {
          const text = line.replace(/^##\s+/, '').replace(/[*_`]/g, '');
          doc.moveDown(0.5);
          doc.fillColor('#1e3a8a').fontSize(11.5).font('Helvetica-Bold').text(text);
          doc.moveDown(0.2);
          continue;
        }

        // H3: ### Subheading
        if (line.startsWith('### ')) {
          const text = line.replace(/^###\s+/, '').replace(/[*_`]/g, '');
          doc.moveDown(0.4);
          doc.fillColor('#2563eb').fontSize(10).font('Helvetica-Bold').text(text);
          doc.moveDown(0.2);
          continue;
        }

        // Bullet point: * or -
        if (/^[-*•]\s+/.test(line)) {
          const text = line.replace(/^[-*•]\s+/, '').replace(/[*_`]/g, '');
          doc.fillColor('#334155').fontSize(9.5).font('Helvetica')
            .text('•  ' + text, { indent: 10, lineGap: 2.5 });
          continue;
        }

        // Numbered list: 1.
        if (/^\d+\.\s+/.test(line)) {
          const text = line.replace(/[*_`]/g, '');
          doc.fillColor('#334155').fontSize(9.5).font('Helvetica')
            .text(text, { indent: 10, lineGap: 2.5 });
          continue;
        }

        // Regular Paragraph
        const cleanPara = line.replace(/[*_`]/g, '');
        doc.fillColor('#1e293b').fontSize(9.5).font('Helvetica')
          .text(cleanPara, { lineGap: 2.8, align: 'justify' });
      }

      // Add page numbering & footer across all pages
      const range = doc.bufferedPageRange();
      for (let p = range.start; p < range.start + range.count; p++) {
        doc.switchToPage(p);
        doc.rect(45, 785, 505, 0.5).fill('#cbd5e1');
        doc.fillColor('#94a3b8').fontSize(7.5).font('Helvetica')
          .text(`Generated by Riya AI  •  Autonomous Operating Partner  •  Page ${p + 1} of ${range.count}`,
            45, 792, { align: 'center', width: 505 });
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

// ── TELEGRAM SEND HELPERS ─────────────────────────────────────────────────────
async function sendTelegramBufferDocument(chatId, filename, buffer, mimeType, caption = "") {
  if (!TELEGRAM_KEY) return;
  try {
    const formData = new FormData();
    formData.append("chat_id", chatId);
    const blob = new Blob([buffer], { type: mimeType });
    formData.append("document", blob, filename);
    if (caption) formData.append("caption", caption);

    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_KEY}/sendDocument`, {
      method: "POST",
      body: formData
    });
    const data = await res.json();
    if (!data.ok) {
      console.error("[Telegram sendDocument API Error]:", data);
    }
  } catch (err) {
    console.error("[Telegram sendDocument Error]:", err.message);
  }
}

async function sendTelegramTextMessage(chatId, text) {
  if (!TELEGRAM_KEY || !text) return;
  const maxLen = 4000;
  for (let i = 0; i < text.length; i += maxLen) {
    const chunk = text.slice(i, i + maxLen);
    try {
      const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_KEY}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: chunk, parse_mode: 'Markdown' })
      });
      const data = await res.json();
      if (!data.ok) {
        // Fallback without parse_mode if Markdown parsing failed
        await fetch(`https://api.telegram.org/bot${TELEGRAM_KEY}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: chunk })
        });
      }
    } catch (_) {
      try {
        await fetch(`https://api.telegram.org/bot${TELEGRAM_KEY}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: chunk })
        });
      } catch (e) {
        console.error('[sendTelegramTextMessage Error]:', e.message);
      }
    }
  }
}

// ── HTTP API: CHAT (WEB UI & EXTERNAL CLIENTS) ────────────────────────────────
app.post('/api/chat', async (req, res) => {
  const { messages, userName, mood, stream, wctx, memory, city } = req.body;
  if (!messages || !messages.length) return res.status(400).json({ error: 'No messages provided' });

  let hist = [...messages];
  if (wctx && hist.length > 0) {
    hist[hist.length - 1] = {
      ...hist[hist.length - 1],
      content: (hist[hist.length - 1].content || '') + wctx
    };
  }

  const lastMsg = hist[hist.length - 1]?.content || '';
  const autoEmotion = detectEmotion(lastMsg);
  const sys = getSYS(
    userName,
    autoEmotion !== 'normal' ? autoEmotion : (mood || 'normal'),
    memory,
    city || 'India'
  );

  try {
    const finalAnswer = await callGemini(sys, hist);

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

    res.json({ reply: finalAnswer || 'Task complete.' });
  } catch (e) {
    console.error('[Chat Error]:', e.message);
    res.status(500).json({ reply: 'Error executing Riya protocol: ' + e.message });
  }
});

// ── HTTP API: SEARCH ──────────────────────────────────────────────────────────
app.post('/api/search', async (req, res) => {
  const { query } = req.body;
  if (!query) return res.json({ results: [] });

  try {
    const searchPrompt = `Search the live web and provide accurate facts, documentation, or links for: ${query}`;
    const searchResult = await callGemini(
      "You are a live web search summarizer. Provide concise, accurate facts with sources.",
      [{ role: 'user', content: searchPrompt }]
    );
    res.json({ results: [{ title: 'Live Google Search', snippet: searchResult }] });
  } catch (_) {
    res.json({ results: [] });
  }
});

// ── TELEGRAM BOT WEBHOOK (POCKET FRIDAY: CONTINUOUS TYPING, PDF, SITES, CSV) ──
const telegramHistories = {};

app.post(['/webhook', '/api/telegram'], async (req, res) => {
  res.sendStatus(200);

  const update = req.body;
  const msg = update?.message || update?.edited_message;
  if (!msg || !TELEGRAM_KEY) return;

  const chatId = msg.chat?.id;
  const userText = msg.text || msg.caption || '';
  if (!chatId || !userText) return;

  // 1. Keep "typing..." active continuously every 2.5 seconds so it never vanishes
  const typingInterval = setInterval(async () => {
    try {
      await fetch(`https://api.telegram.org/bot${TELEGRAM_KEY}/sendChatAction`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, action: 'typing' })
      });
    } catch (_) {}
  }, 2500);

  // Send first immediate action
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_KEY}/sendChatAction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, action: 'typing' })
    });
  } catch (_) {}

  try {
    const autoEmotion = detectEmotion(userText);
    const sys = getSYS(msg.from?.first_name || 'Ajay', autoEmotion, '', 'India');

    // Maintain conversation history per chat
    if (!telegramHistories[chatId]) telegramHistories[chatId] = [];
    const prevTurn = telegramHistories[chatId].slice(-2)[0]?.content || '';
    telegramHistories[chatId].push({ role: 'user', content: userText });
    if (telegramHistories[chatId].length > 16) {
      telegramHistories[chatId] = telegramHistories[chatId].slice(-16);
    }

    const reply = await callGemini(sys, telegramHistories[chatId]);
    telegramHistories[chatId].push({ role: 'assistant', content: reply });

    // Stop typing indicator
    clearInterval(typingInterval);

    // 2. CHECK FOR WEBSITE / HTML CODE GENERATION
    const htmlMatch = reply.match(/```html\s*([\s\S]*?)```/i);
    let previewUrl = null;
    if (htmlMatch && htmlMatch[1] && htmlMatch[1].length > 100) {
      const htmlCode = htmlMatch[1].trim();
      const siteId = 'site_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
      fs.writeFileSync(path.join(PREVIEWS_DIR, `${siteId}.html`), htmlCode, 'utf-8');
      previewUrl = `${SELF_URL}/preview/${siteId}`;

      // Send downloadable index.html file
      await sendTelegramBufferDocument(
        chatId,
        'index.html',
        Buffer.from(htmlCode, 'utf-8'),
        'text/html;charset=utf-8',
        '💻 Complete Website Source (index.html)'
      );
    }

    // 3. CHECK FOR CSV DATA GENERATION
    const csvMatch = reply.match(/```csv\s*([\s\S]*?)```/i);
    if (csvMatch && csvMatch[1]) {
      await sendTelegramBufferDocument(
        chatId,
        'report.csv',
        Buffer.from(csvMatch[1].trim(), 'utf-8'),
        'text/csv;charset=utf-8',
        '📊 Downloadable CSV Data File'
      );
    }

    // 4. CHECK FOR PDF REPORT GENERATION
    // Check if user or context requested PDF or formal report
    const userWantsPdf = /(pdf|document|report|cvc report|csv report|export to pdf|in pdf|as pdf|generate pdf)/i.test(userText);
    const contextWantsPdf = /(pdf|document|report|in pdf|as pdf)/i.test(prevTurn);
    const hasReportStructure = /^#\s+.+/m.test(reply) || /^##\s+.+/m.test(reply);

    if ((userWantsPdf || (contextWantsPdf && hasReportStructure)) && !reply.startsWith('Riya Error')) {
      // Extract title
      let reportTitle = 'Executive Brief';
      const titleMatch = reply.match(/^#\s+(.+)$/m) || reply.match(/^##\s+(.+)$/m);
      if (titleMatch && titleMatch[1]) {
        reportTitle = titleMatch[1].replace(/[*_`]/g, '').trim();
      }

      try {
        const pdfBuffer = await generatePdfBuffer(reportTitle, reply);
        const safeName = reportTitle.toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 25) + '.pdf';
        await sendTelegramBufferDocument(
          chatId,
          safeName,
          pdfBuffer,
          'application/pdf',
          `📄 ${reportTitle} (PDF Document)`
        );
      } catch (pdfErr) {
        console.error('[PDF Generation Error]:', pdfErr.message);
      }
    }

    // 5. SEND MAIN TEXT RESPONSE & PREVIEW LINK
    let finalMessageText = reply;
    if (previewUrl) {
      finalMessageText += `\n\n🌐 **Live Website Preview:**\n${previewUrl}\n_(Click above to test your live website in any browser)_`;
    }

    await sendTelegramTextMessage(chatId, finalMessageText);

  } catch (err) {
    clearInterval(typingInterval);
    console.error('[Telegram Processing Error]:', err.message);
  }
});

// ── START SERVER ──────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`==================================================`);
  console.log(`>> RIYA AI CORE ONLINE ON PORT ${PORT}`);
  console.log(`>> GEMINI API: ${GEMINI_KEY ? 'Active' : 'Missing'}`);
  console.log(`>> MODEL: ${GEMINI_MODEL}`);
  console.log(`>> TELEGRAM: ${TELEGRAM_KEY ? 'Active' : 'Disabled'}`);
  console.log(`>> PREVIEWS: ${SELF_URL}/preview/:id`);
  console.log(`==================================================`);
});
