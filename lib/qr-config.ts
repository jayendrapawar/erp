// Division SUGGESTION from an article code (owner rule, 19 Nov 2026: "mostly"):
//   S… → Sparx, P… → Flite PU, F… → Flite EVA, anything else → Bahamas.
// Used to suggest a division (new-article dialog, purchase bills). The article master's `division`
// and a bill's division chosen on screen win; never store this hint as fact.
export function divisionForArticleCode(articleCode: string): string {
  const c = (articleCode ?? '').trim().toUpperCase()
  if (!c) return ''
  switch (c[0]) {
    case 'S': return 'Sparx'
    case 'P': return 'Flite PU'
    case 'F': return 'Flite EVA'
    default: return 'Bahamas'
  }
}
