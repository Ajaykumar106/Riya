const assert = require('assert');
const path = require('path');
const os = require('os');
const { runInSandbox } = require('./sandbox');
const { executeTool, extractWebPage } = require('./tools');
const { cleanDocumentBody } = require('./server');
const { godEye } = require('./godeye');

async function runSecurityTests() {
  console.log('========================================================');
  console.log('>> RUNNING COMPREHENSIVE SECURITY DEFENSE VERIFICATION');
  console.log('========================================================\n');

  let passed = 0;
  let failed = 0;

  function record(testName, isSuccess, details = '') {
    if (isSuccess) {
      console.log(`[PASS] ✅ ${testName} ${details}`);
      passed++;
    } else {
      console.error(`[FAIL] ❌ ${testName} ${details}`);
      failed++;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // TEST SUITE 1: SANDBOX CREDENTIAL & REPO ISOLATION
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('--- 1. Testing Sandbox Isolation & Secret Leakage Prevention ---');
  
  // Set dummy parent environment secrets to test containment
  process.env.DATABASE_URL = 'postgresql://dummy_user:dummy_pass@dummy-host/db';
  process.env.GEMINI_API_KEY = 'mock_secret_gemini_key_for_testing';
  process.env.TELEGRAM_BOT_TOKEN = '000000000:mock_telegram_secret_token_test';
  process.env.GITHUB_TOKEN = 'mock_ghp_personal_access_token_test';

  const testCode = `
    const env = process.env;
    console.log(JSON.stringify({
      db: env.DATABASE_URL || 'NONE',
      gemini: env.GEMINI_API_KEY || 'NONE',
      telegram: env.TELEGRAM_BOT_TOKEN || 'NONE',
      github: env.GITHUB_TOKEN || 'NONE',
      cwd: process.cwd()
    }));
  `;

  const sandboxRes = await runInSandbox('javascript', testCode, 6000);
  try {
    const parsed = JSON.parse(sandboxRes.stdout);
    const noDbLeak = parsed.db === 'NONE';
    const noGeminiLeak = parsed.gemini === 'NONE';
    const noTelegramLeak = parsed.telegram === 'NONE';
    const noGithubLeak = parsed.github === 'NONE';
    const isSandboxDir = parsed.cwd.includes('riya_sandbox');

    record('Sandbox Secret Leakage Block (DATABASE_URL)', noDbLeak, `(Result: ${parsed.db})`);
    record('Sandbox Secret Leakage Block (GEMINI_API_KEY)', noGeminiLeak, `(Result: ${parsed.gemini})`);
    record('Sandbox Secret Leakage Block (TELEGRAM_BOT_TOKEN)', noTelegramLeak, `(Result: ${parsed.telegram})`);
    record('Sandbox Secret Leakage Block (GITHUB_TOKEN)', noGithubLeak, `(Result: ${parsed.github})`);
    record('Sandbox CWD Isolation (Detached from Repo Root)', isSandboxDir, `(CWD: ${parsed.cwd})`);
  } catch (err) {
    record('Sandbox Execution Parsing', false, err.message);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // TEST SUITE 2: SSRF ATTACK VECTORS & INTERNAL NETWORK PROBING
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n--- 2. Testing SSRF Defense & Cloud Metadata Blocking ---');

  const ssrfVectors = [
    { url: 'http://169.254.169.254/latest/meta-data/', name: 'AWS/OpenStack Cloud Metadata (169.254.169.254)' },
    { url: 'http://metadata.google.internal/computeMetadata/v1/', name: 'GCP Cloud Metadata (metadata.google.internal)' },
    { url: 'http://localhost:3001/api/memories', name: 'Internal Localhost Probing (localhost)' },
    { url: 'http://127.0.0.1:3001/admin', name: 'Loopback IPv4 Probing (127.0.0.1)' },
    { url: 'http://0.0.0.0:80', name: 'All Interfaces Probing (0.0.0.0)' },
    { url: 'http://192.168.1.1/router', name: 'Private Subnet RFC1918 (192.168.x.x)' },
    { url: 'http://10.0.0.1/internal-api', name: 'Private Subnet RFC1918 (10.x.x.x)' },
    { url: 'http://172.20.0.1/docker', name: 'Private Subnet RFC1918 (172.16-31.x.x)' },
    { url: 'file:///etc/passwd', name: 'Local File Scheme (file://)' },
    { url: 'gopher://127.0.0.1:6379/_flushall', name: 'Arbitrary Protocol Injection (gopher://)' }
  ];

  for (const v of ssrfVectors) {
    const res = await extractWebPage(v.url);
    const isBlocked = !!(res.error && res.error.includes('Security Violation'));
    record(`SSRF Block: ${v.name}`, isBlocked, res.error ? `(${res.error})` : '');
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // TEST SUITE 3: GITHUB PATH TRAVERSAL & SENSITIVE CREDENTIAL EXPOSURE
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n--- 3. Testing GitHub Path Traversal & Sensitive File Defense ---');

  const fileVectors = [
    { tool: 'github_read_file', args: { repo: 'Riya', path: '.env' }, name: 'Read .env' },
    { tool: 'github_read_file', args: { repo: 'Riya', path: '.env.production' }, name: 'Read .env.production' },
    { tool: 'github_read_file', args: { repo: 'Riya', path: '../../server.js' }, name: 'Path traversal (../../)' },
    { tool: 'github_read_file', args: { repo: 'Riya', path: '.git/config' }, name: 'Read .git/config' },
    { tool: 'github_read_file', args: { repo: 'Riya', path: 'id_rsa' }, name: 'Read SSH Key (id_rsa)' },
    { tool: 'github_commit_file', args: { repo: 'Riya', path: '.env', content: 'fake' }, name: 'Commit to .env' },
    { tool: 'github_commit_file', args: { repo: 'Riya', path: '../exploit.js', content: 'fake' }, name: 'Commit traversal (../)' }
  ];

  for (const f of fileVectors) {
    const res = await executeTool(f.tool, f.args);
    const isBlocked = !!(res.error && res.error.includes('Security Violation'));
    record(`Path Traversal Block: ${f.name}`, isBlocked, res.error ? `(${res.error})` : '');
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // TEST SUITE 4: DELIVERABLE PURITY & CHATTER PURIFICATION
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n--- 4. Testing Deliverable Purity & Document Chatter Stripper ---');

  const rawLeakedReport = `Samajh gayi, AJ. Ekdum simple, black and white, WordPad wala feel-bilkul waisa hi jaisa tune manga hai. Aur haan, image bilkul attach hogi PDF mein taaki report complete lage.
Ye raha tera document layout. Backend iska PDF compile kerke tere Telegram pe bhej raha hai.
---
DOCUMENT: ANALYSISREPORT01.pdf
Date: November 18, 2026
Subject: Image Analysis - Elemental Laws Graphic
---
[IMAGE ATTACHED HERE]
(Note: The actual image you uploaded is embedded in the final PDF file)
---
ANALYSIS SUMMARY
Maine is image ko dhyan se dekha. Iska title "The 5 Most Famous Laws In The World" hai, jo pehli nazar mein kaafi serious aur educational lagta hai.
Key Observations:
1. The Core: Fire, Water, Lightning, Earth, Wind.
2. The Connection: Breathing Styles.
Conclusion:
Elemental analysis complete.
---
End of Document
---
PDF generate ho raha hai... Done. Check kar lo AJ, ekdum simple aur professional hai.`;

  const cleaned = cleanDocumentBody(rawLeakedReport);
  const noSamajhGayi = !cleaned.includes('Samajh gayi');
  const noYeRaha = !cleaned.includes('Ye raha tera');
  const noImagePlaceholder = !cleaned.includes('[IMAGE ATTACHED HERE]');
  const noTrailingChatter = !cleaned.includes('PDF generate ho raha hai') && !cleaned.includes('Check kar lo AJ');
  const hasPureAnalysis = cleaned.includes('DOCUMENT: ANALYSISREPORT01.pdf') && cleaned.includes('ANALYSIS SUMMARY');

  record('Deliverable Purity: Preamble Stripped (Samajh gayi)', noSamajhGayi);
  record('Deliverable Purity: Layout Chat Stripped (Ye raha tera)', noYeRaha);
  record('Deliverable Purity: Fake Placeholder Stripped ([IMAGE ATTACHED HERE])', noImagePlaceholder);
  record('Deliverable Purity: Trailing Chat Stripped (PDF generate ho raha hai... Done)', noTrailingChatter);
  record('Deliverable Purity: Core Document Retained (ANALYSIS SUMMARY)', hasPureAnalysis);

  // ─────────────────────────────────────────────────────────────────────────────
  // TEST SUITE 5: GODEYE TELEMETRY & SYSTEM SURVEILLANCE
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n--- 5. Testing GodEye Surveillance & Telemetry HUD ---');

  const telemetry = godEye.getTelemetry({ userCount: 1, routineCount: 1, model: 'gemini-3.1-flash-lite' });
  const hasHudText = typeof telemetry.hudText === 'string' && telemetry.hudText.includes('GODEYE SURVEILLANCE');
  const hasUptime = typeof telemetry.uptime === 'string' && telemetry.uptime.length > 0;
  const hasMemory = telemetry.memory && parseFloat(telemetry.memory.rssMb) > 0;

  record('GodEye Surveillance: HUD Text Generation', hasHudText);
  record('GodEye Surveillance: Process Uptime Metric', hasUptime, `(Uptime: ${telemetry.uptime})`);
  record('GodEye Surveillance: Process RSS Memory Metric', hasMemory, `(RSS: ${telemetry.memory?.rssMb} MB)`);

  // ─────────────────────────────────────────────────────────────────────────────
  // SUMMARY
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n========================================================');
  console.log(`>> SECURITY VERIFICATION COMPLETE: ${passed} PASSED, ${failed} FAILED`);
  console.log('========================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
  process.exit(0);
}

runSecurityTests().catch(err => {
  console.error('Test Runner Failed:', err);
  process.exit(1);
});
