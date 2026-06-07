/**
 * Task 4 — apply the curated O*NET hot-tool decisions to data/skills-pilot.json.
 *   pnpm exec ts-node src/tools/apply-onet-curation.ts
 *
 * Decisions (hand-curated from data/onet/onet-match-report.json):
 *  - ADD: genuinely-new mainstream IT skills as new rows (source ONET, in_demand true).
 *  - ALIAS_ADD: attach useful variant names to existing canonicals (better matching recall).
 *  - ALIAS_REMOVE: when a former alias becomes its own canonical (e.g. nosql alias "mongodb"
 *    -> new skill mongodb), remove it from the old skill to avoid alias-shadowing.
 * No row is added to any role rubric (X1-safe: recognition layer only, not scoring).
 * Idempotent: skips canonicals/aliases already present.
 */
import * as fs from 'fs';
import * as path from 'path';
import { SkillTaxonomyService } from '../common/services/skill-taxonomy.service';

interface PilotSkill {
  canonical_name: string;
  display_name: string;
  category: string;
  source: string;
  source_external_id: string | null;
  aliases: string[];
  [k: string]: unknown;
}
interface OnetSkill {
  canonical_name: string;
  display_name: string;
  category: string;
  source_external_id: string;
  in_demand: boolean;
}

// clean_canonical -> { display, onetKey (to look up O*NET id/category), category (our bucket), aliases }
const ADD: Record<
  string,
  { display: string; onetKey: string; category: string; aliases: string[] }
> = {
  ansible: {
    display: 'Ansible',
    onetKey: 'ansible_software',
    category: 'devops',
    aliases: ['ansible'],
  },
  terraform: {
    display: 'Terraform',
    onetKey: 'ibm_terraform',
    category: 'devops',
    aliases: ['terraform'],
  },
  scala: { display: 'Scala', onetKey: 'scala', category: 'backend', aliases: ['scala'] },
  perl: { display: 'Perl', onetKey: 'perl', category: 'backend', aliases: ['perl'] },
  cassandra: {
    display: 'Apache Cassandra',
    onetKey: 'apache_cassandra',
    category: 'database',
    aliases: ['cassandra', 'apache cassandra'],
  },
  snowflake: {
    display: 'Snowflake',
    onetKey: 'snowflake',
    category: 'database',
    aliases: ['snowflake'],
  },
  redis: { display: 'Redis', onetKey: 'redis', category: 'database', aliases: ['redis'] },
  junit: { display: 'JUnit', onetKey: 'junit', category: 'testing', aliases: ['junit'] },
  jquery: { display: 'jQuery', onetKey: 'jquery', category: 'frontend', aliases: ['jquery'] },
  bootstrap: {
    display: 'Bootstrap',
    onetKey: 'bootstrap',
    category: 'frontend',
    aliases: ['bootstrap'],
  },
  wordpress: {
    display: 'WordPress',
    onetKey: 'wordpress',
    category: 'frontend',
    aliases: ['wordpress'],
  },
  splunk: {
    display: 'Splunk',
    onetKey: 'splunk_enterprise',
    category: 'devops',
    aliases: ['splunk'],
  },
  grafana: {
    display: 'Grafana',
    onetKey: 'grafana_labs_grafana_cloud',
    category: 'devops',
    aliases: ['grafana'],
  },
  puppet: { display: 'Puppet', onetKey: 'puppet', category: 'devops', aliases: ['puppet'] },
  chef: { display: 'Chef', onetKey: 'chef', category: 'devops', aliases: ['chef'] },
  tomcat: {
    display: 'Apache Tomcat',
    onetKey: 'apache_tomcat',
    category: 'backend',
    aliases: ['tomcat', 'apache tomcat'],
  },
  maven: {
    display: 'Apache Maven',
    onetKey: 'apache_maven',
    category: 'backend',
    aliases: ['maven', 'apache maven'],
  },
  dynamodb: {
    display: 'Amazon DynamoDB',
    onetKey: 'amazon_dynamodb',
    category: 'database',
    aliases: ['dynamodb', 'amazon dynamodb'],
  },
  sql_server: {
    display: 'Microsoft SQL Server',
    onetKey: 'microsoft_sql_server',
    category: 'database',
    aliases: ['sql server', 'mssql', 'ms sql server'],
  },
  oracle_db: {
    display: 'Oracle Database',
    onetKey: 'oracle_database',
    category: 'database',
    aliases: ['oracle db', 'oracle database'],
  },
  openshift: {
    display: 'Red Hat OpenShift',
    onetKey: 'red_hat_openshift',
    category: 'devops',
    aliases: ['openshift'],
  },
  postgresql: {
    display: 'PostgreSQL',
    onetKey: 'postgresql',
    category: 'database',
    aliases: ['postgres', 'postgresql', 'postgre sql'],
  },
  mysql: { display: 'MySQL', onetKey: 'mysql', category: 'database', aliases: ['mysql'] },
  mongodb: {
    display: 'MongoDB',
    onetKey: 'mongodb',
    category: 'database',
    aliases: ['mongodb', 'mongo'],
  },
  powershell: {
    display: 'PowerShell',
    onetKey: 'microsoft_powershell',
    category: 'devops',
    aliases: ['powershell'],
  },
};

// existing canonical -> aliases to ADD (variant names worth matching)
const ALIAS_ADD: Record<string, string[]> = {
  kafka: ['apache kafka'],
  spark: ['apache spark'],
  hadoop: ['apache hadoop', 'apache hive', 'hive'],
  git: ['github', 'gitlab'],
  power_bi: ['microsoft power bi'],
  ci_cd: ['jenkins'],
  test_automation: ['selenium'],
  java: ['spring boot', 'spring framework'],
  cloud_aws: ['aws', 'amazon web services', 'ec2', 'cloudformation'],
  cloud_azure: ['azure', 'microsoft azure'],
  android_native: ['android'],
  ios_native: ['ios'],
  dotnet: ['c#', '.net', 'asp.net', '.net framework'],
  javascript: ['ajax'],
  linux: ['unix', 'rhel', 'red hat enterprise linux'],
};

// existing canonical -> aliases to REMOVE (now their own canonical → avoid shadowing)
const ALIAS_REMOVE: Record<string, string[]> = {
  nosql: ['mongodb', 'mongo', 'redis'],
  sql: ['mysql', 'postgresql', 'postgres', 'sql server', 'mssql'],
};

function nk(s: string): string {
  return SkillTaxonomyService.normalizeKey(s);
}

function main(): void {
  const pilotPath = path.join(process.cwd(), 'data', 'skills-pilot.json');
  const onetPath = path.join(process.cwd(), 'data', 'onet', 'onet-it-skills.json');
  const pilot = JSON.parse(fs.readFileSync(pilotPath, 'utf8')) as {
    skills: PilotSkill[];
    [k: string]: unknown;
  };
  const onet = JSON.parse(fs.readFileSync(onetPath, 'utf8')) as OnetSkill[];
  const onetByCanonical = new Map(onet.map((o) => [o.canonical_name, o]));
  const byCanonical = new Map(pilot.skills.map((s) => [s.canonical_name, s]));

  let removed = 0,
    aliasAdded = 0,
    added = 0;
  const skipped: string[] = [];

  // 1. ALIAS_REMOVE first (free the keys for new canonicals)
  for (const [canon, toRemove] of Object.entries(ALIAS_REMOVE)) {
    const sk = byCanonical.get(canon);
    if (!sk) continue;
    const removeKeys = new Set(toRemove.map(nk));
    const before = sk.aliases.length;
    sk.aliases = sk.aliases.filter((a) => !removeKeys.has(nk(a)));
    removed += before - sk.aliases.length;
  }

  // 2. ADD new canonicals (skip if canonical or its key already exists anywhere)
  const existingKeys = new Set<string>();
  for (const s of pilot.skills) {
    existingKeys.add(nk(s.canonical_name));
    existingKeys.add(nk(s.display_name));
    for (const a of s.aliases) existingKeys.add(nk(a));
  }
  for (const [canon, d] of Object.entries(ADD)) {
    if (byCanonical.has(canon) || existingKeys.has(nk(canon))) {
      skipped.push(canon + ' (exists)');
      continue;
    }
    const o = onetByCanonical.get(d.onetKey);
    if (!o) {
      skipped.push(canon + ' (onetKey ' + d.onetKey + ' not found)');
      continue;
    }
    const aliases = [...new Set(d.aliases.map((a) => a.trim()).filter(Boolean))];
    pilot.skills.push({
      canonical_name: canon,
      display_name: d.display,
      category: d.category,
      source: 'ONET',
      source_external_id: o.source_external_id,
      aliases,
      in_demand: true,
    });
    aliases.forEach((a) => existingKeys.add(nk(a)));
    existingKeys.add(nk(canon));
    added++;
  }

  // 3. ALIAS_ADD to existing (skip an alias whose key already maps elsewhere)
  for (const [canon, toAdd] of Object.entries(ALIAS_ADD)) {
    const sk = byCanonical.get(canon);
    if (!sk) {
      skipped.push('alias-target ' + canon + ' missing');
      continue;
    }
    const have = new Set(sk.aliases.map(nk));
    for (const a of toAdd) {
      const k = nk(a);
      if (have.has(k)) continue;
      // don't add an alias that collides with a DIFFERENT canonical OR another skill's alias (shadowing guard)
      const collides = pilot.skills.some(
        (s) =>
          s.canonical_name !== canon &&
          (nk(s.canonical_name) === k || s.aliases.some((al) => nk(al) === k)),
      );
      if (collides) {
        skipped.push('alias "' + a + '" -> ' + canon + ' (collides w/ canonical)');
        continue;
      }
      sk.aliases.push(a);
      have.add(k);
      aliasAdded++;
    }
  }

  fs.writeFileSync(pilotPath, JSON.stringify(pilot, null, 2) + '\n');
  console.log(
    `skills: ${pilot.skills.length} (added ${added}) | aliases +${aliasAdded} -${removed}`,
  );
  if (skipped.length) console.log('SKIPPED:\n  ' + skipped.join('\n  '));
}

main();
