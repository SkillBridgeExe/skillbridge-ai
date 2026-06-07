import { parseOnetTechSkills, OnetRow } from '../../src/tools/lib/taxonomy-import';

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
