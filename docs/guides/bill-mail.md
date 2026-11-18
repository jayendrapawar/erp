# Bills from mail — how to switch it on

Relaxo mails every purchase bill (PDF) to **shayonafootwear@yahoo.in** from
**sys_admin@relaxofootwear.com**. The app can read those mails and add each bill to
**Purchases → Bills** as expected stock. It only reads the mailbox; it never moves or deletes mail.

It stays **OFF** until you switch it on. Switch it on only when the stocktake of the whole warehouse
is complete.

---

## Part 1 — One time only: connect the mailbox (Vercel)

Needed once for the live site. Skip it if the Purchases screen does **not** say
"The mailbox is not connected on the server yet".

1. Open **vercel.com** and sign in.
2. Open the project of the live site → **Settings** → **Environment Variables**.
3. Add these four, each with **Production** ticked:

   | Name | Value |
   |---|---|
   | `BILL_MAIL_IMAP_HOST` | `imap.mail.yahoo.com` |
   | `BILL_MAIL_USER` | `shayonafootwear@yahoo.in` |
   | `BILL_MAIL_PASSWORD` | the Yahoo **app password** (see below) |
   | `BILL_MAIL_FROM` | `sys_admin@relaxofootwear.com` |

4. Go to **Deployments**, open the latest one, choose **Redeploy** (settings apply after a redeploy).

**Yahoo app password:** in Yahoo Mail → your name → **Account info** → **Account security** →
**Generate app password** → name it "shayona inventory" → copy the 16 letters. It is not your
normal Yahoo password. If you ever think it leaked, delete it there, make a new one, and replace
`BILL_MAIL_PASSWORD` in Vercel (then Redeploy).

---

## Part 2 — Switch it on (in the app, any time, no Vercel)

You need the **Admin** role.

1. Open the app → **Home → Purchases** → tab **Bills**.
2. At the top: **"Bills from mail: OFF"** → press **Turn on…**
3. Choose the date to start from — normally **the day the stocktake was completed**.
   Bills mailed before that date are never imported.
4. Tick **"The stocktake of the whole warehouse is complete"** → **Turn on**.
5. The box turns green: **"Bills from mail: ON"**. A **Check mail** button appears.

## Every day

Press **Check mail** on Purchases → Bills. New bills appear in the list with their expected
arrival date (bill date + 5 days). Pressing it twice never adds a bill twice. If it says
"more — press Check mail again", press it again.

## Change or stop

- **Change date** — same place; only affects mails not imported yet.
- **Turn off** — stops reading mail. Bills already imported stay.

Every switch on / off / date change is recorded with who did it.

## If something goes wrong

| Message | What to do |
|---|---|
| "The mailbox is not connected on the server yet" | Do Part 1. |
| "Could not sign in to the mailbox … Check the app password" | Make a new Yahoo app password and replace `BILL_MAIL_PASSWORD` in Vercel, then Redeploy. |
| A bill shows "not saved" with a reason | Download that PDF from the mail and use **Upload bill PDFs**; if it still fails, keep the PDF for checking. |
| No **Turn on…** button | Your account needs the Admin role (Master → Users). |
