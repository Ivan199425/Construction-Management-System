# Cubic Construction Management System

A construction project-management prototype for **Cubic Construction Management**. Single-file app built on the `.dc.html` DC-runtime template engine.

## Running

The app is a static site. Serve the folder over HTTP (the runtime loads `support.js` and `logo-data.js`), then open the app:

```bash
py -m http.server 8080
```

Then browse to `http://localhost:8080/Cubic%20PM%20System.dc.html`.

> Opening the file directly with `file://` will not work — the DC runtime must be served over HTTP.

## Modules

Per-project sections: **Summary · Details · Financial · Documents · EOT · Files & Photos · Contacts · Schedule · Defects List · Report Design**, plus global **Portfolio overview** and **Vendor directory**.

Built out so far:

- **Summary** — project dashboard + head-contract overview.
- **Details** — project type, address (Google Maps), dates, GST, customers, description.
- **Financial** — Budget (with cost-forecast trend chart + AI insight), Sub-contracts, Bills, Progress claims, Variations (linked to the budget), and client Invoices.
- **EOT** — Extension-of-Time claims with send-for-approval and schedule impact.
- **Documents** — RFIs (full lifecycle, send-for-answer, chat thread), Permits, To-Do's, Drawings (revision + view online), **Meetings** (chair/attendees from contacts, email + SMS invites, Google Calendar event, minutes & actions), Inspections, Incidents.
- **Defects List** — defect register with rectification SLAs and PDF export.

## Files

| File | Purpose |
|------|---------|
| `Cubic PM System.dc.html` | The whole application — logic (`DCLogic`) + templates. |
| `support.js` | DC runtime. |
| `logo-data.js` | Embedded company logo data. |
| `Cubic_CMS_Scoping_Document_FINAL.docx` | Project scoping document. |

_In-memory prototype — seed data resets on reload; there is no backend._
