/**
 * Riya AI - Palantir Ontology & Knowledge Graph Engine
 *
 * Implements an Enterprise-Grade Knowledge Graph & Threat/Entity Ontology:
 * - Entities (Objects): TARGET, REPO, SERVER, DATABASE, THREAT_ACTOR, ASSET, PROTOCOL
 * - Links (Edges): OWNS, DEPLOYS_TO, DEPENDS_ON, MONITORS, COMMUNICATES_WITH, VULNERABLE_TO
 * - Generates Palantir-style Situational Reports (SITREPs) with visual graph topology.
 */

class OntologyEngine {
  constructor() {
    this.inMemoryEntities = new Map();
    this.inMemoryLinks = [];
    this.seedDefaultOntology();
  }

  seedDefaultOntology() {
    // Seed core Stark Trinity & Architecture nodes
    this.addEntity('AI_AGENT', 'Riya Core', { role: 'Autonomous Operating Partner', status: 'Active' });
    this.addEntity('ARCHITECT', 'Ajay Kumar AJ', { role: 'Lead Architect & Creator', jurisdiction: 'India' });
    this.addEntity('INFRASTRUCTURE', 'Render Cloud', { service: 'Web Service (Node.js)', region: 'Oregon, US' });
    this.addEntity('DATABASE', 'Neon PostgreSQL', { engine: 'Serverless PostgreSQL 16 + pgvector', tier: 'Cloud' });
    this.addEntity('SURVEILLANCE', 'GodEye View', { engine: 'Cesium 3D Globe + Keyhole HUD', port: 4173 });
    this.addEntity('LLM_CORE', 'Google Gemini 3.5', { role: 'JARVIS Contextual Reasoning' });
    this.addEntity('LLM_TACTICAL', 'Groq LPU', { role: 'FRIDAY Sub-Second Code Execution (500 tok/s)' });
    this.addEntity('LLM_FALLBACK', 'OpenRouter Free', { role: 'DeepSeek-R1 & Llama-3.3 Universal Failover' });

    // Seed core relationships
    this.addLink('Ajay Kumar AJ', 'Riya Core', 'FOUNDED_AND_ARCHITECTED', 1.0);
    this.addLink('Riya Core', 'Render Cloud', 'HOSTED_ON', 1.0);
    this.addLink('Riya Core', 'Neon PostgreSQL', 'PERSISTS_MEMORY_TO', 1.0);
    this.addLink('Riya Core', 'GodEye View', 'SYNCHRONIZES_TELEMETRY', 1.0);
    this.addLink('Riya Core', 'Google Gemini 3.5', 'PRIMARY_REASONING_DISPATCH', 1.0);
    this.addLink('Riya Core', 'Groq LPU', 'TACTICAL_FAILOVER_DISPATCH', 1.0);
    this.addLink('Riya Core', 'OpenRouter Free', 'RESERVE_FAILOVER_DISPATCH', 1.0);
  }

  addEntity(type, name, properties = {}) {
    this.inMemoryEntities.set(name, {
      type,
      name,
      properties,
      timestamp: new Date().toISOString()
    });
    return this.inMemoryEntities.get(name);
  }

  addLink(source, target, relation, confidence = 1.0, metadata = {}) {
    const link = {
      source,
      target,
      relation,
      confidence,
      metadata,
      timestamp: new Date().toISOString()
    };
    this.inMemoryLinks.push(link);
    return link;
  }

  queryGraph(term) {
    const lower = (term || '').toLowerCase();
    const matchedEntities = [];
    for (const [name, ent] of this.inMemoryEntities.entries()) {
      if (name.toLowerCase().includes(lower) || ent.type.toLowerCase().includes(lower)) {
        matchedEntities.push(ent);
      }
    }

    const matchedLinks = this.inMemoryLinks.filter(l =>
      l.source.toLowerCase().includes(lower) ||
      l.target.toLowerCase().includes(lower) ||
      l.relation.toLowerCase().includes(lower)
    );

    return {
      query: term,
      entities: matchedEntities,
      links: matchedLinks,
      totalNodes: this.inMemoryEntities.size,
      totalEdges: this.inMemoryLinks.length
    };
  }

  getAllGraphData() {
    return {
      nodes: Array.from(this.inMemoryEntities.values()).map(e => ({
        id: e.name,
        label: e.name,
        group: e.type,
        properties: e.properties
      })),
      edges: this.inMemoryLinks.map(l => ({
        from: l.source,
        to: l.target,
        label: l.relation,
        confidence: l.confidence
      }))
    };
  }

  generateSitrepText(targetSubject, aiAnalysis = '') {
    const graphSnapshot = this.queryGraph(targetSubject);
    const nodesCount = graphSnapshot.entities.length || this.inMemoryEntities.size;
    const edgesCount = graphSnapshot.links.length || this.inMemoryLinks.length;

    let relationsSnippet = '';
    if (graphSnapshot.links.length) {
      relationsSnippet = graphSnapshot.links
        .slice(0, 8)
        .map(l => `  • \`[${l.source}]\` ──(${l.relation})──> \`[${l.target}]\``)
        .join('\n');
    } else {
      relationsSnippet = `  • \`[${targetSubject}]\` ──(ANALYZED_BY)──> \`[Riya Palantir Core]\`\n  • \`[${targetSubject}]\` ──(MONITORED_BY)──> \`[GodEye Surveillance]\``;
    }

    return `🛡️ **PALANTIR STRATEGIC SITUATION REPORT (SITREP)**
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🎯 **Target Entity:** \`${targetSubject.toUpperCase()}\`
📡 **Classification:** \`Strategic Operational Asset\`
🕸️ **Ontology Scope:** \`${nodesCount} Nodes\` • \`${edgesCount} Active Relational Edges\`
⏱️ **Generated:** \`${new Date().toUTCString()}\`

🌐 **ONTOLOGY TOPOLOGY & LINKAGES:**
${relationsSnippet}

📊 **INTELLIGENCE SYNTHESIS & DEFENSE POSTURE:**
${aiAnalysis || 'Target analyzed across architectural attack surface, relational dependencies, and continuous monitoring feeds.'}

⚔️ **STRATEGIC ACTION DIRECTIVES (ARCHITECT AJAY):**
1. Maintain perimeter isolation and verify token scopes.
2. Correlate live telemetry with GodEye 3D spatial simulator.
3. Keep automated failover pipelines armed across multi-model tiers.`;
  }
}

const ontology = new OntologyEngine();

module.exports = {
  ontology,
  OntologyEngine
};
