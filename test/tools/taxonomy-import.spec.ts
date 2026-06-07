import {
  parseOnetTechSkills,
  OnetRow,
  parseEscoDigitalUris,
  parseEscoSkills,
  EscoRow,
} from '../../src/tools/lib/taxonomy-import';

const TSV = `O*NET-SOC Code\tTitle\tExample\tCommodity Code\tCommodity Title\tHot Technology\tIn Demand
15-1252.00\tSoftware Developers\tReact\t43232408\tWeb platform development software\tY\tY
15-1252.00\tSoftware Developers\tMicrosoft Excel\t43232110\tFinancial analysis software\tN\tN
11-2011.00\tAdvertising Managers\tAdobe Photoshop\t43232102\tGraphics software\tN\tN`;

it('parses + filters O*NET tech skills to the IT subset, deduped by Example', () => {
  const rows: OnetRow[] = parseOnetTechSkills(TSV);
  const names = rows.map((r) => r.example);
  expect(names).toContain('React'); // commodity 43... + web platform
  expect(names).not.toContain('Adobe Photoshop'); // graphics, non-IT commodity
  const react = rows.find((r) => r.example === 'React')!;
  expect(react.hotTechnology).toBe(true);
  expect(react.sourceExternalId).toBe('onet:43232408:React');
});

// ─── ESCO digital-skills importer (Phase 1b) ──────────────────────────────────

const DIGITAL_CSV = `conceptType,conceptUri,preferredLabel,status,skillType,reuseLevel,altLabels,description,broaderConceptUri,broaderConceptPT
KnowledgeSkillCompetence,http://data.europa.eu/esco/skill/abc,Haskell,released,knowledge,sector-specific,Haskell techniques,"A functional language.",,
KnowledgeSkillCompetence,http://data.europa.eu/esco/skill/xyz,use spreadsheets software,released,skill/competence,cross-sector,,"Use a spreadsheet.",,`;

// Real ESCO skills_en.csv header (v1.2.x): inScheme before description, no trailing `code`.
const SKILLS_CSV = `conceptType,conceptUri,skillType,reuseLevel,preferredLabel,altLabels,hiddenLabels,status,modifiedDate,scopeNote,definition,inScheme,description
KnowledgeSkillCompetence,http://data.europa.eu/esco/skill/abc,knowledge,sector-specific,Haskell,"Haskell programming
Haskell language","haskel",released,,,,,"A functional programming language."
KnowledgeSkillCompetence,http://data.europa.eu/esco/skill/notdigital,knowledge,sector-specific,theatre techniques,,,released,,,,,"Stagecraft."`;

it('parseEscoDigitalUris collects every conceptUri from the digital collection', () => {
  const uris = parseEscoDigitalUris(DIGITAL_CSV);
  expect(uris.has('http://data.europa.eu/esco/skill/abc')).toBe(true);
  expect(uris.has('http://data.europa.eu/esco/skill/xyz')).toBe(true);
  expect(uris.size).toBe(2);
});

it('parseEscoSkills keeps only digital-collection URIs, splits multi-label fields, snake_cases', () => {
  const digital = parseEscoDigitalUris(DIGITAL_CSV);
  const rows: EscoRow[] = parseEscoSkills(SKILLS_CSV, digital);
  // "theatre techniques" is NOT in the digital set → dropped.
  expect(rows.map((r) => r.canonical_name)).toEqual(['haskell']);
  const haskell = rows[0];
  expect(haskell.display_name).toBe('Haskell');
  expect(haskell.source_external_id).toBe('http://data.europa.eu/esco/skill/abc');
  expect(haskell.skillType).toBe('knowledge');
  // altLabels (newline-split) + hiddenLabels, deduped, trimmed.
  expect(haskell.aliases).toEqual(['Haskell programming', 'Haskell language', 'haskel']);
});
