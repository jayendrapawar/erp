# Keyboard use (22 Nov 2026)

Goal: on a computer every screen can be used with the keyboard alone. Phones and touch screens
behave exactly as before (nothing here runs on a tap; confirm boxes stay the browser's own on touch).

Press **?** on any page for the list of shortcuts that work on that screen. It is built from the
registry below, so it is always current.

## Rules (the same on every screen)

1. **Not while typing.** Single keys (`n`, `j`, `?`…) and chords (`g h`) never fire while the cursor
   is in a text box, text area, select or contenteditable. **Ctrl / Cmd combinations and Esc do.**
2. **Dialogs.** While a dialog is open only that dialog's own shortcuts work (Esc, Ctrl+Enter, Ctrl+S).
   A dialog that does not use the registry switches every page shortcut off.
3. **Scanner and billing screens.** While a Scan box is on screen (Direct Billing, Purchases →
   Receive) and on the Scanner page, single-key shortcuts and Alt combinations are off; only Ctrl/Cmd
   combinations and Esc work. A barcode scanner types the code and Enter in a few milliseconds; keys
   typed while no text box has the cursor go to the Scan box (`useScanForwarder`), so no scan is
   lost. The "?" cheat sheet greys the switched-off shortcuts on these screens.
4. **mod** = Ctrl on Windows, Cmd on a Mac.
5. **Browser keys stay the browser's**: Ctrl R / T / W / L / F / G / N, Ctrl 1–9, Ctrl Tab, F5,
   Alt ← →, Alt D / F / Home cannot be registered (the registry refuses). Ctrl+P only on screens that
   print bills or pick lists (`allowPrint`); none takes it yet.
6. A key a focused control already used (`preventDefault`: a search list, the size matrix…) is left
   alone.
7. Letters work with any keyboard layout (Hindi InScript too): with a modifier held, the physical key
   counts.

## All shortcuts

### Everywhere (staff pages)

| Keys | Does |
|---|---|
| `↑ ↓ ← →` | Move to the nearest button, link or box in that direction (owner, 24 Nov 2026). Inside a dialog they stay in the dialog; ↑ ↓ stay in the menu or in the page, ← → move between them. Lists, tab bars, search lists, the size matrix and menus use the arrows first, then hand over at their ends. Text boxes: ← → move the caret until its ends; text areas: ↑ leaves from the first line, ↓ from the last; dropdowns: ↑ ↓ change the value, ← → leave; number boxes: ↑ ↓ change it; date boxes keep all arrows (Esc, then an arrow, to leave). Also on the scanner / billing screens (scanners never send arrows) |
| `Enter` | Press / select the focused button or link; ticks a focused checkbox; opens a focused dropdown |
| `Esc` | Leave the focused button or box (closes a dialog, a menu or a search list first); the next arrow carries on from there |
| `Ctrl K` | Jump to… a page or tab; `> ` actions on this page; `# ` find an order / bill number, retailer or article code |
| `?` | This list (also the **?** button in the sidebar) |
| `g` then `h` `o` `i` `s` `b` `p` `m` `r` | Go to Home, Orders, Inventory, Scanner, Billing, Purchases, Master, Reports (only pages your roles open; a "g…" hint shows; 1.5 s or Esc cancels) |
| `Ctrl B` | Menu narrow / wide (computers) |
| `Ctrl S`, `Ctrl Enter` | Save the form the cursor is in |
| `Tab` (first) | "Skip to content" link |

### Lists and tables

Orders overview, salesman orders, picker queue, biller Invoices and Receipts, dispatcher list, Inventory stock and movements, Master
users / retailers / suppliers / articles / assortments / sets, Purchases bills.

| Keys | Does |
|---|---|
| `↑ ↓` (on a row) / `j k` | Move the highlighted row (real focus; soft glow in both themes); past the first / last row the arrows move on to the buttons above / below. `→` on a row goes to its buttons |
| `Home` / `End` | First / last row shown; `↓` on the last row reaches "Show more" (Enter presses it) |
| `Enter` | Open the row (Master: edit; Users: role menu) |
| `Space` / `x` | Tick the row (Receipts: for mail) |
| `/` | Search / filter box of the list; `↓` from it goes to the first row |
| `n` / `Alt N` | New … (order, retailer, supplier, article, assortment, set) |

### Tabs

| Keys | Does |
|---|---|
| `Alt 1…9` | Tab 1…9: Orders hub (admin, or your order roles), Inventory, Master, Purchases |
| `Alt Shift 1…3` | Biller tabs (Invoices, Direct Billing, Receipts) — they sit inside the Orders hub |
| `← → Home End` | On a focused tab bar (role="tablist"); past the first / last tab the arrow leaves the bar |

### Dialogs and confirms

| Keys | Does |
|---|---|
| (opens) | Cursor in the first field; Tab / Shift+Tab stay inside |
| `Esc` | Close (same as a tap outside); focus returns to the button that opened it |
| `Ctrl Enter` | Save / confirm (the `data-primary` button, or the form) |
| `Ctrl S` | Save (not on destructive confirms) |
| `Enter` | Presses the focused button. Destructive confirms (delete order / article / set, clear bill, discard draft, stop mail, put back standard bill) open with **Cancel** focused, so a stray Enter is safe |
| — | After a failed save the cursor goes to the wrong field (the one the message names) |

### Screen-specific

| Screen | Keys |
|---|---|
| New Order (salesman) | Enter steps vendor → article → colour → sizes; 1–9 colour; ←→ quantity; Shift+Enter add and stay; Esc on Next Article / Add to Order or on a size button goes back to the size bar, Esc on the size bar skips the article; `Ctrl Enter` creates the order at once (no confirmation, as before). Tab also walks every quantity chip and box in the size matrix (Enter / Space press a chip; the highlighted size follows) and every line in the order (Enter edits it). "New" while New Order is open puts the cursor in the vendor search |
| Ctrl K `> ` actions | Create the order, Direct bill, Upload bill PDFs, New …, theme, language, menu width |
| Picker list (orders) | Keyboard changes wait for Enter (or leaving the list); Esc puts the old picker back. A mouse pick saves at once |
| Master role menu | Enter / Space opens, ↑↓ move, Space ticks, Esc / Tab close |

## For developers

Code: `lib/shortcuts/` (registry, hooks), `components/keyboard-help.tsx` (?), `command-palette.tsx`
(Ctrl K), `go-to-keys.tsx` (g chords), `dialog-keys.tsx`, `confirm-dialog.tsx`, `form-keys.tsx`.
Tests: `tests/shortcuts/*.test.ts` (rules, chord timeout, scopes, scanner screens, search, go-to).

- **Never** add `window.addEventListener('keydown')` for a shortcut. Use
  `useShortcut(keys, handler, { label, group, when, within, action })`. Return `false` from the
  handler for "not handled". `within: ref` = only while that part is on screen (hidden tabs stay mounted).
- Keys a focused control handles itself: list them with `useShortcutHelp([...], { group })`.
- A list: `useListKeys(containerRef, { label, onNew, newLabel, tickable })`; put `data-list-row` on
  each row (phone card and table row), `data-row-open` on its open/edit button, `data-row-tick` on its
  tick, `data-show-more` on Show more.
- Tabs: `useTabKeys(tabs, setTab, { nested, within })`; hand-made tab bars: `role="tablist"`,
  `onKeyDown={tablistKeyDown}`, `{...tabProps(selected)}` per tab.
- A dialog: put `<DialogKeys onClose={close} label="…" />` as the first child of the overlay; mark the
  save button `data-primary` (`data-destructive` too for delete), and Cancel `data-autofocus` on
  destructive confirms. Error messages: `role="alert"`.
- Confirm: `await askConfirm({ message, confirmLabel, destructive })`, never `window.confirm`.
- A barcode Scan box: `useScanForwarder(ref, append)` (or `useScanBox(ref)`); a camera scanner page:
  `useScannerScreen()`.
- No click-only `div` / `span` / `tr`: a real `<button>` or link, or role + tabIndex + Enter / Space.

### Cost (AGENTS.md)

| Action | Queries | Notes |
|---|---|---|
| Any shortcut, ?, g-chord, list keys, dialog keys | 0 | browser only |
| Ctrl K pages / actions | 0 | from the menu and the registry |
| Ctrl K `# ` search | 1 statement (3 × LIMIT 10, UNION ALL) + session check | after 2+ characters, 250 ms debounce, older request cancelled; ~0.2 s warm on dev; not cached (orders change); `ILIKE '%…%'` on small tables, no new index (would need pg_trgm: not measured as needed) |
| Opening a found record | as the list's own page | the filter comes from `?f.column=…` (`useUrlFilters`) |

## Keyboard-only checklist (walk with the mouse unplugged)

Tested 22 Nov 2026 in Edge (headless, keys only, dev database) — results below. A real USB barcode
scanner was **not** available: scans were simulated by typing the code at ~4 ms per key + Enter.

| Job | Steps | Result |
|---|---|---|
| Sign in | Tab to the account, arrows, Tab, password, Enter (local test sign-in; the Google button is a normal button, not tested here) | ✅ |
| Take an order (salesman) | `g o` → Tab to **New** → Enter → vendor (type, Enter) → article (type, Enter) → colour (Enter) → sizes (type, Enter) → Shift+Enter → Tab to Create order or Ctrl+Enter | ✅ (Ctrl+Enter creates the order at once; the test stopped before it) |
| Assign a picker (admin) | `g o` → `/` type order no. → ↓ → Tab to the picker list → ↓ pick → Enter | ✅ (fixed: arrows no longer assign every picker on the way) |
| Scan and bill (biller) | `g b` → Alt+Shift+2 → (cursor in Scan box) → Shift+Tab retailer, type, Enter → scan → Tab to Generate bill → Enter | ✅ scans land in the Scan box even with focus on a button; no shortcut fired. Generate bill not pressed in the test |
| Print and mail a bill | Receipts (Alt+Shift+3) → j/k → x tick → Tab to mail → Enter; Enter on a row → preview → Tab to Print | ✅ tick; ⚠ mail and preview not re-tested end to end (no receipt left on dev at the time) |
| Receive a carton | `g p` → Alt+2 → scan | ✅ (code reaches the Scan box and is answered) |
| Correct stock | `g i` → Alt+2 → `/` Tab (code filter) → ↓ → Enter → Tab to a size → Enter → + Add / − Remove → Pairs → Reason → Ctrl+Enter | ✅ reachable; save not pressed in the test |
| Add a retailer | `g m` → Alt+2 → `n` → name → Ctrl+Enter ("Phone is required": cursor goes to Phone) → phone → Ctrl+Enter | ✅ saved |

## Every button reachable (Tab walk, 22 Nov 2026)

A browser script Tabs through each page and each dialog and lists visible, enabled controls that focus
never reaches (only Tab is pressed, nothing is changed). Result: **none**, for admin (24 pages: Home,
every Orders, Inventory, Purchases and Master tab, Reports, Scanner), salesman, picker, biller (all three
tabs), dispatcher and warehouse, and inside 19 dialogs (retailer, supplier, article, assortment, set,
shop access, photos, order details, article stock, purchase bill, bill preview, mail, by hand, drafts,
Ctrl K, ?, New Order). Focus never left an open dialog. The only pointer-only spot left is a click on a
size row of the New Order matrix, which only highlights that row; focusing any chip in it does the same.

### Arrow keys alone (24 Nov 2026)

A second script starts on each page with nothing focused and explores breadth-first with the arrow
keys only (never Enter; arrows that change a dropdown, number or date are skipped). Every control was
reached on Home, Orders (overview, salesman, biller, picker, dispatcher), Inventory (overview, stock),
Purchases (bills, receive), Master (users, retailers, suppliers, sets, bill template), Reports and
Scanner. Inventory → Movements: the second date box is reached with Esc + arrow (date boxes keep
their arrows). Code: `components/arrow-nav.tsx`, geometry `lib/shortcuts/spatial.ts`
(tests/shortcuts/spatial.test.ts).

## Still needs a mouse / not done

- Retailer shop (`/shop`, retailers' phones) is not part of this work.
- Biller order panel: "Delete Direct Bill" deletes on one tap with no confirm (unchanged).
- Biller scan-and-verify full-screen modal: keyboard-reachable, but its camera needs the screen.
- Article photos: choosing files opens the system file dialog (keyboard works there, but it is the
  operating system's).
