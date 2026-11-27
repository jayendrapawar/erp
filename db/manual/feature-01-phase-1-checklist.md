# Feature 01, Phase 1 manual checks

No test runner is configured in this repository. Run these checks against a disposable development database after migrations 0011–0013 have been applied by an authorized operator.

- `normalizeArticleValue('  ab  12  ')` returns `AB 12`.
- `parseSizeText('6-10')` returns `['6', '7', '8', '9', '10']`.
- `parseSizeText('11,12,13,1')` returns `['11', '12', '13', '1']`.
- `hasArticleNumberMismatch('Sandal 42', 'AB42L')` is false; `hasArticleNumberMismatch('Sandal 41', 'AB42L')` is true.
- Numeric article digits ignore leading zeroes: `SM-717` vs `SX0717G`, `SFG-49` vs `SF0049G`, and `SS-856` vs `SS0856G` are not mismatches; `SM-718` vs `SX0717G` is a mismatch.
- Scan a valid QR and confirm normal scan grouping and duplicate QR behavior are unchanged.
- Scan a valid QR whose normalized article code exists and confirm its MRP is added once to `article_mrps`; repeat the scan and confirm the scan succeeds without duplicating the MRP.
- Verify master checks return duplicate before known/new-colour/unknown classification.
- Link an exact code/colour pair, link a blank-code same-name/colour row, create a sibling code for a known name/colour, add a new colour under a known name, and create a wholly new article.
- Verify missing scanned sizes return `SIZE_NOT_IN_ARTICLE`, then explicitly add the size and retry. Verify a name/code digit mismatch requires confirmation.
- Import normalized duplicate code/colour rows and name/colour fallback rows; confirm duplicate sizes are unioned. Confirm a database uniqueness conflict rolls back the full import and returns the friendly duplicate message.
- Trigger the unique index conflict from concurrent inserts and confirm save/import return the friendly duplicate message.

## Phase 2 browser checks

- Scan a valid QR with a known article and confirm it saves through the usual success feedback, daily count, last-scan card, and recent-scans refresh.
- Scan a duplicate QR and confirm the existing duplicate message appears and the camera resumes.
- Scan an unknown article. Confirm the “New Article Detected” dialog shows read-only QR values, offers name autocomplete and colour selection, and suggests editable sizes from the code's final letter.
- Scan a code for a known article with a new colour. Confirm the existing article name is locked and shown, and the colour field offers existing colours plus “Other”.
- While the dialog is open, hold another QR in front of the camera and confirm it is not decoded. Close the dialog, choose “Save scan, add details later”, and confirm the scan is saved once and scanning resumes.
- Use “Create / Link” for both a new article and an existing article/colour. Confirm each saved scan updates the success feedback, daily count, last-scan card, and recent-scans list.
- Enter a mismatching article name and confirm the inline warning requires “Confirm and continue”; enter a size absent from a linked article and confirm its sizes are listed and “Add size X to this article” saves it.
- Make the master check unavailable while keeping scan recording available; confirm scanning falls back to the normal save path. Also check image upload, manual entry, and offline scanning still follow their existing flows.
