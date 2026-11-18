const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const SANDBOX_DIR = path.join(os.tmpdir(), 'riya_sandbox');
if (!fs.existsSync(SANDBOX_DIR)) {
  try {
    fs.mkdirSync(SANDBOX_DIR, { recursive: true });
  } catch (_) {}
}

/**
 * Execute code in an isolated runner with strict timeout safeguards.
 * @param {string} language - 'javascript', 'js', 'node', 'python', 'py', or 'bash'
 * @param {string} code - The source code to execute
 * @param {number} timeoutMs - Max execution time in ms (default 7000ms)
 * @returns {Promise<{ success: boolean, stdout: string, stderr: string, exitCode: number, executionTimeMs: number }>}
 */
function runInSandbox(language, code, timeoutMs = 7000) {
  return new Promise((resolve) => {
    const lang = (language || 'javascript').toLowerCase();
    const id = Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
    
    let ext = '.js';
    let cmd = 'node';
    let args = [];

    if (lang === 'python' || lang === 'py') {
      ext = '.py';
      cmd = process.platform === 'win32' ? 'python' : 'python3';
    } else if (lang === 'bash' || lang === 'sh') {
      ext = '.sh';
      cmd = process.platform === 'win32' ? 'powershell' : 'bash';
    }

    const scriptPath = path.join(SANDBOX_DIR, `run_${id}${ext}`);
    const startTime = Date.now();

    try {
      fs.writeFileSync(scriptPath, code, 'utf-8');
    } catch (err) {
      return resolve({
        success: false,
        stdout: '',
        stderr: `Failed to create sandbox script: ${err.message}`,
        exitCode: 1,
        executionTimeMs: 0
      });
    }

    if (cmd === 'powershell') {
      args = ['-ExecutionPolicy', 'Bypass', '-File', scriptPath];
    } else {
      args = [scriptPath];
    }

    let stdout = '';
    let stderr = '';
    let isTimedOut = false;

    // SECURITY HARDENING: Explicitly isolate sandbox environment.
    // NEVER pass host process.env containing DATABASE_URL, GEMINI_API_KEY, TELEGRAM_BOT_TOKEN, or GITHUB_TOKEN.
    const safeEnv = {
      PATH: process.env.PATH || '',
      NODE_ENV: 'sandbox',
      HOME: os.tmpdir(),
      TMPDIR: os.tmpdir(),
      LANG: 'en_US.UTF-8'
    };
    if (process.platform === 'win32') {
      safeEnv.SystemRoot = process.env.SystemRoot || 'C:\\Windows';
      safeEnv.WINDIR = process.env.WINDIR || 'C:\\Windows';
      safeEnv.PATHEXT = process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD';
    }

    const child = spawn(cmd, args, {
      cwd: SANDBOX_DIR,
      timeout: timeoutMs,
      maxBuffer: 1024 * 512,
      env: safeEnv
    });

    const timer = setTimeout(() => {
      isTimedOut = true;
      try {
        child.kill('SIGKILL');
      } catch (_) {}
    }, timeoutMs);

    child.stdout.on('data', (data) => {
      if (stdout.length < 50000) {
        stdout += data.toString();
      }
    });

    child.stderr.on('data', (data) => {
      if (stderr.length < 50000) {
        stderr += data.toString();
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      try { fs.unlinkSync(scriptPath); } catch (_) {}
      resolve({
        success: false,
        stdout: stdout.trim(),
        stderr: `Process spawn error (${cmd}): ${err.message}`,
        exitCode: 1,
        executionTimeMs: Date.now() - startTime
      });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      try { fs.unlinkSync(scriptPath); } catch (_) {}
      const executionTimeMs = Date.now() - startTime;

      if (isTimedOut) {
        return resolve({
          success: false,
          stdout: stdout.trim(),
          stderr: `Execution timed out after ${timeoutMs}ms (infinite loop or resource hang detected).`,
          exitCode: 124,
          executionTimeMs
        });
      }

      resolve({
        success: code === 0,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: code !== null ? code : 1,
        executionTimeMs
      });
    });
  });
}

/**
 * Autonomous ReAct Agent Loop with Self-Correction.
 * Runs up to maxAttempts times until the code executes cleanly without runtime errors.
 */
async function runAutonomousReActLoop(taskPrompt, language = 'javascript', maxAttempts = 3, callGeminiFn) {
  let attempts = 0;
  let code = '';
  let execResult = null;
  const userLang = language.toLowerCase();

  const history = [
    {
      role: 'user',
      content: `AUTONOMOUS EXECUTION TASK:
${taskPrompt}

RULES FOR SANDBOX EXECUTION:
1. Provide the complete executable code wrapped in a single \`\`\`${userLang} ... \`\`\` code block.
2. Include test cases and console outputs so results are verifiable.
3. Write self-contained code that runs in a single file without external uninstalled dependencies.
4. Output code directly with zero back-and-forth survey questions.`
    }
  ];

  while (attempts < maxAttempts) {
    attempts++;
    console.log(`>> [ReAct Sandbox Loop] Starting attempt ${attempts}/${maxAttempts}...`);

    const sysPrompt = `You are Riya's autonomous code execution and self-healing engine.
Your mission: Generate pure, bug-free, fully functional code for the sandbox runner.
Write clean, self-contained code that executes in a single file.
Always output the code in a single \`\`\`${userLang} ... \`\`\` block.`;

    const modelReply = await callGeminiFn(sysPrompt, history);
    history.push({ role: 'assistant', content: modelReply });

    // Extract code block
    const codeMatch = modelReply.match(new RegExp(`\`\`\`(?:${userLang}|js|javascript|py|python)?\\s*([\\s\\S]*?)\`\`\``, 'i'));
    if (!codeMatch || !codeMatch[1]) {
      return {
        verified: false,
        attempts,
        reply: modelReply,
        code: null,
        execution: null
      };
    }

    code = codeMatch[1].trim();

    // Execute in sandbox runner
    execResult = await runInSandbox(userLang, code, 7500);
    console.log(`>> [ReAct Sandbox Loop] Attempt ${attempts} complete: exitCode=${execResult.exitCode}, success=${execResult.success}`);

    if (execResult.success && execResult.exitCode === 0) {
      // CODE PASSED EXECUTION!
      const verificationReport = `
\`\`\`${userLang}
${code}
\`\`\`

⚡ **Execution Verified in Sandbox:**
\`\`\`
${execResult.stdout || '[Program executed cleanly with no stdout output]'}
\`\`\`
⏱️ *Execution Time: ${execResult.executionTimeMs}ms • Exit Code: 0 (Passed on Attempt ${attempts})*`;

      return {
        verified: true,
        attempts,
        code,
        execution: execResult,
        reply: modelReply,
        verificationReport
      };
    }

    // IF EXECUTION FAILED: FEED ERROR BACK FOR SELF-CORRECTION
    console.log(`>> [ReAct Sandbox Loop] Error detected on attempt ${attempts}. Triggering self-correction...`);
    const errorFeedback = `
EXECUTION FAILED (Exit Code ${execResult.exitCode}):
STDERR:
${execResult.stderr || '[No stderr]'}

STDOUT:
${execResult.stdout || '[No stdout]'}

Analyze the exact stack trace above, fix the bug or syntax issue, and rewrite the complete corrected code wrapped in \`\`\`${userLang} ... \`\`\`. Ensure all variables and modules are defined.`;

    history.push({ role: 'user', content: errorFeedback });
  }

  // If maxAttempts reached without full resolution:
  return {
    verified: false,
    attempts,
    code,
    execution: execResult,
    verificationReport: `
\`\`\`${userLang}
${code}
\`\`\`

⚠️ **Sandbox Execution Notice (Attempt ${attempts}):**
\`\`\`
${execResult?.stderr || execResult?.stdout || 'Execution did not exit cleanly.'}
\`\`\``
  };
}

module.exports = { runInSandbox, runAutonomousReActLoop };
