const assert = require('assert');
const path = require('path');
const os = require('os');
const { runInSandbox } = require('./sandbox');
const { executeTool, extractWebPage } = require('./tools');

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
  // SUMMARY
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n========================================================');
  console.log(`>> SECURITY VERIFICATION COMPLETE: ${passed} PASSED, ${failed} FAILED`);
  console.log('========================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runSecurityTests().catch(err => {
  console.error('Test Runner Failed:', err);
  process.exit(1);
});
