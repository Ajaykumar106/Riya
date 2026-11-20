const assert = require('assert');
const { profileTarget, synthesizeNotebook } = require('./intel');

async function runTests() {
  console.log("========================================================");
  console.log(">> TESTING STARK TRINITY INTEL & OSINT ENGINES");
  console.log("========================================================");

  // 1. Test Developer OSINT Profiler
  console.log("--- 1. Testing Developer OSINT (Ajaykumar106) ---");
  const devProfile = await profileTarget('Ajaykumar106');
  assert.strictEqual(devProfile.type, 'developer');
  assert.strictEqual(devProfile.username, 'Ajaykumar106');
  assert(devProfile.publicRepos >= 0);
  assert(Array.isArray(devProfile.topRepositories));
  assert(devProfile.chartData);
  console.log(`[PASS] ✅ Developer OSINT: Found ${devProfile.publicRepos} public repos, top languages: ${devProfile.primaryLanguages.join(', ')}`);

  // 2. Test Company Domain OSINT Profiler
  console.log("--- 2. Testing Company Domain OSINT (zerodha.com) ---");
  const compProfile = await profileTarget('zerodha.com');
  assert.strictEqual(compProfile.type, 'company');
  assert.strictEqual(compProfile.domain, 'zerodha.com');
  assert(Array.isArray(compProfile.mxRecords));
  assert(compProfile.chartData);
  console.log(`[PASS] ✅ Company OSINT: Mail Provider: ${compProfile.mailProvider}, CDN: ${compProfile.cdn}`);

  // 3. Test NotebookLM Synthesizer
  console.log("--- 3. Testing NotebookLM Grounded Synthesizer ---");
  const mockCallModel = async (sys, messages) => {
    return `# Test Research Notebook\n\n## 1. Executive Thesis\nThis is a verified grounded report [Source 1].\n\n## 2. Key Grounded Findings\n• Discovery A confirmed [Source 1].\n• Discovery B verified [Source 2].\n\n## 4. Audio Overview Script\nHost A: What makes this so interesting?\nHost B: The verified metrics [Source 1].`;
  };

  const notebook = await synthesizeNotebook({
    title: 'Autonomous Multi-Agent Architectures',
    sources: [
      'Agent swarms enable decentralized task completion with 40% lower hallucination.',
      'Formal logic kernels verify deduplicated findings before output generation.'
    ],
    callModelFn: mockCallModel
  });

  assert.strictEqual(notebook.sourcesCount, 2);
  assert(notebook.synthesis.includes('[Source 1]'));
  assert(notebook.chartData);
  console.log(`[PASS] ✅ NotebookLM Synthesizer: Synthesized across ${notebook.sourcesCount} sources with inline citations`);

  console.log("========================================================");
  console.log(">> ALL INTEL & OSINT TESTS PASSED SUCCESSFULLY!");
  console.log("========================================================");
}

runTests().catch(err => {
  console.error("Test failure in test_intel.js:", err);
  process.exit(1);
});
