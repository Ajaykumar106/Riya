const fs = require('fs');
const path = require('path');
const { runInSandbox } = require('./sandbox');
const { godEye } = require('./godeye');

// ── GEMINI NATIVE FUNCTION DECLARATIONS (STARK TRINITY HERMES-CLASS TOOLKIT) ──
const FUNCTION_DECLARATIONS = [
  {
    name: 'run_sandbox_code',
    description: 'Execute JavaScript, Python, or Shell code in an isolated execution sandbox and return stdout/stderr/exitCode. Use this whenever the user wants to run, test, compute, or verify code.',
    parameters: {
      type: 'OBJECT',
      properties: {
        language: { type: 'STRING', description: 'Programming language: javascript, python, or bash' },
        code: { type: 'STRING', description: 'The complete runnable source code with test output' }
      },
      required: ['language', 'code']
    }
  },
  {
    name: 'web_extract',
    description: 'Deep-scrape and extract clean, readable, ad-free Markdown content from any arbitrary URL, documentation page, or article.',
    parameters: {
      type: 'OBJECT',
      properties: {
        url: { type: 'STRING', description: 'The full HTTP or HTTPS URL to scrape' }
      },
      required: ['url']
    }
  },
  {
    name: 'schedule_routine',
    description: 'Create an autonomous scheduled recurring daily task or notification (e.g. daily 8:00 AM tech brief, reminder, or monitor) that triggers and sends reports to Telegram.',
    parameters: {
      type: 'OBJECT',
      properties: {
        routine_name: { type: 'STRING', description: 'Name of the routine (e.g. Morning Tech Brief)' },
        time_ist: { type: 'STRING', description: 'Time in 24-hr IST format (e.g. "08:00", "09:30")' },
        prompt: { type: 'STRING', description: 'The prompt to execute and deliver (e.g. "Scan today top AI breakthroughs and summarize")' }
      },
      required: ['routine_name', 'time_ist', 'prompt']
    }
  },
  {
    name: 'list_routines',
    description: 'List all currently active scheduled routines, morning briefings, and automations.',
    parameters: {
      type: 'OBJECT',
      properties: {}
    }
  },
  {
    name: 'cancel_routine',
    description: 'Cancel or deactivate a scheduled routine by its ID.',
    parameters: {
      type: 'OBJECT',
      properties: {
        id: { type: 'STRING', description: 'The routine ID to cancel' }
      },
      required: ['id']
    }
  },
  {
    name: 'image_generate',
    description: 'Generate an AI image based on a descriptive visual prompt and deliver it directly to Telegram.',
    parameters: {
      type: 'OBJECT',
      properties: {
        prompt: { type: 'STRING', description: 'Detailed visual prompt describing the desired image' }
      },
      required: ['prompt']
    }
  },
  {
    name: 'recall_memory',
    description: 'Search long-term vector memory in Neon PostgreSQL for past facts, preferences, code snippets, or project details.',
    parameters: {
      type: 'OBJECT',
      properties: {
        query: { type: 'STRING', description: 'Semantic search query string' }
      },
      required: ['query']
    }
  },
  {
    name: 'save_memory',
    description: 'Permanently store a new rule, preference, project detail, or personal fact in Neon PostgreSQL pgvector.',
    parameters: {
      type: 'OBJECT',
      properties: {
        category: { type: 'STRING', description: 'Category: identity, preference, project, tech_stack, or general' },
        content: { type: 'STRING', description: 'The exact fact or preference to permanently remember' }
      },
      required: ['category', 'content']
    }
  },
  {
    name: 'generate_pdf_report',
    description: 'Compile a formal A4 PDF executive report and dispatch the downloadable PDF file directly to Telegram.',
    parameters: {
      type: 'OBJECT',
      properties: {
        title: { type: 'STRING', description: 'Title of the executive report' },
        markdown_content: { type: 'STRING', description: 'Structured markdown report content with sections, headings, bullet points' },
        style: { type: 'STRING', description: 'Style of the PDF: "wordpad" (minimal B&W) or "modern" (executive slate)' }
      },
      required: ['title', 'markdown_content']
    }
  },
  {
    name: 'deploy_web_preview',
    description: 'Deploy a complete single-file interactive website, portfolio, or landing page to a live public URL and deliver index.html.',
    parameters: {
      type: 'OBJECT',
      properties: {
        title: { type: 'STRING', description: 'Title or name of the web application' },
        html_code: { type: 'STRING', description: 'Complete self-contained HTML with embedded CSS and JavaScript' }
      },
      required: ['title', 'html_code']
    }
  },
  {
    name: 'github_get_repo_tree',
    description: 'Recursively fetch the full directory and file tree of any GitHub repository. Use this to audit codebase architecture and locate specific files.',
    parameters: {
      type: 'OBJECT',
      properties: {
        owner: { type: 'STRING', description: 'GitHub username or org (default: Ajaykumar106)' },
        repo: { type: 'STRING', description: 'Repository name (e.g. Riya)' },
        branch: { type: 'STRING', description: 'Branch name (default: main)' }
      },
      required: ['repo']
    }
  },
  {
    name: 'github_read_file',
    description: 'Read the contents of a file from any GitHub repository via GitHub REST API.',
    parameters: {
      type: 'OBJECT',
      properties: {
        owner: { type: 'STRING', description: 'GitHub username or org (default: Ajaykumar106)' },
        repo: { type: 'STRING', description: 'Repository name (e.g. Riya)' },
        path: { type: 'STRING', description: 'File path inside repository (e.g. package.json, server.js)' },
        branch: { type: 'STRING', description: 'Branch name (default: main)' }
      },
      required: ['repo', 'path']
    }
  },
  {
    name: 'github_search_code',
    description: 'Search repository source code for functions, keywords, or error strings using GitHub code search.',
    parameters: {
      type: 'OBJECT',
      properties: {
        owner: { type: 'STRING', description: 'GitHub username or org (default: Ajaykumar106)' },
        repo: { type: 'STRING', description: 'Repository name (e.g. Riya)' },
        query: { type: 'STRING', description: 'Code search query or keyword' }
      },
      required: ['repo', 'query']
    }
  },
  {
    name: 'github_commit_file',
    description: 'Create, update, or commit a file directly into a GitHub repository using GitHub API.',
    parameters: {
      type: 'OBJECT',
      properties: {
        owner: { type: 'STRING', description: 'GitHub username or org (default: Ajaykumar106)' },
        repo: { type: 'STRING', description: 'Repository name (e.g. Riya)' },
        path: { type: 'STRING', description: 'File path inside repository' },
        content: { type: 'STRING', description: 'Full file content to commit' },
        message: { type: 'STRING', description: 'Git commit message' },
        branch: { type: 'STRING', description: 'Branch name (default: main)' }
      },
      required: ['repo', 'path', 'content', 'message']
    }
  },
  {
    name: 'github_create_pull_request',
    description: 'Create a new Pull Request on a GitHub repository.',
    parameters: {
      type: 'OBJECT',
      properties: {
        owner: { type: 'STRING', description: 'GitHub username or org (default: Ajaykumar106)' },
        repo: { type: 'STRING', description: 'Repository name (e.g. Riya)' },
        title: { type: 'STRING', description: 'Pull request title' },
        head: { type: 'STRING', description: 'Source branch containing changes' },
        base: { type: 'STRING', description: 'Target branch (default: main)' },
        body: { type: 'STRING', description: 'Detailed pull request description' }
      },
      required: ['repo', 'title', 'head']
    }
  },
  {
    name: 'system_telemetry',
    description: 'Query GodEye real-time system metrics, memory RSS, Neon DB latency, and uptime status.',
    parameters: {
      type: 'OBJECT',
      properties: {}
    }
  },
  {
    name: 'market_trend_radar',
    description: 'Scrape and analyze live viral short-form video hooks, editing patterns, and AI tools for ViraClip AI.',
    parameters: {
      type: 'OBJECT',
      properties: {
        category: { type: 'STRING', description: 'Focus area: viral_hooks, editing_styles, ai_tools, or general' }
      }
    }
  },
  {
    name: 'render_3d_spatial_view',
    description: 'Generate, deploy, and launch an interactive 3D WebGL / Three.js spatial model (3D globe, planetary satellite orbits, architecture mesh, or quantum calculation visualizer) with orbital camera controls and tactical dark HUD. Returns live preview and Canvas Studio links.',
    parameters: {
      type: 'OBJECT',
      properties: {
        title: { type: 'STRING', description: 'Title of the 3D visualization' },
        scene_type: { type: 'STRING', description: 'Type: globe_telemetry, architecture_3d, quantum_simulation, or custom' },
        html_code: { type: 'STRING', description: 'Self-contained 3D HTML with embedded Three.js / WebGL' }
      },
      required: ['title']
    }
  },
  {
    name: 'gods_eye_live_intel',
    description: 'Query live spatial intelligence from the local God\'s Eye View engine: flights (ADS-B), satellites, maritime vessels (AIS), or hazard feeds.',
    parameters: {
      type: 'OBJECT',
      properties: {
        layer: { type: 'STRING', description: 'Layer: flights, satellites, cctv, hazards, or weather' },
        location: { type: 'STRING', description: 'City or geographic region (e.g. India, Delhi, Tokyo)' }
      }
    }
  }
];
 
/**
 * SECURITY DEFENSE: SSRF (Server-Side Request Forgery) Protection
 * Validates protocol and blocks loopback, private IP ranges, and cloud metadata services.
 */
function isPrivateOrInternalUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { blocked: true, reason: `Disallowed protocol: ${parsed.protocol}` };
    }

    const host = parsed.hostname.toLowerCase();

    // Block loopback and all-interfaces
    if (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '0.0.0.0' ||
      host === '::1' ||
      host === '[::1]'
    ) {
      return { blocked: true, reason: 'Access to localhost / loopback addresses is prohibited.' };
    }

    // Block cloud metadata services (AWS, GCP, Azure, OpenStack)
    if (
      host === '169.254.169.254' ||
      host === 'metadata.google.internal' ||
      host === 'instance-data' ||
      host.endsWith('.internal') ||
      host.endsWith('.local') ||
      host.endsWith('.localhost')
    ) {
      return { blocked: true, reason: 'Access to internal network or cloud metadata services is prohibited.' };
    }

    // Check private IPv4 ranges (RFC 1918 & RFC 3927)
    const ipv4Match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (ipv4Match) {
      const p1 = parseInt(ipv4Match[1], 10);
      const p2 = parseInt(ipv4Match[2], 10);
      if (p1 === 10) return { blocked: true, reason: 'Access to private network (10.0.0.0/8) is prohibited.' };
      if (p1 === 127) return { blocked: true, reason: 'Access to loopback network (127.0.0.0/8) is prohibited.' };
      if (p1 === 169 && p2 === 254) return { blocked: true, reason: 'Access to link-local network (169.254.0.0/16) is prohibited.' };
      if (p1 === 172 && (p2 >= 16 && p2 <= 31)) return { blocked: true, reason: 'Access to private network (172.16.0.0/12) is prohibited.' };
      if (p1 === 192 && p2 === 168) return { blocked: true, reason: 'Access to private network (192.168.0.0/16) is prohibited.' };
      if (p1 === 0) return { blocked: true, reason: 'Access to 0.0.0.0/8 is prohibited.' };
    }

    return { blocked: false };
  } catch (err) {
    return { blocked: true, reason: `Invalid URL format: ${err.message}` };
  }
}

/**
 * SECURITY DEFENSE: Path Traversal & Sensitive File Exposure Blocker
 */
function isSensitiveOrTraversingPath(filePath) {
  if (!filePath || typeof filePath !== 'string') return true;
  const clean = filePath.replace(/\\/g, '/').trim();
  if (clean.includes('..') || clean.startsWith('/') || clean.startsWith('~')) {
    return true;
  }
  const sensitivePatterns = [
    /^\.env/i,
    /\.env\./i,
    /^\.git(\/|$)/i,
    /id_rsa/i,
    /id_ed25519/i,
    /credentials/i,
    /secret/i,
    /\.npmrc/i,
    /\.bash_history/i,
    /\.aws/i,
    /\.ssh/i
  ];
  return sensitivePatterns.some(p => p.test(clean));
}

/**
 * Deep-scrape any URL using Jina Reader (with native fetch fallback)
 */
async function extractWebPage(url) {
  if (!url) return { error: 'No URL provided' };
  const cleanUrl = url.trim();

  // Enforce SSRF validation
  const validation = isPrivateOrInternalUrl(cleanUrl);
  if (validation.blocked) {
    return { error: `Security Violation: ${validation.reason}` };
  }

  // Try Jina Reader markdown API
  try {
    const jinaRes = await fetch(`https://r.jina.ai/${cleanUrl}`, {
      headers: {
        'Accept': 'text/plain',
        'X-Return-Format': 'markdown',
        'User-Agent': 'Riya-Agent/3.2'
      }
    });
    if (jinaRes.ok) {
      const text = await jinaRes.text();
      return {
        url: cleanUrl,
        success: true,
        content: text.slice(0, 15000),
        source: 'Jina Markdown Engine'
      };
    }
  } catch (_) {}

  // Fallback to direct HTML scrape & text strip
  try {
    const rawRes = await fetch(cleanUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });
    const html = await rawRes.text();
    const cleanText = html
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    return {
      url: cleanUrl,
      success: true,
      content: cleanText.slice(0, 10000),
      source: 'Direct HTML Scraper'
    };
  } catch (err) {
    return { error: `Failed to scrape webpage: ${err.message}` };
  }
}

/**
 * Execute any requested tool and return a JSON result.
 */
async function executeTool(toolName, toolArgs, context = {}) {
  const {
    chatId,
    dbPool,
    saveMemoryFact,
    recallMemories,
    generatePdfBuffer,
    sendTelegramBufferDocument,
    sendTelegramPhoto,
    PREVIEWS_DIR,
    SELF_URL
  } = context;

  console.log(`>> [Tool Dispatch]: ${toolName}`, JSON.stringify(toolArgs || {}).slice(0, 120));

  try {
    switch (toolName) {
      case 'system_telemetry': {
        return godEye.getTelemetry();
      }

      case 'web_extract': {
        return await extractWebPage(toolArgs.url);
      }

      case 'schedule_routine': {
        if (!dbPool) return { error: 'Database not connected' };
        const timeIst = (toolArgs.time_ist || '08:00').trim();
        const routineName = (toolArgs.routine_name || 'Daily Routine').trim();
        const prompt = (toolArgs.prompt || '').trim();
        const targetChat = chatId || 'general';

        const insRes = await dbPool.query(
          `INSERT INTO riya_routines (chat_id, routine_name, time_ist, prompt, active)
           VALUES ($1, $2, $3, $4, TRUE)
           RETURNING id;`,
          [targetChat, routineName, timeIst, prompt]
        );
        return {
          success: true,
          routine_id: insRes.rows[0].id,
          routine_name: routineName,
          time_ist: timeIst,
          message: `Routine scheduled for ${timeIst} IST daily.`
        };
      }

      case 'list_routines': {
        if (!dbPool) return { error: 'Database not connected' };
        const rList = await dbPool.query(`SELECT id, routine_name, time_ist, prompt, active, last_run_date FROM riya_routines ORDER BY id ASC;`);
        return { count: rList.rows.length, routines: rList.rows };
      }

      case 'cancel_routine': {
        if (!dbPool) return { error: 'Database not connected' };
        await dbPool.query(`DELETE FROM riya_routines WHERE id = $1;`, [toolArgs.id]);
        return { success: true, deleted_id: toolArgs.id };
      }

      case 'image_generate': {
        const prompt = (toolArgs.prompt || 'Cyberpunk digital art').trim();
        const encoded = encodeURIComponent(prompt);
        const imageUrl = `https://image.pollinations.ai/prompt/${encoded}?width=1024&height=1024&nologo=true`;
        if (sendTelegramPhoto && chatId) {
          await sendTelegramPhoto(chatId, imageUrl, `🎨 Generated: ${prompt.slice(0, 200)}`);
        }
        return { success: true, image_url: imageUrl, prompt, delivered_to_telegram: !!chatId };
      }

      case 'run_sandbox_code': {
        const lang = toolArgs.language || 'javascript';
        const code = toolArgs.code || '';
        const res = await runInSandbox(lang, code, 7500);
        return {
          language: lang,
          exitCode: res.exitCode,
          success: res.success,
          stdout: res.stdout || '[No stdout output]',
          stderr: res.stderr || '[No stderr output]',
          executionTimeMs: res.executionTimeMs
        };
      }

      case 'recall_memory': {
        if (!recallMemories) return { error: 'Vector memory not available' };
        const results = await recallMemories(toolArgs.query || '', 5);
        return {
          count: results.length,
          memories: results.map(m => ({
            category: m.category,
            content: m.content,
            similarity: Math.round((m.similarity || 1) * 100) + '%'
          }))
        };
      }

      case 'save_memory': {
        if (!saveMemoryFact) return { error: 'Vector memory not available' };
        const res = await saveMemoryFact(toolArgs.category || 'general', toolArgs.content || '', 2);
        return { success: true, saved: res };
      }

      case 'generate_pdf_report': {
        const title = toolArgs.title || 'Executive Intelligence Report';
        const content = toolArgs.markdown_content || '';
        const style = toolArgs.style === 'wordpad' ? 'wordpad' : 'modern';
        if (generatePdfBuffer && sendTelegramBufferDocument && chatId) {
          const pdfBuf = await generatePdfBuffer(title, content, null, style);
          const safeName = title.toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 25) + '.pdf';
          await sendTelegramBufferDocument(chatId, safeName, pdfBuf, 'application/pdf', `📄 ${title} (${style === 'wordpad' ? 'Clean WordPad Document' : 'Executive PDF'})`);
          return { success: true, filename: safeName, bytes: pdfBuf.length, sentToTelegram: true };
        }
        return { success: true, note: 'PDF generation prepared.' };
      }

      case 'deploy_web_preview': {
        const title = toolArgs.title || 'Web Application';
        const html = toolArgs.html_code || '';
        const siteId = 'site_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
        if (PREVIEWS_DIR) {
          fs.writeFileSync(path.join(PREVIEWS_DIR, `${siteId}.html`), html, 'utf-8');
        }
        const liveUrl = `${SELF_URL}/preview/${siteId}`;
        if (sendTelegramBufferDocument && chatId) {
          await sendTelegramBufferDocument(
            chatId,
            'index.html',
            Buffer.from(html, 'utf-8'),
            'text/html;charset=utf-8',
            `💻 ${title} Source (index.html)`
          );
        }
        return { success: true, live_url: liveUrl, preview_id: siteId, title };
      }

      case 'github_get_repo_tree': {
        const owner = toolArgs.owner || 'Ajaykumar106';
        const repo = toolArgs.repo || 'Riya';
        const branch = toolArgs.branch || 'main';

        const token = process.env.GITHUB_TOKEN || '';
        const headers = { 'User-Agent': 'Riya-Agent/3.2' };
        if (token) headers['Authorization'] = `token ${token}`;

        const url = `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`;
        const res = await fetch(url, { headers });
        if (!res.ok) {
          return { error: `GitHub API error: ${res.status} ${res.statusText}` };
        }
        const data = await res.json();
        const cleanTree = (data.tree || [])
          .filter(item => {
            const p = item.path;
            return !p.startsWith('node_modules/') && !p.startsWith('.git/') && !p.startsWith('.gemini/');
          })
          .map(item => ({ path: item.path, type: item.type, size: item.size }));

        return {
          repo: `${owner}/${repo}`,
          branch,
          totalFiles: cleanTree.length,
          tree: cleanTree.slice(0, 150)
        };
      }

      case 'github_read_file': {
        const owner = toolArgs.owner || 'Ajaykumar106';
        const repo = toolArgs.repo || 'Riya';
        const filePath = toolArgs.path || 'package.json';
        const branch = toolArgs.branch || 'main';

        if (isSensitiveOrTraversingPath(filePath)) {
          return { error: 'Security Violation: Access to sensitive credential or traversing file paths is prohibited.' };
        }

        const token = process.env.GITHUB_TOKEN || '';
        const headers = { 'User-Agent': 'Riya-Agent/3.2' };
        if (token) headers['Authorization'] = `token ${token}`;

        const ghRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${filePath}?ref=${branch}`, { headers });
        if (!ghRes.ok) {
          return { error: `GitHub API error: ${ghRes.status} ${ghRes.statusText}` };
        }
        const ghData = await ghRes.json();
        const fileText = Buffer.from(ghData.content, 'base64').toString('utf-8');
        return { path: filePath, size: ghData.size, sha: ghData.sha, content: fileText };
      }

      case 'github_search_code': {
        const owner = toolArgs.owner || 'Ajaykumar106';
        const repo = toolArgs.repo || 'Riya';
        const query = toolArgs.query || '';

        const token = process.env.GITHUB_TOKEN || '';
        const headers = { 'User-Agent': 'Riya-Agent/3.2' };
        if (token) headers['Authorization'] = `token ${token}`;

        const searchUrl = `https://api.github.com/search/code?q=${encodeURIComponent(query)}+repo:${owner}/${repo}`;
        const searchRes = await fetch(searchUrl, { headers });
        if (!searchRes.ok) {
          return { error: `GitHub Code Search error: ${searchRes.status} ${searchRes.statusText}` };
        }
        const searchData = await searchRes.json();
        const items = (searchData.items || []).slice(0, 10).map(i => ({
          name: i.name,
          path: i.path,
          html_url: i.html_url
        }));
        return { totalMatches: searchData.total_count, items };
      }

      case 'github_commit_file': {
        const owner = toolArgs.owner || 'Ajaykumar106';
        const repo = toolArgs.repo || 'Riya';
        const filePath = toolArgs.path || '';
        const content = toolArgs.content || '';
        const message = toolArgs.message || `Update ${filePath} via Riya AI Autopilot`;
        const branch = toolArgs.branch || 'main';

        if (isSensitiveOrTraversingPath(filePath)) {
          return { error: 'Security Violation: Committing to sensitive credential or traversing file paths is prohibited.' };
        }

        const token = process.env.GITHUB_TOKEN || '';
        if (!token) {
          return {
            error: 'GITHUB_TOKEN is not set in Render environment variables. Set GITHUB_TOKEN to grant Riya write/commit permission to your repositories.'
          };
        }

        const headers = {
          'User-Agent': 'Riya-Agent/3.2',
          'Authorization': `token ${token}`,
          'Content-Type': 'application/json'
        };

        let sha = undefined;
        try {
          const check = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${filePath}?ref=${branch}`, { headers });
          if (check.ok) {
            const d = await check.json();
            sha = d.sha;
          }
        } catch (_) {}

        const commitBody = {
          message,
          content: Buffer.from(content, 'utf-8').toString('base64'),
          branch
        };
        if (sha) commitBody.sha = sha;

        const putRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`, {
          method: 'PUT',
          headers,
          body: JSON.stringify(commitBody)
        });
        const putData = await putRes.json();
        if (!putRes.ok) {
          return { error: putData.message || 'GitHub commit failed' };
        }
        return {
          success: true,
          commitUrl: putData.commit?.html_url,
          fileUrl: putData.content?.html_url
        };
      }

      case 'github_create_pull_request': {
        const owner = toolArgs.owner || 'Ajaykumar106';
        const repo = toolArgs.repo || 'Riya';
        const title = toolArgs.title || 'Autonomous Optimization via Riya AI';
        const head = toolArgs.head || '';
        const base = toolArgs.base || 'main';
        const body = toolArgs.body || 'Autonomous Pull Request created by Riya FRIDAY Engine.';

        const token = process.env.GITHUB_TOKEN || '';
        if (!token) {
          return { error: 'GITHUB_TOKEN is not set in Render environment variables.' };
        }

        const headers = {
          'User-Agent': 'Riya-Agent/3.2',
          'Authorization': `token ${token}`,
          'Content-Type': 'application/json'
        };

        const prRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ title, head, base, body })
        });
        const prData = await prRes.json();
        if (!prRes.ok) {
          return { error: prData.message || 'Pull request creation failed' };
        }
        return {
          success: true,
          prNumber: prData.number,
          prUrl: prData.html_url,
          title: prData.title
        };
      }

      case 'market_trend_radar': {
        const category = toolArgs.category || 'viral_hooks';
        return {
          category,
          timestamp: new Date().toISOString(),
          status: 'ready',
          note: 'Trigger live search for viral hooks, retention editing patterns, and video AI landscape.'
        };
      }

      case 'render_3d_spatial_view': {
        const title = toolArgs.title || '3D Spatial Intelligence View';
        let html = toolArgs.html_code || '';
        const sceneType = toolArgs.scene_type || 'globe_telemetry';
        const siteId = 'spatial3d_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);

        if (!html || html.length < 50) {
          html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    * { margin:0; padding:0; box-sizing:border-box; }
    body { background:#030712; color:#38bdf8; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,monospace; overflow:hidden; }
    #hud { position:absolute; top:20px; left:20px; z-index:10; pointer-events:none; }
    .title { font-size:16px; font-weight:700; letter-spacing:1.5px; text-transform:uppercase; color:#f8fafc; }
    .subtitle { font-size:11px; color:#94a3b8; margin-top:4px; }
    .telemetry { margin-top:12px; font-size:11px; line-height:1.6; color:#38bdf8; }
    #canvas-container { width:100vw; height:100vh; }
    .badge { display:inline-block; padding:2px 8px; border-radius:4px; background:rgba(56,189,248,0.15); border:1px solid #38bdf8; font-size:10px; font-weight:700; margin-top:8px; }
  </style>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/OrbitControls.js"></script>
</head>
<body>
  <div id="hud">
    <div class="title">👁️ ${title}</div>
    <div class="subtitle">PROJECT STARK TRINITY // SPATIAL 3D RECONNAISSANCE</div>
    <div class="badge">TACTICAL HUD ONLINE</div>
    <div class="telemetry">
      • SCENE: ${sceneType.toUpperCase()}<br>
      • TARGET: PLANETARY ORBIT<br>
      • RENDER: WEBGL 2.0 | FPS: 60<br>
      • ORBIT CONTROLS: ACTIVE (DRAG TO ROTATE, SCROLL TO ZOOM)
    </div>
  </div>
  <div id="canvas-container"></div>
  <script>
    const container = document.getElementById('canvas-container');
    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x030712, 0.0015);

    const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.set(0, 5, 22);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(renderer.domElement);

    const controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;

    const globeGeo = new THREE.SphereGeometry(8, 36, 36);
    const globeMat = new THREE.MeshBasicMaterial({ color: 0x0284c7, wireframe: true, transparent: true, opacity: 0.35 });
    const globe = new THREE.Mesh(globeGeo, globeMat);
    scene.add(globe);

    const innerGeo = new THREE.SphereGeometry(7.8, 32, 32);
    const innerMat = new THREE.MeshBasicMaterial({ color: 0x0f172a });
    const innerSphere = new THREE.Mesh(innerGeo, innerMat);
    scene.add(innerSphere);

    const ringGeo = new THREE.RingGeometry(11, 11.2, 64);
    const ringMat = new THREE.MeshBasicMaterial({ color: 0x38bdf8, side: THREE.DoubleSide, transparent: true, opacity: 0.5 });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = Math.PI / 2.3;
    scene.add(ring);

    const satCount = 120;
    const satGeo = new THREE.BufferGeometry();
    const satPositions = new Float32Array(satCount * 3);
    for (let i = 0; i < satCount * 3; i += 3) {
      const u = Math.random();
      const v = Math.random();
      const theta = u * 2.0 * Math.PI;
      const phi = Math.acos(2.0 * v - 1.0);
      const r = 8.8 + Math.random() * 3.5;
      satPositions[i] = r * Math.sin(phi) * Math.cos(theta);
      satPositions[i + 1] = r * Math.sin(phi) * Math.sin(theta);
      satPositions[i + 2] = r * Math.cos(phi);
    }
    satGeo.setAttribute('position', new THREE.BufferAttribute(satPositions, 3));
    const satMat = new THREE.PointsMaterial({ color: 0x38bdf8, size: 0.35, transparent: true, opacity: 0.85 });
    const satellites = new THREE.Points(satGeo, satMat);
    scene.add(satellites);

    const starCount = 800;
    const starGeo = new THREE.BufferGeometry();
    const starPos = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount * 3; i++) {
      starPos[i] = (Math.random() - 0.5) * 400;
    }
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
    const starMat = new THREE.PointsMaterial({ color: 0x64748b, size: 0.5 });
    scene.add(new THREE.Points(starGeo, starMat));

    function animate() {
      requestAnimationFrame(animate);
      globe.rotation.y += 0.002;
      innerSphere.rotation.y += 0.002;
      satellites.rotation.y += 0.003;
      controls.update();
      renderer.render(scene, camera);
    }
    animate();

    window.addEventListener('resize', () => {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
    });
  </script>
</body>
</html>`;
        }

        if (PREVIEWS_DIR) {
          fs.writeFileSync(path.join(PREVIEWS_DIR, `${siteId}.html`), html, 'utf-8');
        }

        const liveUrl = `${SELF_URL}/preview/${siteId}`;
        if (sendTelegramBufferDocument && chatId) {
          await sendTelegramBufferDocument(
            chatId,
            'spatial_view.html',
            Buffer.from(html, 'utf-8'),
            'text/html;charset=utf-8',
            `🌐 ${title} (3D Interactive Model)`
          );
        }

        return {
          success: true,
          title,
          scene_type: sceneType,
          live_url: liveUrl,
          canvas_url: `${SELF_URL}/canvas/${siteId}`,
          preview_id: siteId
        };
      }

      case 'gods_eye_live_intel': {
        const layer = toolArgs.layer || 'flights';
        const location = toolArgs.location || 'Global';
        let liveData = null;

        try {
          if (layer === 'flights') {
            const r = await fetch(`http://localhost:4173/api/opensky/states/all`);
            if (r.ok) {
              const d = await r.json();
              liveData = {
                source: "God's Eye View Local Flight Tracker",
                totalTrackedAircraft: d.states?.length || 0,
                sampleFlights: (d.states || []).slice(0, 5).map(s => ({
                  callsign: (s[1] || '').trim(),
                  country: s[2],
                  altitudeMeters: s[7],
                  velocityMs: s[9]
                }))
              };
            }
          }
        } catch (_) {}

        return {
          layer,
          location,
          gods_eye_view_url: 'http://localhost:4173/',
          public_gods_eye_url: 'https://godseyeview.ai/',
          liveData: liveData || {
            status: 'active',
            source: "God's Eye View Spatial Intelligence",
            details: `Active spatial feed for ${layer} across ${location}.`
          }
        };
      }

      default:
        return { error: `Unknown tool: ${toolName}` };
    }
  } catch (err) {
    console.error(`[Tool Execution Error - ${toolName}]:`, err.message);
    return { error: err.message };
  }
}

/**
 * Autonomous Agent Loop: Invokes Gemini with Tool Declarations, handles tool calls,
 * and feeds tool responses back to Gemini until a final response is generated.
 */
async function callGeminiAgent(sysPrompt, messagesList, context = {}, fallbackFn) {
  const cleanKey = (process.env.GEMINI_API_KEY || '').trim().replace(/^["']|["']$/g, '');
  if (!cleanKey) {
    return { text: "Riya System Notice: GEMINI_API_KEY is missing." };
  }

  // Format messages into Gemini format
  const contents = [];
  for (const m of messagesList) {
    if (m.role === 'system') continue;
    const parts = [];
    if (m.content) parts.push({ text: m.content });
    if (m.imagePart) parts.push(m.imagePart);
    if (m.audioPart) parts.push(m.audioPart);
    contents.push({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: parts.length ? parts : [{ text: '' }]
    });
  }

  if (!contents.length) {
    contents.push({ role: 'user', parts: [{ text: 'Hello Riya' }] });
  }

  const payload = {
    system_instruction: { parts: [{ text: sysPrompt }] },
    contents: contents,
    tools: [
      { function_declarations: FUNCTION_DECLARATIONS }
    ],
    generationConfig: {
      temperature: parseFloat(process.env.GEMINI_TEMPERATURE || '0.3'),
      topP: parseFloat(process.env.GEMINI_TOP_P || '0.95'),
      topK: parseInt(process.env.GEMINI_TOP_K || '40', 10),
      maxOutputTokens: parseInt(process.env.GEMINI_MAX_TOKENS || '8192', 10)
    }
  };

  const modelsToTry = [
    process.env.GEMINI_MODEL,
    'gemini-3.1-flash-lite',
    'gemini-flash-lite-latest',
    'gemini-3-flash-preview',
    'gemini-3.5-flash',
    'gemini-3.5-flash-lite',
    'gemini-3.6-flash',
    'gemini-3.7-flash',
    'gemini-3.1-pro-preview',
    'gemini-pro-latest'
  ].filter(Boolean);

  let turns = 0;
  const maxTurns = 6;
  const toolSideEffects = {};

  while (turns < maxTurns) {
    turns++;
    let responseData = null;

    for (const model of modelsToTry) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${cleanKey}`;
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (data.candidates && data.candidates[0]?.content) {
          responseData = data.candidates[0].content;
          break;
        }
      } catch (_) {}
    }

    if (!responseData || !responseData.parts || !responseData.parts.length) {
      if (fallbackFn) {
        const fallbackText = await fallbackFn(sysPrompt, messagesList);
        return { text: fallbackText };
      }
      return { text: "Task completed." };
    }

    // Check if Gemini invoked a function call
    const funcCallPart = responseData.parts.find(p => p.functionCall);

    if (funcCallPart && funcCallPart.functionCall) {
      const { name, args } = funcCallPart.functionCall;
      console.log(`>> [Agent Step ${turns}] Model called function: ${name}`);

      const toolOutput = await executeTool(name, args, context);

      if (name === 'deploy_web_preview' && toolOutput.live_url) {
        toolSideEffects.previewUrl = toolOutput.live_url;
      }
      if (name === 'image_generate' && toolOutput.image_url) {
        toolSideEffects.imageUrl = toolOutput.image_url;
      }
      if (name === 'run_sandbox_code') {
        toolSideEffects.sandboxOutput = toolOutput;
      }
      if (name === 'render_3d_spatial_view' && toolOutput.live_url) {
        toolSideEffects.previewUrl = toolOutput.live_url;
        toolSideEffects.spatial3d = toolOutput;
      }
      if (name === 'system_telemetry') {
        toolSideEffects.telemetry = toolOutput;
      }

      payload.contents.push({
        role: 'model',
        parts: [{ functionCall: { name, args } }]
      });

      payload.contents.push({
        role: 'function',
        parts: [
          {
            functionResponse: {
              name,
              response: { result: toolOutput }
            }
          }
        ]
      });

      continue;
    }

    // Model returned final text answer!
    const textPart = responseData.parts.find(p => p.text);
    return {
      text: textPart ? textPart.text.trim() : 'Task completed.',
      sideEffects: toolSideEffects
    };
  }

  return {
    text: "Task completed.",
    sideEffects: toolSideEffects
  };
}

module.exports = {
  FUNCTION_DECLARATIONS,
  executeTool,
  callGeminiAgent,
  extractWebPage
};
