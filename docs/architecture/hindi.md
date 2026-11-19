# Hindi screens

The हिंदी button (phone: **More → हिंदी**; computer: top-right) switches the whole app to Hindi.
The choice is kept on that phone or browser (`localStorage` key `shayona.language`); nothing is stored in the database.

## How it works

| Part | File | Job |
|---|---|---|
| Phrase book | `lib/i18n/hi.json` | English text exactly as shown on screen → Hindi. `{0}`, `{1}` stand for parts that change (numbers, names). |
| Translator | `lib/i18n/translator.ts` | Looks text up in the phrase book (pure, unit-tested in `tests/i18n/translator.test.ts`). |
| Screen swap | `lib/i18n/dom-translate.ts` | While Hindi is on, swaps English text, placeholders, titles and pop-ups (`confirm`/`alert`) for Hindi, and swaps back when English is chosen. |
| Switch | `lib/language-context.tsx` | Remembers the choice and loads the phrase book only when Hindi is chosen (about 22 KB compressed; English users never download it). |

The Scanner, Reports dashboard, Home and phone menu also use the older `t('key')` texts in `lib/translations.ts`; both work together.

Text that is not in the phrase book stays as it is. So article codes, colour names, party names, people's names and numbers are never changed.
Put `data-no-translate` on an element if a word in it must never be translated.

No server, database or network work is added: the swap runs in the phone's browser.

## Adding a screen or message

1. Write the English text as usual.
2. Run `node scripts/i18n/missing-hindi.cjs` to list English phrases without Hindi. Some hits are not UI text (CSS, file names, print templates, developer-only errors); skip those.
3. Add the missing phrases to `lib/i18n/hi.json`. For text built from parts, add the pattern, e.g. `"Show more ({0} left)": "और दिखाएं ({0} बाकी)"`.
4. Run `npm test`. It checks that every Hindi entry uses only the placeholders of its English text.

Not translated on purpose: printed bills (they already carry the Hindi shop name), catalogue-import review notes (written once, at import, for the admin), and developer-only messages.
