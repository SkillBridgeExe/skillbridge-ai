# Data Attribution

SkillBridge's skill taxonomy (`data/skills-pilot.json`) is a curated derivative work. Per the
licenses below, we credit the original sources and note that **changes were made**: subset
selection for 8 IT roles, renaming to snake_case canonical identifiers, category assignment,
English alias curation, and Vietnamese label/alias authorship by the SkillBridge team.

## ESCO

Rows with `source: "ESCO"` are derived from the **ESCO classification** (European Skills,
Competences, Qualifications and Occupations), © European Union, <https://esco.ec.europa.eu>.
Licensed under **Creative Commons Attribution 4.0 International (CC BY 4.0)**
(<https://creativecommons.org/licenses/by/4.0/>). `source_external_id` holds the ESCO concept
URI tail for traceability. This product uses the ESCO classification but is not endorsed by
the European Commission.

## O*NET

Rows with `source: "ONET"` reference information from **O*NET OnLine / O*NET Resource Center**
by the U.S. Department of Labor, Employment and Training Administration (USDOL/ETA),
<https://www.onetonline.org>. Licensed under **CC BY 4.0**. `source_external_id` holds the
O*NET-SOC occupation code. SkillBridge adapted this information; USDOL/ETA has not reviewed or
endorsed the adaptation.

## Alias spelling references (informational)

Common technology spellings/abbreviations were cross-checked against the public
**Stack Overflow Developer Survey** technology lists and **GitHub Linguist** (MIT license,
<https://github.com/github-linguist/linguist>). No proprietary datasets were copied.

## Explicitly NOT used

No data derived from **SFIA** (paid Partner License — embedding/sub-licensing in products is
prohibited), **Lightcast Open Skills** (open terms exclude commercial use), or the
**LinkedIn Skills Graph** (proprietary) is included. `pnpm taxonomy:validate` enforces this
at build time (banned `source` values fail the run).

## Vietnamese labels

All Vietnamese skill labels and aliases (with- and without-diacritics variants) are original
SkillBridge curation (no upstream source ships Vietnamese), © SkillBridge, released with the
repository's license.
