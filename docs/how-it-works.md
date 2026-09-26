# How it works

The detail behind the [README](../README.md): who can do what, how several people work at once, and every planning rule. All of the rules live in `backend/src/planning.ts` and are covered by `npm test`.

## Users, roles and sign-in

Users and roles live in the database and are managed by an administrator on
the **Users & roles** screen (the people icon in the top bar). A user can hold
several roles; a role is a set of permissions:

| Section | View | Edit |
|---|---|---|
| Dashboard | `dashboard.view` | - (nothing on it is saved) |
| Orders | `orders.view` | `orders.edit` - add, update, delete |
| Pre-production | `preproduction.view` | `preproduction.edit` - tick / untick |
| Post-production | `postproduction.view` | `postproduction.edit` - tick / untick packing |
| Production Log | `log.view` | `log.edit` - add, edit, delete entries |
| Calendar | `calendar.view` | `calendar.edit` - idle days |
| Line calendar | `lines.view` | - (orders are put on lines in Orders) |
| Assistant | `assistant.use` - the **Ask** button, bottom right of every page | - (it only ever reads) |
| Administration | | `admin.users` - users and roles |

Edit includes view. The built-in **Administrator** role always has every
permission; **Editor** and **Viewer** are ready-made and editable. The list
lives in `backend/src/permissions.ts`; every API route checks it
(`need(...)` in `server.ts`), the pages only hide what the user cannot use.

- Accounts are deactivated, never deleted. Deactivating one, or resetting its
  password, signs that user out everywhere at once (token version).
- Nobody can deactivate themselves, and at least one active user must keep
  Users & roles access.
- Anyone can change their own password (key icon). Passwords are stored only
  as scrypt hashes. A sign-in lasts 7 days (`SESSION_HOURS` in `.env`).
  Ten wrong passwords from one address lock it out for 15 minutes.
- Lost every administrator password? `cd backend; npm run set-login -- Admin "new password"`
  makes that user an active Administrator again.

## Several people at once

Every save goes straight to PostgreSQL - nothing is held in the browser.
Every open screen re-reads the database every 10 seconds, and at once when
someone switches back to the tab (`frontend/src/components/providers.tsx`).
Tabs in the background do not poll.

The pill at the top right pings `/api/health`, which asks the database, every
10 seconds: **Live · 12 ms** (green), **Slow** (amber, over 1 s), **Offline** or
**Database offline** (red - changes cannot be saved until it is back).
API responses are sent with `Cache-Control: no-store`, so no browser, proxy or
Cloudflare edge can serve an old copy.


---

## The planning rules

All of them live in `backend/src/planning.ts`, and nowhere else. The browser
never calculates a number itself.

| Figure | Rule |
|---|---|
| **Pace / day** | Average of **daily totals** (Day + Night + Overtime added first) over **every** day the order has been worked (base), or the last 3/5/7/10/14 worked days if chosen in Planning controls. A day with nothing logged is not a zero; a half idle day counts as half a day. Shown only while the order is running: started and not finished. |
| **Planning controls** | Dashboard. Left alone they are the **base rules**: pace over all worked days, 6-day week (Mon–Sat), plan as of today, calendar from the first production day. A change re-plans every screen at once - **for that viewer only**, never saved, back to base on reload or **Reset to base**. Sent to the API as `?paceDays=&workWeek=&asOf=&calendarStart=`; anything left out is the base. A banner on every page says when the view is not the base plan. Holidays and half days are idle days on the Calendar, not a working-week change. |
| **Target / day** | What the order **needs** per working day to finish on time: balance ÷ working days left up to the required delivery date, rounded up. Once that date has passed, the whole balance (shown red, tagged OVERDUE). Not typed in any more. |
| **Plan from** | A running order continues from today, or tomorrow once today's output is logged. An order not yet started cannot begin before its **Expected Scheduling Date** (the workbook's Planning Date, renamed 22 Sep 2026 - `planning_date` in the database) - nor while its line is still busy (see Line queue). |
| **Line** | Every order runs on one of **Line 1 - Line 10**, picked from a list when the order is created. A line runs one order at a time. Orders from before lines existed kept a line only if their old Factory / Line name ended in a number 1-10 (INA6 → Line 6); the rest show **No line** until updated. |
| **Line booking** | The days an order holds its line. Not started: its start date (buffer day included) to its required date - at the target it finishes on that date. Running: first production day to expected completion at its pace, so a **slower pace books the line longer and a faster one frees it sooner**. Finished: first to last production day. |
| **Not scheduled** | (25 Sep 2026, migration 010) The order form reads Order No, Style No / Colour, Order Qty / Unit, then **Required Delivery → Line → Expected Scheduling Date**. Line and Expected Scheduling Date may be left **empty** when the order is taken. Until both are filled in the order is *not scheduled*: it books no line, has no start date or pre-production due dates, and **nothing can be entered against it** - the API refuses pre-production ticks, production entries and packing (`code: "not-scheduled"`), and each page shows a popup naming what is missing, with **Fill them in now** (opens the order). They are filled in on the order form (the advisor's **Use Line N from …** fills both) or by dragging the order from the **Not scheduled** strip on the Line calendar onto a line and a day. Once anything has been ticked or logged, they cannot be emptied again. Its target is read as if it could start today. |
| **Line check** | When an order is created, or its line, dates or qty change, its booking may not clash with another order on that line. The form asks `GET /api/orders/check` as it is filled in and shows: whether the line is free, what it clashes with, the **earliest Expected Scheduling Date that fits** (one click to use it) and which other lines are free. The server checks again on save, inside a transaction, and refuses a clash. An order already running cannot wait, so it can only move to a free line. |
| **Line queue** | If work on a line runs over, orders not yet started on that line wait behind it: each is planned from the day after the one ahead of it ends, and its start date, target and pre-production dates move with it. Its start date then reads "after ORD-…". Two running orders booked on one line at once (production logged for both) are flagged with a red **!**, not moved. |
| **Projected finish** | Balance ÷ pace, in working days, counted from the plan-from day. A finished order ends on its last production date. |
| **Buffer** | Working days between projected finish and required date. + early, − late. |
| **Status** | COMPLETED → BEHIND SCHEDULE (projected after required, or no working day left) → AT RISK (1 working day or less to spare) → ON TRACK. With nothing made: NOT STARTED, or BEHIND SCHEDULE once the required date has passed. |
| **Expected completion** | Shown on the Calendar, Orders and Dashboard: the day the balance is finished at the current pace, counting forward over working days and skipping idle ones. |
| **Start date** | Order qty ÷ target per day = working days needed; counted back from the required delivery date (skipping non-working and idle days), then 1 more working day as a buffer. Shown on Orders, Dashboard and Pre-production. |
| **Pre-production** | Fabric received (expected start − 25 days), Cutting and Accessories (start − 7 days, calendar days; 10 / 3 / 3 until 22 Sep 2026). ✓ stamps the current date and time; ✕ clears a mistaken tick. Early / late = expected − ticked date; before the tick, days to go or overdue. Status: READY (all ticked), DELAYED n d (anything late or overdue), ON SCHEDULE. **Production can be logged (or an entry changed) only once all three are ticked** - the server refuses it otherwise, and the log form greys the order out. Once an order has production its ticks can no longer be cleared. |
| **Post-production** | Every order that has started production. Fabric, cutting and accessories are shown as ticked on Pre-production and **cannot be changed here**. **Packing** is due 4 calendar days after the order is complete (the day it finished; while still running, its expected completion - so that date moves with the pace). ✓ stamps the current date and time and is accepted only once production is complete; ✕ clears a mistaken tick. Status: OVERDUE, TO PACK, IN PRODUCTION, PACKED. |
| **Idle days** | Calendar → **Idle days**: mark one date or a range as **Half Day** or **Full Day**, for all lines or one line. A full idle day gives no working time, a half day half. Working days left, target, expected completion, buffer and line bookings are all counted on that time, and pace divides output by it, so a half day's short output is not read as a slow full day. Marking a date again replaces the earlier mark. |
| **Calendar range** | 7 days before the plan date, then 180 days ahead (scroll right). Anything older folds into one **+** column holding each order's total; click it to open those days. Never more than a year back. |
| **Calendar colour** | Each day is compared with what the order **needed that morning**: green met it, amber fell short, red was made after the required date. |
| **Line calendar** | One row per line, same range and **+** column as the Calendar. Each booked day is **green** up to the order's required date and **red** past it; the only number shown is what was **made** that day. A running order's booking follows its average pace and is worked out again with every entry, so a faster pace frees days for later orders and a slower one holds more (and turns red once past the required date). Amber: two orders produced on one line at once - but one finishing and the next starting on the same day is a changeover: that day is split between them in proportion to what each made (each part green or red by its own order's date, the new order's name starting in its part). Pinned on the left: the order running on the line today (never a finished one) and the day the line is free from. A search box finds orders by **style number** (or order no): only the lines carrying one are shown, the other orders on them in grey. |
| **Rolling average / Peak pace** | Two views of the Line calendar (`GET /api/lines?pace=peak`). **Rolling average** books running orders at their average daily output - the plan every other page uses. **Peak pace** books them at their target for their first 4 production days, then from the 5th day logged at their best day so far, rising whenever a day beats it (500, then 400 stays 500, then 700 makes it 700). Orders not started are booked the same in both, and can be moved in either view. |
| **Assistant** | A local agent behind the **Ask** button at the bottom right of every page (`assistant.use`) - deliberately not a tab of its own. The button carries a badge with how much is being raised, red when any of it is urgent; the panel opens over the page, stays open while you move between pages, and closes with Escape. Three tabs inside it: **Ask**, **Attention** and **Learned**. It answers typed questions from the same functions that draw every screen - orders, lines, pace, what was made, what is due, where a new order fits - so an answer can never disagree with the board. Every answer shows **how it read the question**, and a question it cannot place says so and offers the ones it knows instead of guessing. The board's answers are worked out on this machine and work with the internet down; the AI model (next row) is the only part that goes out. It only reads - it never changes an order. |
| **AI model** | On when `OLLAMA_API_KEY` is set in `backend/.env` (`OLLAMA_HOST` default `https://ollama.com`, `OLLAMA_MODEL` default `gpt-oss:120b`, which Ollama's free plan includes). `backend/src/ai.ts`. The board still answers first; the model answers too when a question wants writing or judgment ("write a status update", "what should we do", "why…"), when the board cannot place it, for a follow-up to an AI answer, or when **Ask AI** is pressed. Also the **AI action plan** (Attention tab) and **Ask AI** in the order form. **What leaves this machine**: with each AI question, a written brief of the board - every order's number, style, colour, line, quantities, dates, pre-production ticks and notes; each line's record; the last 14 days' output; idle days; what the board is raising - and the question with the last few exchanges. Never the database, passwords or user details. Its answers are labelled as the model's, with the board's own figures beside them, because it can still slip on a detail. 40 AI questions per person per hour; a model failure never fails the board's answer. |
| **Advisor** | `backend/src/advisor.ts` - where an order should go, by what each line has really made. Every line is judged from the earliest the order can start there: what it would need a day, against the line's own average (this style on this line when it has run it), as **comfortable / tight / a stretch / beyond its record / no record**, with working days to spare. Ranked: free and comfortable first, waiting counted against, a proven style run counted for. **Style family** (25 Sep 2026): the part of the style number before the "/" (OR675/11 and OR675/12 are family OR675). A line running that family now, or holding it straight before or after where the order would go (or the last order it ran), is set up for it, so it is **ranked first** - as long as it can still make the required date (not free only after it, not beyond its record). Otherwise the ranking is as before. A line's record for the family stands in for the exact style when that is thin. The AI is told the same rule. **Order form**: the pick and its reasons, **Use Line N** (sets the line, and the scheduling date when that line comes free later), **Compare all lines**, warnings - a target no line reaches (with the date the fastest would really finish), pre-production already due for the start it would get. **Line calendar**: as an order is picked up, the best spot is named above the grid and marked on its line; beside the cursor, each day hovered over is judged - green comfortable, amber tight or a stretch, red a clash, past the required date or beyond the line's record. It advises; the user still saves or drops. |
| **What it learns** | Only from the days logged here, and it sharpens with each one: every line's real output per day (average, best day, how much a day swings, whether it is rising or slowing), the same per style, and the **build-up curve** - what a new order makes on its first days as a share of what it later reaches. Nothing is a trained model: a factory this size logs tens of days, not the tens of thousands a fitted model would need, and every figure here can be traced back to the entries behind it. |
| **What it raises** | Ranked urgent / coming up / worth knowing, each with the numbers behind it and what to do: production locked by a missing tick, a milestone past due, an order that will miss its date (with the pace it would take), an order slowing down, a **target no line has ever reached**, an order that should have started, an order with no line, two orders on one line, packing due, a queued order that could start earlier on a free line, lines with nothing booked, and open orders needing more a day than the factory has ever averaged. It advises; you act. |
| **Moving orders** | Line calendar, for roles with `orders.edit`: an order **not started** can be dragged to another day and/or line (a dashed outline shows where it lands, red if past its required date). It then starts on the day it was dropped - never before today; `POST /api/orders/:id/move` sets its Expected Scheduling Date to match (`schedulingDateFor`), so its start date, target, pre-production dates and status follow everywhere. The **required delivery date does not move**: a later start means a higher target and frees the earlier days for another order. Refused, like any edit, if the line is taken on those days (with the free dates), if it would start after its required date, or once production is logged. The move carries the view it was dragged in (`pace`), so the days it counts as taken are the days that view draws - a day freed by the peak pace can be taken in the Peak pace view. What is saved does not depend on the view (an order not started has no pace of its own); the rolling plan every other page reads then queues it behind whatever is still running. Clicking such an order opens its Update form. |

### What changed from the workbook, on purpose

- Pace was an average of individual log entries, so a Day + Night day halved it.
- Target / day was a typed number; it is now calculated.
- Planning Date was never used; now an unstarted order is planned from it, and it is called Expected Scheduling Date.
- An order with nothing made stayed NOT STARTED even past its delivery date.
- Days left were working days but buffer and AT RISK were calendar days.
- The dashboard "average per day" divided by calendar days, Sundays included.
- The log's running total showed the day-end total on every entry of that day.
- The macros allowed 60 orders but the formulas only covered 55 (and 2,000 vs
  1,988 log rows), so the last ones silently vanished. There is no row limit now.

Kept as it was: over-production and a second entry for the same order, date
and shift ask for confirmation instead of being refused. Deleting an order
deletes its production entries.

### Worth knowing

- **Holidays** are marked as full idle days for all lines (Calendar → Idle days).
- An order not started books its line **all the way to its required date**,
  because its target is worked out to finish exactly then. A small order with
  a far-off date therefore holds its line for a long time. If lines should be
  booked by how fast they sew instead, each line needs a capacity per day.
