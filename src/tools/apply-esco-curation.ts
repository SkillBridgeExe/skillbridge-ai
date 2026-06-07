/**
 * Task 3 + Task 5 (Phase 1b) — apply the HAND-CURATED ESCO decisions to data/skills-pilot.json.
 *   pnpm exec ts-node src/tools/apply-esco-curation.ts
 *
 * Two operations, both eval-gated downstream (taxonomy:validate + eval:mentions/semantic/accuracy):
 *   1. ADD  — a bounded set of genuinely-IT `knowledge` concepts ESCO has and we lacked
 *             (gap-fill: data science, IoT, embedded/distributed systems, pentest/forensics,
 *             AR/VR/robotics, UML, Objective-C/MATLAB/R/COBOL/Groovy/Erlang/Haskell, Db2/Teradata,
 *             Drupal/Joomla, Vagrant, Wireshark/Metasploit/Kali). Aliases are deliberately limited
 *             to UNAMBIGUOUS surface forms (no bare "R"/"AR"/"VR"/"BI") to protect gazetteer precision.
 *   2. PROVENANCE — for a MANUALLY-VERIFIED set of existing CUSTOM skills whose ESCO preferredLabel
 *             matches EXACTLY (not alias/fuzzy — those proved noisy: redux←OCR, spark←Ada SPARK),
 *             record the ESCO concept: source CUSTOM→ESCO + source_external_id=UUID. Only fills NULLs.
 *
 * source_external_id format mirrors the existing ESCO rows: the bare concept UUID (not the full URI).
 */
import * as fs from 'fs';
import * as path from 'path';
import type { EscoRow } from './lib/taxonomy-import';

interface PilotSkill {
  canonical_name: string;
  display_name: string;
  category: string;
  source: string;
  source_external_id: string | null;
  aliases: string[];
  [k: string]: unknown;
}

// canonical -> { display, escoLabel (lookup key into esco-it-skills.json), category, aliases }
const ADD: Record<
  string,
  { display: string; escoLabel: string; category: string; aliases: string[] }
> = {
  // data
  data_science: {
    display: 'Data Science',
    escoLabel: 'data science',
    category: 'data_skill',
    aliases: ['data science', 'data science process'],
  },
  data_mining: {
    display: 'Data Mining',
    escoLabel: 'data mining',
    category: 'data_skill',
    aliases: ['data mining'],
  },
  business_intelligence: {
    display: 'Business Intelligence',
    escoLabel: 'business intelligence',
    category: 'data_skill',
    aliases: ['business intelligence', 'business analytics'],
  },
  data_warehouse: {
    display: 'Data Warehouse',
    escoLabel: 'data warehouse',
    category: 'data_skill',
    aliases: ['data warehouse', 'data warehousing'],
  },
  // architecture
  internet_of_things: {
    display: 'Internet of Things',
    escoLabel: 'Internet of Things',
    category: 'architecture',
    aliases: ['internet of things', 'iot'],
  },
  embedded_systems: {
    display: 'Embedded Systems',
    escoLabel: 'embedded systems',
    category: 'architecture',
    aliases: ['embedded systems', 'embedded software', 'embedded programming'],
  },
  distributed_systems: {
    display: 'Distributed Systems',
    escoLabel: 'distributed computing',
    category: 'architecture',
    aliases: ['distributed systems', 'distributed computing', 'parallel computing'],
  },
  uml: {
    display: 'UML',
    escoLabel: 'unified modelling language',
    category: 'architecture',
    aliases: ['uml', 'unified modeling language', 'unified modelling language'],
  },
  // emerging tech
  augmented_reality: {
    display: 'Augmented Reality',
    escoLabel: 'augmented reality',
    category: 'emerging_tech',
    aliases: ['augmented reality'],
  },
  virtual_reality: {
    display: 'Virtual Reality',
    escoLabel: 'virtual reality',
    category: 'emerging_tech',
    aliases: ['virtual reality'],
  },
  robotics: {
    display: 'Robotics',
    escoLabel: 'robotics',
    category: 'emerging_tech',
    aliases: ['robotics', 'mechatronics'],
  },
  // security
  penetration_testing: {
    display: 'Penetration Testing',
    escoLabel: 'ethical hacking principles',
    category: 'security',
    aliases: ['penetration testing', 'pentest', 'ethical hacking'],
  },
  computer_forensics: {
    display: 'Computer Forensics',
    escoLabel: 'computer forensics',
    category: 'security',
    aliases: ['computer forensics', 'digital forensics', 'forensic it'],
  },
  wireshark: {
    display: 'Wireshark',
    escoLabel: 'Wireshark',
    category: 'security',
    aliases: ['wireshark'],
  },
  metasploit: {
    display: 'Metasploit',
    escoLabel: 'Metasploit',
    category: 'security',
    aliases: ['metasploit'],
  },
  kali_linux: {
    display: 'Kali Linux',
    escoLabel: 'Kali Linux',
    category: 'security',
    aliases: ['kali linux', 'kali'],
  },
  // programming languages (gaps O*NET/CUSTOM missed)
  objective_c: {
    display: 'Objective-C',
    escoLabel: 'Objective-C',
    category: 'programming_language',
    aliases: ['objective-c', 'objective c', 'objc'],
  },
  matlab: {
    display: 'MATLAB',
    escoLabel: 'MATLAB',
    category: 'programming_language',
    aliases: ['matlab'],
  },
  // NOTE: ESCO "R" is deliberately NOT imported — a single-letter display/surface form
  // re-introduces the "R" prose false-positive the normalizer guard + eval-mentions negative
  // explicitly kill. R coverage stays served by data_science/pandas/numpy; revisit with a
  // context-aware matcher (e.g. "R language"/"RStudio") in a later pass.
  cobol: {
    display: 'COBOL',
    escoLabel: 'COBOL',
    category: 'programming_language',
    aliases: ['cobol'],
  },
  groovy: {
    display: 'Groovy',
    escoLabel: 'Groovy',
    category: 'programming_language',
    aliases: ['groovy', 'apache groovy'],
  },
  erlang: {
    display: 'Erlang',
    escoLabel: 'Erlang',
    category: 'programming_language',
    aliases: ['erlang'],
  },
  haskell: {
    display: 'Haskell',
    escoLabel: 'Haskell',
    category: 'programming_language',
    aliases: ['haskell'],
  },
  // databases
  db2: { display: 'IBM Db2', escoLabel: 'DB2', category: 'database', aliases: ['db2', 'ibm db2'] },
  teradata: {
    display: 'Teradata',
    escoLabel: 'Teradata Database',
    category: 'database',
    aliases: ['teradata'],
  },
  // CMS / web platforms
  drupal: { display: 'Drupal', escoLabel: 'Drupal', category: 'frontend', aliases: ['drupal'] },
  joomla: { display: 'Joomla', escoLabel: 'Joomla', category: 'frontend', aliases: ['joomla'] },
  // devops
  vagrant: { display: 'Vagrant', escoLabel: 'Vagrant', category: 'devops', aliases: ['vagrant'] },
};

// existing canonical -> ESCO preferredLabel, MANUALLY VERIFIED as the exact same concept
// (exact normalize match only; alias/fuzzy matches were too noisy to trust). Fills NULL provenance.
const PROVENANCE: Record<string, string> = {
  css: 'CSS',
  angular: 'Angular',
  typescript: 'TypeScript',
  nosql: 'NoSQL',
  solidity: 'Solidity',
  hadoop: 'Hadoop',
  computer_vision: 'computer vision',
  system_design: 'system design',
  etl: 'data extraction, transformation and loading tools',
};

const nk = (s: string): string =>
  s
    .toLowerCase()
    .trim()
    .replace(/[\s\-_./]+/g, '')
    .replace(/[()[\]]/g, '');

function main(): void {
  const pilotPath = path.join(process.cwd(), 'data', 'skills-pilot.json');
  const escoPath = path.join(process.cwd(), 'data', 'esco', 'esco-it-skills.json');
  const pilot = JSON.parse(fs.readFileSync(pilotPath, 'utf8')) as {
    skills: PilotSkill[];
    [k: string]: unknown;
  };
  const esco = JSON.parse(fs.readFileSync(escoPath, 'utf8')) as EscoRow[];
  const escoByLabel = new Map(esco.map((r) => [r.preferredLabel, r]));
  const byCanonical = new Map(pilot.skills.map((s) => [s.canonical_name, s]));
  const uuid = (label: string): string | null => {
    const r = escoByLabel.get(label);
    return r ? r.conceptUri.split('/').pop()! : null;
  };

  // existing key index for the collision guard (canonical + display + alias keys).
  const existingKeys = new Set<string>();
  for (const s of pilot.skills) {
    existingKeys.add(nk(s.canonical_name));
    existingKeys.add(nk(s.display_name));
    for (const a of s.aliases) existingKeys.add(nk(a));
  }

  let added = 0;
  let provFilled = 0;
  const skipped: string[] = [];

  // 1. ADD new ESCO canonicals (collision-guarded).
  for (const [canon, d] of Object.entries(ADD)) {
    if (byCanonical.has(canon) || existingKeys.has(nk(canon))) {
      skipped.push(`${canon} (exists)`);
      continue;
    }
    const ext = uuid(d.escoLabel);
    if (!ext) {
      skipped.push(`${canon} (escoLabel "${d.escoLabel}" not found)`);
      continue;
    }
    const aliases = [...new Set(d.aliases.map((a) => a.trim()).filter(Boolean))];
    // guard: no alias may collide with an existing canonical/alias OR a previously-added one.
    const clash = aliases.find((a) => existingKeys.has(nk(a)) && nk(a) !== nk(canon));
    if (clash) {
      skipped.push(`${canon} (alias "${clash}" collides)`);
      continue;
    }
    pilot.skills.push({
      canonical_name: canon,
      display_name: d.display,
      category: d.category,
      source: 'ESCO',
      source_external_id: ext,
      aliases,
    });
    existingKeys.add(nk(canon));
    existingKeys.add(nk(d.display));
    for (const a of aliases) existingKeys.add(nk(a));
    added++;
  }

  // 2. PROVENANCE — fill NULL source_external_id on verified-exact existing skills.
  for (const [canon, escoLabel] of Object.entries(PROVENANCE)) {
    const s = byCanonical.get(canon);
    if (!s) {
      skipped.push(`prov ${canon} (missing)`);
      continue;
    }
    if (s.source_external_id) {
      skipped.push(`prov ${canon} (already has ext)`);
      continue;
    }
    const ext = uuid(escoLabel);
    if (!ext) {
      skipped.push(`prov ${canon} (escoLabel "${escoLabel}" not found)`);
      continue;
    }
    s.source = 'ESCO';
    s.source_external_id = ext;
    provFilled++;
  }

  fs.writeFileSync(pilotPath, JSON.stringify(pilot, null, 2) + '\n');
  console.log(`skills: ${pilot.skills.length} (added ${added}) | provenance filled ${provFilled}`);
  if (skipped.length) console.log('SKIPPED:\n  ' + skipped.join('\n  '));
}

main();
