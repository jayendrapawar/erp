// QR regression corpus supplied by Shayona on 18 Nov 2026.
// Expected values were derived by hand from each label, not from the parser.
// Never delete a sample: add new ones when a new label layout appears.

export interface BoxExpectation {
  raw: string
  format: string
  art: string
  colour: string
  size: string
  mrp: number
  mfg: string // MM/YYYY
  serial: string
  group?: string
}

export interface CartonExpectation {
  raw: string
  format: string
  art: string
  colour: string
  sizeFrom: string
  sizeTo: string
  mrp: number
  date: string // yyyy-mm-dd
  serial: string
  group?: string
}

const S = 'relaxo.box.a1.short'
const E = 'relaxo.box.a1.ean'
const N = 'relaxo.box.a1.ean-nocode'
const CC = 'relaxo.carton.compact'
const CH = 'relaxo.carton.hyphen'

export const BOX_SAMPLES: BoxExpectation[] = [
  // PU and related
  { raw: 'A1PUGN42G-WHWH0006-0726R10MA0-339.50-1010-Z76BA-1006101722', format: S, art: 'PUGN42G', colour: 'WHWH', size: '6', mrp: 339.5, mfg: '07/2026', serial: '1006101722', group: 'PUGN42G' },
  { raw: 'A1PUGN42G-WHWH0006-0726R10MA0-339.50-1010-LE69Q-1006101721', format: S, art: 'PUGN42G', colour: 'WHWH', size: '6', mrp: 339.5, mfg: '07/2026', serial: '1006101721', group: 'PUGN42G' },
  { raw: 'A1PUGN42G-WHWH0006-0726R10MA0-339.50-1010-E33T4-1006101726', format: S, art: 'PUGN42G', colour: 'WHWH', size: '6', mrp: 339.5, mfg: '07/2026', serial: '1006101726', group: 'PUGN42G' },
  { raw: 'A1PUGN42G-WHWH0006-0726R10MA0-339.50-1010-HN7BQ-1006101724', format: S, art: 'PUGN42G', colour: 'WHWH', size: '6', mrp: 339.5, mfg: '07/2026', serial: '1006101724', group: 'PUGN42G' },
  { raw: 'A1PUGN42G-WHWH0008-0726R10MA0-339.50-1010-CJASC-1006106444', format: S, art: 'PUGN42G', colour: 'WHWH', size: '8', mrp: 339.5, mfg: '07/2026', serial: '1006106444', group: 'PUGN42G' },
  { raw: 'A1PUGN42G-WHWH0008-0726R10MA0-339.50-1010-ARJ9F-1006106443', format: S, art: 'PUGN42G', colour: 'WHWH', size: '8', mrp: 339.5, mfg: '07/2026', serial: '1006106443', group: 'PUGN42G' },
  { raw: 'A1PUGN42G-WHWH0008-0726R10MA0-339.50-1010-W95TE-1006106442', format: S, art: 'PUGN42G', colour: 'WHWH', size: '8', mrp: 339.5, mfg: '07/2026', serial: '1006106442', group: 'PUGN42G' },
  { raw: 'A1PUG195G-BKBK0010-0726R10MA0-479.50-1010-AEBM6-0978637586', format: S, art: 'PUG195G', colour: 'BKBK', size: '10', mrp: 479.5, mfg: '07/2026', serial: '0978637586', group: 'PUG195G' },
  { raw: 'A1PUG195G-BKBK0010-0726R10MA0-479.50-1010-M74XA-0978637590', format: S, art: 'PUG195G', colour: 'BKBK', size: '10', mrp: 479.5, mfg: '07/2026', serial: '0978637590', group: 'PUG195G' },
  { raw: 'A1PUG195G-BKBK0008-0726R10MA0-479.50-1010-HC2YM-0978637111', format: S, art: 'PUG195G', colour: 'BKBK', size: '8', mrp: 479.5, mfg: '07/2026', serial: '0978637111', group: 'PUG195G' },
  { raw: 'A1PUG195G-BKBK0008-0726R10MA0-479.50-1010-ED2A4-0978637113', format: S, art: 'PUG195G', colour: 'BKBK', size: '8', mrp: 479.5, mfg: '07/2026', serial: '0978637113', group: 'PUG195G' },
  { raw: 'A1PUG195G-BKBK0008-0726R10MA0-479.50-1010-719IM-0978637112', format: S, art: 'PUG195G', colour: 'BKBK', size: '8', mrp: 479.5, mfg: '07/2026', serial: '0978637112', group: 'PUG195G' },
  { raw: 'A1PUGN42G-WHWH0007-0126R10MA0-269.50-1010-D4EY2-0881589339', format: S, art: 'PUGN42G', colour: 'WHWH', size: '7', mrp: 269.5, mfg: '01/2026', serial: '0881589339' },
  { raw: 'A1PUG178G-BRBR0006-0126R10MA0-269.50-1010-2YDFS-0909385226', format: S, art: 'PUG178G', colour: 'BRBR', size: '6', mrp: 269.5, mfg: '01/2026', serial: '0909385226' },
  { raw: 'A1PUG091G-BKBK0007-0725R10MA0-329.50-1010-9S6Q2-0763923071', format: S, art: 'PUG091G', colour: 'BKBK', size: '7', mrp: 329.5, mfg: '07/2025', serial: '0763923071' },
  { raw: 'A1PUG096G-BKBK0008-0724R10MA0-349.50-8907639918091-1010-201012152-5PLFI-0559678848', format: E, art: 'PUG096G', colour: 'BKBK', size: '8', mrp: 349.5, mfg: '07/2024', serial: '0559678848' },
  { raw: 'A1PUG146G-BKBK0009-0724R10MA0-309.50-8905495250003-1010-201000515-NNRZA-0555894981', format: E, art: 'PUG146G', colour: 'BKBK', size: '9', mrp: 309.5, mfg: '07/2024', serial: '0555894981' },
  { raw: 'A1PUG146G-OLOL0009-0124R10MA0-309.50-8905495249908-1010-200789306-0420292590', format: N, art: 'PUG146G', colour: 'OLOL', size: '9', mrp: 309.5, mfg: '01/2024', serial: '0420292590' },
  // Flite
  { raw: 'A1FL0020L-BKBK0004-0726R04MA0-239.50-1004-85G16-0989647546', format: S, art: 'FL0020L', colour: 'BKBK', size: '4', mrp: 239.5, mfg: '07/2026', serial: '0989647546', group: 'FL0020L' },
  { raw: 'A1FL0020L-BKBK0004-0726R04MA0-239.50-1004-XVAD7-0989647548', format: S, art: 'FL0020L', colour: 'BKBK', size: '4', mrp: 239.5, mfg: '07/2026', serial: '0989647548', group: 'FL0020L' },
  { raw: 'A1FL0020L-BKBK0004-0726R04MA0-239.50-1004-AHRY8-0989647549', format: S, art: 'FL0020L', colour: 'BKBK', size: '4', mrp: 239.5, mfg: '07/2026', serial: '0989647549', group: 'FL0020L' },
  { raw: 'A1FL0020L-BKBK0005-0726R04MA0-239.50-1004-AV5Q8-0989647753', format: S, art: 'FL0020L', colour: 'BKBK', size: '5', mrp: 239.5, mfg: '07/2026', serial: '0989647753', group: 'FL0020L' },
  { raw: 'A1FL0020L-BKBK0005-0726R04MA0-239.50-1004-HV2YT-0989647750', format: S, art: 'FL0020L', colour: 'BKBK', size: '5', mrp: 239.5, mfg: '07/2026', serial: '0989647750', group: 'FL0020L' },
  { raw: 'A1FL0548L-SASA0006-0426R06MA0-289.50-1006-979G6-0962069901', format: S, art: 'FL0548L', colour: 'SASA', size: '6', mrp: 289.5, mfg: '04/2026', serial: '0962069901' },
  { raw: 'A1FL0291L-BKRD0004-0426R06MA1-249.50-1006-7P1YT-0961906670', format: S, art: 'FL0291L', colour: 'BKRD', size: '4', mrp: 249.5, mfg: '04/2026', serial: '0961906670' },
  { raw: 'A1FL0532L-TUTU0006-0426R06MA2-219.50-1006-XGYHA-0964254849', format: S, art: 'FL0532L', colour: 'TUTU', size: '6', mrp: 219.5, mfg: '04/2026', serial: '0964254849' },
  { raw: 'A1FL2020G-BKWH0008-0724R06MA0-549.50-8904215942648-1006-201096810-QA247-0585080490', format: E, art: 'FL2020G', colour: 'BKWH', size: '8', mrp: 549.5, mfg: '07/2024', serial: '0585080490' },
  // Sparx
  { raw: 'A1SF0204G-GYBK0006-1026R11MA0-339.50-1011-WJL73-1025067708', format: S, art: 'SF0204G', colour: 'GYBK', size: '6', mrp: 339.5, mfg: '10/2026', serial: '1025067708', group: 'SF0204G' },
  { raw: 'A1SF0204G-GYBK0006-1026R11MA0-339.50-1011-AYLH8-1025067716', format: S, art: 'SF0204G', colour: 'GYBK', size: '6', mrp: 339.5, mfg: '10/2026', serial: '1025067716', group: 'SF0204G' },
  { raw: 'A1SF0204G-GYBK0006-1026R11MA0-339.50-1011-KAZA7-1025067732', format: S, art: 'SF0204G', colour: 'GYBK', size: '6', mrp: 339.5, mfg: '10/2026', serial: '1025067732', group: 'SF0204G' },
  { raw: 'A1SF0204G-GYBK0007-1026R11MA0-339.50-1011-AA7KA-1026217463', format: S, art: 'SF0204G', colour: 'GYBK', size: '7', mrp: 339.5, mfg: '10/2026', serial: '1026217463', group: 'SF0204G' },
  { raw: 'A1SF0204G-GYBK0007-1026R11MA0-339.50-1011-J5JVA-1026217421', format: S, art: 'SF0204G', colour: 'GYBK', size: '7', mrp: 339.5, mfg: '10/2026', serial: '1026217421', group: 'SF0204G' },
  { raw: 'A1SS0703G-NBOR0007-1026R05MA0-649.00-1005-44GSY-1020602214', format: S, art: 'SS0703G', colour: 'NBOR', size: '7', mrp: 649, mfg: '10/2026', serial: '1020602214', group: 'SS0703G' },
  { raw: 'A1SS0703G-NBOR0008-1026R05MA0-649.00-1005-M6I9H-1020600799', format: S, art: 'SS0703G', colour: 'NBOR', size: '8', mrp: 649, mfg: '10/2026', serial: '1020600799', group: 'SS0703G' },
  { raw: 'A1SS0703G-NBOR0010-1026R05MA0-649.00-1005-G11IX-1020601896', format: S, art: 'SS0703G', colour: 'NBOR', size: '10', mrp: 649, mfg: '10/2026', serial: '1020601896', group: 'SS0703G' },
  { raw: 'A1SS0703G-NBOR0008-1026R05MA0-649.00-1005-G4FVP-1020600800', format: S, art: 'SS0703G', colour: 'NBOR', size: '8', mrp: 649, mfg: '10/2026', serial: '1020600800', group: 'SS0703G' },
  { raw: 'A1SS0703G-NBOR0007-1026R05MA0-649.00-1005-A2PB1-1020602164', format: S, art: 'SS0703G', colour: 'NBOR', size: '7', mrp: 649, mfg: '10/2026', serial: '1020602164', group: 'SS0703G' },
  { raw: 'A1SS0703G-NBOR0007-0126R05MA0-599.00-1005-VYBA3-0908490332', format: S, art: 'SS0703G', colour: 'NBOR', size: '7', mrp: 599, mfg: '01/2026', serial: '0908490332' },
  { raw: 'A1SS0703G-NBOR0007-0126R05MA0-599.00-1005-SCLHY-0908490324', format: S, art: 'SS0703G', colour: 'NBOR', size: '7', mrp: 599, mfg: '01/2026', serial: '0908490324' },
  // Other
  { raw: 'A1PUC003G-TNTN0008-0725R10MA0-434.50-1010-LUF59-0791662646', format: S, art: 'PUC003G', colour: 'TNTN', size: '8', mrp: 434.5, mfg: '07/2025', serial: '0791662646', group: 'PUC003G' },
  { raw: 'A1RH0005G-OLBK0007-0125R01MA0-169.50-8905495614034-1001-201328063-5XR97-0660847619', format: E, art: 'RH0005G', colour: 'OLBK', size: '7', mrp: 169.5, mfg: '01/2025', serial: '0660847619', group: 'RH0005G' },
  { raw: 'A1SF0204G-GYBK0006-0426R11MA1-339.50-1011-GLR1L-0945039036', format: S, art: 'SF0204G', colour: 'GYBK', size: '6', mrp: 339.5, mfg: '04/2026', serial: '0945039036' },
]

/** URL-wrapped scans and the plain label each one is believed to be. */
export const URL_WRAPPED: Array<{ raw: string; samePlainLabel: string }> = [
  { raw: 'https://a1fl0548l-sasa0006-0426r06ma0-289.50-1006-979g6-0962069901/', samePlainLabel: 'A1FL0548L-SASA0006-0426R06MA0-289.50-1006-979G6-0962069901' },
  { raw: 'https://a1fl0291l-bkrd0004-0426r06ma1-249.50-1006-7p1yt-0961906670/', samePlainLabel: 'A1FL0291L-BKRD0004-0426R06MA1-249.50-1006-7P1YT-0961906670' },
  { raw: 'https://a1fl0532l-tutu0006-0426r06ma2-219.50-1006-xgyha-0964254849/', samePlainLabel: 'A1FL0532L-TUTU0006-0426R06MA2-219.50-1006-XGYHA-0964254849' },
  { raw: 'https://a1pugn42g-whwh0007-0126r10ma0-269.50-1010-d4ey2-0881589339/', samePlainLabel: 'A1PUGN42G-WHWH0007-0126R10MA0-269.50-1010-D4EY2-0881589339' },
  { raw: 'https://a1pug178g-brbr0006-0126r10ma0-269.50-1010-2ydfs-0909385226/', samePlainLabel: 'A1PUG178G-BRBR0006-0126R10MA0-269.50-1010-2YDFS-0909385226' },
  { raw: 'https://a1ss0703g-nbor0007-0126r05ma0-599.00-1005-vyba3-0908490332/', samePlainLabel: 'A1SS0703G-NBOR0007-0126R05MA0-599.00-1005-VYBA3-0908490332' },
  { raw: 'https://a1ss0703g-nbor0007-0126r05ma0-599.00-1005-sclhy-0908490324/', samePlainLabel: 'A1SS0703G-NBOR0007-0126R05MA0-599.00-1005-SCLHY-0908490324' },
  { raw: 'https://a1pug091g-bkbk0007-0725r10ma0-329.50-1010-9s6q2-0763923071/', samePlainLabel: 'A1PUG091G-BKBK0007-0725R10MA0-329.50-1010-9S6Q2-0763923071' },
  { raw: 'https://a1fl2020g-bkwh0008-0724r06ma0-549.50-8904215942648-1006-201096810-qa247-0585080490/', samePlainLabel: 'A1FL2020G-BKWH0008-0724R06MA0-549.50-8904215942648-1006-201096810-QA247-0585080490' },
  { raw: 'https://a1pug096g-bkbk0008-0724r10ma0-349.50-8907639918091-1010-201012152-5plfi-0559678848/', samePlainLabel: 'A1PUG096G-BKBK0008-0724R10MA0-349.50-8907639918091-1010-201012152-5PLFI-0559678848' },
  { raw: 'https://a1pug146g-bkbk0009-0724r10ma0-309.50-8905495250003-1010-201000515-nnrza-0555894981/', samePlainLabel: 'A1PUG146G-BKBK0009-0724R10MA0-309.50-8905495250003-1010-201000515-NNRZA-0555894981' },
]

export const CARTON_SAMPLES: CartonExpectation[] = [
  { raw: 'SS0703GBKRD0610A649.000310202610051018424593', format: CC, art: 'SS0703G', colour: 'BKRD', sizeFrom: '6', sizeTo: '10', mrp: 649, date: '2026-10-03', serial: '1018424593' },
  { raw: 'SS0703GBKRD0610A649.002108202610051000654956', format: CC, art: 'SS0703G', colour: 'BKRD', sizeFrom: '6', sizeTo: '10', mrp: 649, date: '2026-08-21', serial: '1000654956' },
  { raw: 'SS0703GNBOR0610A649.002109202610051014041536', format: CC, art: 'SS0703G', colour: 'NBOR', sizeFrom: '6', sizeTo: '10', mrp: 649, date: '2026-09-21', serial: '1014041536' },
  { raw: 'PUL046LCPCP0407A284.503005202610100958288974', format: CC, art: 'PUL046L', colour: 'CPCP', sizeFrom: '4', sizeTo: '7', mrp: 284.5, date: '2026-05-30', serial: '0958288974' },
  { raw: 'PUGN42GWHWH0608A339.500109202610101004961646', format: CC, art: 'PUGN42G', colour: 'WHWH', sizeFrom: '6', sizeTo: '8', mrp: 339.5, date: '2026-09-01', serial: '1004961646', group: 'PUGN42G' },
  { raw: 'PUG105GBKBK0710A339.500607202610100979825820', format: CC, art: 'PUG105G', colour: 'BKBK', sizeFrom: '7', sizeTo: '10', mrp: 339.5, date: '2026-07-06', serial: '0979825820' },
  { raw: 'PUG185GBKBK0610A419.501807202610100986478702', format: CC, art: 'PUG185G', colour: 'BKBK', sizeFrom: '6', sizeTo: '10', mrp: 419.5, date: '2026-07-18', serial: '0986478702' },
  { raw: 'PUG195GBKBK0710A479.500307202610100978626632', format: CC, art: 'PUG195G', colour: 'BKBK', sizeFrom: '7', sizeTo: '10', mrp: 479.5, date: '2026-07-03', serial: '0978626632', group: 'PUG195G' },
  { raw: 'PFG006GTNTN0609A489.500310202610101018422299', format: CC, art: 'PFG006G', colour: 'TNTN', sizeFrom: '6', sizeTo: '9', mrp: 489.5, date: '2026-10-03', serial: '1018422299' },
  { raw: 'PUG202GOLOL0610A369.501710202610101025511962', format: CC, art: 'PUG202G', colour: 'OLOL', sizeFrom: '6', sizeTo: '10', mrp: 369.5, date: '2026-10-17', serial: '1025511962' },
  { raw: 'PUL205LCPCP0407A309.50160820261010997683057', format: CC, art: 'PUL205L', colour: 'CPCP', sizeFrom: '4', sizeTo: '7', mrp: 309.5, date: '2026-08-16', serial: '997683057' },
  { raw: 'FL0020L-BKBK0405239.5024072026100300985036150', format: CH, art: 'FL0020L', colour: 'BKBK', sizeFrom: '4', sizeTo: '5', mrp: 239.5, date: '2026-07-24', serial: '0985036150', group: 'FL0020L' },
  { raw: 'FLN115G-BKRD0610229.5001062026100300958790769', format: CH, art: 'FLN115G', colour: 'BKRD', sizeFrom: '6', sizeTo: '10', mrp: 229.5, date: '2026-06-01', serial: '0958790769' },
  { raw: 'SF0204G-GYBK0610339.50211020261SQ7T1027217173', format: CH, art: 'SF0204G', colour: 'GYBK', sizeFrom: '6', sizeTo: '10', mrp: 339.5, date: '2026-10-21', serial: '1027217173', group: 'SF0204G' },
  { raw: 'SS0703GNBOR0610A649.000710202610051020596765', format: CC, art: 'SS0703G', colour: 'NBOR', sizeFrom: '6', sizeTo: '10', mrp: 649, date: '2026-10-07', serial: '1020596765', group: 'SS0703G' },
  { raw: 'SS0703GNBOR0609A599.001203202610050908489985', format: CC, art: 'SS0703G', colour: 'NBOR', sizeFrom: '6', sizeTo: '9', mrp: 599, date: '2026-03-12', serial: '0908489985' },
  { raw: 'SF0234GDGGE0610A649.000410202610081018976220', format: CC, art: 'SF0234G', colour: 'DGGE', sizeFrom: '6', sizeTo: '10', mrp: 649, date: '2026-10-04', serial: '1018976220' },
  { raw: 'PUL205LBKBK0407A309.500205202610100940771187', format: CC, art: 'PUL205L', colour: 'BKBK', sizeFrom: '4', sizeTo: '7', mrp: 309.5, date: '2026-05-02', serial: '0940771187' },
  { raw: 'SD0364LGEPK0407A749.001808202610060998351254', format: CC, art: 'SD0364L', colour: 'GEPK', sizeFrom: '4', sizeTo: '7', mrp: 749, date: '2026-08-18', serial: '0998351254' },
  { raw: 'PUB070LNBNB0407A374.500808202510100779509157', format: CC, art: 'PUB070L', colour: 'NBNB', sizeFrom: '4', sizeTo: '7', mrp: 374.5, date: '2025-08-08', serial: '0779509157' },
  { raw: 'CU0025G-GYBK0710139.50250520263736J00953755256', format: CH, art: 'CU0025G', colour: 'GYBK', sizeFrom: '7', sizeTo: '10', mrp: 139.5, date: '2026-05-25', serial: '00953755256' },
  { raw: 'CU0025G-RDBK0610139.5013062026WC2WE00966845551', format: CH, art: 'CU0025G', colour: 'RDBK', sizeFrom: '6', sizeTo: '10', mrp: 139.5, date: '2026-06-13', serial: '00966845551' },
  { raw: 'RH0005G-OLBK0609169.5017012025100100655162729', format: CH, art: 'RH0005G', colour: 'OLBK', sizeFrom: '6', sizeTo: '9', mrp: 169.5, date: '2025-01-17', serial: '0655162729', group: 'RH0005G' },
  { raw: 'PUC003GTNTN0610A434.500209202510100792218169', format: CC, art: 'PUC003G', colour: 'TNTN', sizeFrom: '6', sizeTo: '10', mrp: 434.5, date: '2025-09-02', serial: '0792218169', group: 'PUC003G' },
]

/** Test labels found in the development database (format not seen in the supplied corpus). */
export const LEGACY_DEV_SAMPLES = [
  'SX0991G-BKRD08-1026-599',
  'SD0999G-BKRD12-1026-599',
]

export const MALFORMED: Array<{ name: string; raw: string; expectStatus: 'invalid' | 'unrecognised' | 'partial' }> = [
  { name: 'empty', raw: '   ', expectStatus: 'invalid' },
  { name: 'random text', raw: 'hello world', expectStatus: 'unrecognised' },
  { name: 'retail EAN barcode only', raw: '8905495614034', expectStatus: 'unrecognised' },
  { name: 'box with serial cut off', raw: 'A1PUGN42G-WHWH0006-0726R10MA0-339.50-1010-Z76BA', expectStatus: 'partial' },
  { name: 'box with an extra unknown field', raw: 'A1PUGN42G-WHWH0006-0726R10MA0-339.50-1010-Z76BA-1006101722-XYZ', expectStatus: 'partial' },
  { name: 'box with month 13', raw: 'A1PUGN42G-WHWH0006-1326R10MA0-339.50-1010-Z76BA-1006101722', expectStatus: 'invalid' },
  { name: 'box with missing separators', raw: 'A1PUGN42GWHWH00060726R10MA0339.501010Z76BA1006101722', expectStatus: 'unrecognised' },
  { name: 'box with zero MRP', raw: 'A1PUGN42G-WHWH0006-0726R10MA0-0.00-1010-Z76BA-1006101722', expectStatus: 'invalid' },
  { name: 'carton with impossible date', raw: 'SS0703GBKRD0610A649.003113202610051018424593', expectStatus: 'invalid' },
  { name: 'carton with reversed size range', raw: 'SS0703GBKRD1006A649.000310202610051018424593', expectStatus: 'invalid' },
  { name: 'carton cut short', raw: 'SS0703GBKRD0610A649.0003102026', expectStatus: 'unrecognised' },
  { name: 'unrelated URL', raw: 'https://example.com/pay?id=12', expectStatus: 'unrecognised' },
]
