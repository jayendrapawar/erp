# Reliability and speed (22 Nov 2026)

Owner reported: logged out by itself, slow page changes, laggy screens. Causes found and fixed:

| Symptom | Cause | Fix |
|---|---|---|
| "Logged out by itself" | Ten pages wrapped the sign-in check (and the Orders hub its whole data load) in `try { … } catch { redirect('/sign-in') }`, so ANY database error — Neon waking from sleep, a dropped connection — sent the user to sign-in although the session was valid. The pool also gave up connecting after 5 s. | `requirePageUser()` / `getSessionUser()` in `lib/authz.ts`: sign-in only when there is no session; database errors are retried once (`withDbRetry`, `lib/db/index.ts`), then shown by `app/error.tsx` ("Connecting…", auto retry, Try again). Connect timeout 15 s. |
| Random server errors | No `'error'` listener on the pg pool: when Neon closes an idle connection (sleep), node-postgres emits `'error'` and the process crashed. | `pool.on('error', …)` logs and carries on; `keepAlive`. |
| Slow page change | Every page change ran the sign-in check twice (page + menu shell) = 4 queries; no loading screen, so the old page sat frozen until the new one was ready. | Session copy in a signed cookie for 5 min (`cookieCache`, `lib/auth.ts`); page and shell share one cached lookup → 1 query (roles) per page change. `app/loading.tsx` shows at once. |
| Laggy screens | Orders → Overview loaded every order ever placed; Master → Articles and the overview drew all rows twice (phone + computer layouts) and redrew them on every key press. | Overview: open orders + last 60 days (max 2000). Lists draw 100 rows with "Show more" (`components/show-more.tsx`); filters still search all rows. |

Also: Next.js 16.2.6 → 16.4.5 and Better Auth 1.6.25 → 1.7.18 (critical security advisories,
including Server Actions issues that applied to this app).

## Rules for new code

- Pages: `const u = await requirePageUser({ anyRole: [...] })`. Never `catch → redirect('/sign-in')`.
- Reads on hot paths can use `withDbRetry(fn)`; never wrap writes (a retried write could happen twice).
- Lists that can grow: limit in SQL, and draw with `useShowMore` or pages.
- Design for the database sleeping (Neon free plan, 5 min): first request after a pause pays ~1–3 s.
  Measured 22 Nov from India on the dev branch: connect 1.7 s asleep vs 0.5 s awake (+ network).

## Orders speed (22 Nov 2026)

| Change | Queries per action, before → after | Notes |
|---|---|---|
| Salesman order lists capped (`lib/orders/order-list.ts`) | 1 → 1, but every order ever → open orders + delivered/cancelled of the last 60 days, max 2000 | Salesman page and the admin "Salesman" tab. **A salesman sees only his own orders** (owner, 22 Nov 2026); admin and accountant see all. "Load older orders" fetches 100 more per press (keyset on orderedAt, id), also when the list is empty, so no history is lost. |
| Admin Orders hub loads one tab at a time (`app/orders/admin/tab-data.ts`, `GET /api/orders/admin-tab?tab=`) | open the page: 12 → 4 (Overview only); first open of another tab: 1 request, 1–4 queries; switching back: 0 (kept in memory) + 1 background refresh; salesman 30 s auto-refresh: whole page (12) → open tab only | A GET route, not server actions (the browser runs those one at a time). Skeleton while a tab loads; error with "Try again". Catalogue (browser cache + `/api/catalogue`) only for Salesman and Biller; vendors only for Biller and Dispatcher. Biller stays mounted once loaded (scanner state). A save that re-renders the page refetches the open tab, so no tab shows data older than the last time it was opened. The address `#tab` still works; the server cannot see it, so opening `/orders/admin#picker` directly shows a skeleton, then the tab. |
| Saves (`app/actions/orders.ts`, salesman and admin screens) | salesman create/edit: action + 1.2 s wait + an extra `router.refresh()` (whole page again) → action only; the saved order (returned by the action) is in the list at once with a short "Order created" note | **Why `revalidatePath` stays:** in Next.js a save that calls it for any path re-renders the page the user is on, and the standalone Picker / Biller / Dispatcher pages need it to show the change. Since the admin page now renders only Overview (4 queries) and the open tab refetches itself, that re-render is cheap; dropping it per page would save little and risk stale screens. Picker assign/unassign show at once and **roll back with the reason** if the server refuses (they did not before). **Correctness fixes:** cancel and edit check the status in the same locked step as the change (an order packed in between is not cancelled / edited from an old status); assign/unassign decide the status in one statement (unassigning could send a just-packed order back to pending). |
| Dashboard stock (`getScannedInventoryView`, `getOverallStockView` in `app/actions/dashboard.ts`) | 2 server actions one after the other → 1 request (the pair runs in parallel on the server) | Same data, same permission checks. |
| `app/orders/loading.tsx` | — | Skeleton at once when moving between Orders pages (the root `app/loading.tsx` does not re-show inside the same section). |
