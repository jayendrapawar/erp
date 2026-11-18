// Division HINTS by article-code prefix (longest prefix at the start of the code wins).
// Used only to suggest a division in the new-article dialog. The article master's
// `division` column is the source of truth; never store this hint as fact.
export const DIVISION_MAP: Record<string, string> = {
  FL: 'Flite EVA',
  PU: 'Flite PU',
  PF: 'Flite PU',
  SF: 'Sparx',
  SS: 'Sparx',
  SX: 'Sparx',
  SD: 'Sparx',
  SC: 'Sparx',
  SN: 'Sparx',
  BH: 'Bahamas',
}
