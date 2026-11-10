# Duely demo video script (target 2:45, hard limit 3:00)

**Setup before recording**
- `npm run dev` running; dashboard at http://localhost:3000, browser zoom ~110%, window full-screen.
- Click **Reset demo** so the dashboard is empty.
- A second terminal open in the project folder (for the agent demo), font size large.
- A private/incognito window ready for the client's payment (logged out of PayPal).
- Have your sandbox Personal email ready to paste as "Priya".
- Record at a quiet hour for Gemini (fewer "high demand" errors). If one appears, tap **Retry** and cut the wait in editing.
- Screen recorder: OBS or Windows Game Bar (Win+Alt+R). Voice-over recorded live or after. **No copyrighted music.** Silence or a royalty-free track is fine.
- Speed up any AI "working…" waits 2–4× in editing.

---

### 0:00–0:15 · The problem (dashboard empty on screen)
> "If you freelance, you know the money side is a second job: invoices, chasing clients who 'forgot', and once they finally pay, manually sending your collaborators their cut. Duely is an AI agent that does all of that on PayPal."

### 0:15–0:50 · Chat-to-bill + auto-split (the hero)
Type:
`Bill Ravi $450 for 3 landing pages at $150 each, due Friday. Priya (<sandbox email>) gets 30%.`
> "I just say it in plain English. Gemini pulls out the line items, works out that Friday is the 13th, and spots that Priya gets a 30% share."

Point at the yellow **Needs your OK** card:
> "Anything that sends money out needs my confirmation. Here it's promising Priya $135 the moment Ravi pays."

Press **Confirm** → the request card appears with **Open pay page / WhatsApp / Email**.
> "That's a real PayPal order, with a pay page and a message ready to send on WhatsApp."

### 0:50–1:25 · Client pays → auto-capture → auto-payout
Copy the pay link → paste in the incognito window → **Pay with PayPal** → log in as the sandbox buyer → **Complete Purchase** → lands on "✓ Payment received". *(Speed this up 3× in editing.)*
Switch back to the dashboard: toast **"💸 Ravi just paid $450"**, row turns **Paid**, activity feed shows **"Auto-split: sent $135.00 to Priya via PayPal Payouts"**, Auto-split stat = $135.
> "Ravi pays. Duely captures it instantly through PayPal's Orders API, and without me touching anything, Priya's 30% goes out through PayPal Payouts. That's the moment freelancers usually forget or delay."

### 1:25–1:55 · AI chasing that escalates
Type: `Invoice Acme Corp for 12.5 hours of API work at $40/hr, due in 10 days. Their phone is +91 98765 43210`
> "Hourly work, fractional hours, relative due dates: handled."

Type: `Chase Acme Corp` → friendly reminder card. Then: `Chase them again, they ignored it` → **firm** card.
> "When clients go quiet, Duely writes the reminder for me, and each one gets firmer. One tap sends it on WhatsApp with the pay link."

### 1:55–2:30 · Agent-to-agent commerce (the differentiator)
Switch to terminal: `npm run agent-demo`
> "And here's what's next. Duely is also an MCP server, so other AI agents can use it. This is a separate scheduling agent. A job just got marked complete, so it bills the client and asks to pay the subcontractor, all through Duely and PayPal."

Show the MCP calls scrolling. Switch to the dashboard: the new invoice and a **Needs your OK** card tagged **🤖 JobBoard agent via MCP**. Press **Confirm** → **Payout sent**.
> "Agents can transact, but a human still approves every payout."

### 2:30–2:45 · Wrap
Type: `Refund $20 to Ravi as a goodwill discount` → Confirm (optional if time allows), then `Who owes me money?` → insights card.
> "Bill, collect, split, chase, refund. All PayPal: Orders, Payouts, Refunds and webhooks. Gemini runs the agent, and it's open to other agents over MCP. That's Duely."

End card: **Duely** · github link · "Built with PayPal + Gemini".
