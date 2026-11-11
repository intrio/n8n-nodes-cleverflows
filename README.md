# @cleverflows/n8n-nodes-cleverflows

Building block for connecting n8n flows to Cleverflows without hand-built webhooks, HTTP callbacks or resume webhooks. It implements the Cleverflows automation contract (protocol v1), described in the Cleverflows help under *Set up workflows* and *Set up agents*.

| Node | What it does |
|---|---|
| **Cleverflows Trigger** | Receives a workflow run or an agent task, checks the auth header, outputs `record`/`values`, `configValues`, `knowledge`, `connectionsByProvider`, agent `goal`/`instructions`/`actions`/`memory`, and `cf` (callback context). |
| **Cleverflows** | Report Progress (agents), Complete (result), Fail, Cancel. Sets token, ids and `executionId`. |
| **Cleverflows Wait** | Review, approval of an action (agents), form (workflow runs and agents) or question (agents); parks the execution on its signed waiting URL and continues with the answer in `decision` (`approved`, `revise`, `rejected`, `answered`, `timeout`) plus `feedback`, `editedPayload`, `answers`. Branch with a Switch on `{{ $json.decision }}`. One output on purpose: older n8n versions only pass resume data to the first output. Further review rounds get `<key>_2`, `<key>_3` … |

## Forms (0.1.6)

*Wait For → Form* asks a person for structured answers, in workflow runs (shown under Reviews) and agent tasks (shown in the task). Cleverflows checks the definition strictly: unknown field types or properties are rejected with HTTP 400, all texts are shown as plain text, links only with http/https. Never ask for passwords or credentials in a form, use connections for that.

```json
{
  "title": "Confirm the offer",
  "recipient": "customer",
  "remindAfterMinutes": 1440,
  "expiresInMinutes": 4320,
  "fields": [
    { "key": "price_ok", "label": "Price of 1,200 EUR confirmed", "type": "boolean", "required": true },
    { "key": "topics", "label": "Topics for the newsletter", "type": "multiselect", "options": ["Spring", "Events", "Team"], "max": 2 },
    { "key": "start", "label": "Start date", "type": "date", "min": "2026-12-01" },
    { "key": "budget", "label": "Budget", "type": "number", "min": 0 },
    { "key": "brief", "label": "Briefing", "type": "file", "accept": ["application/pdf"], "maxSizeMb": 10 }
  ]
}
```

- Field types: `text`, `textarea`, `number`, `date` (YYYY-MM-DD), `select`, `multiselect`, `boolean`, `url`, `file`.
- Per field: `key`, `label`, `type`, `required`, `options` (text or `{value,label}`), `placeholder`, `help`, `default`, `min`/`max` (number, date, number of choices), `minLength`/`maxLength` (text), `accept`/`maxSizeMb` (file, up to 25 MB; PDF, PNG, JPG, GIF, WebP, TXT, CSV, Word, Excel, PowerPoint).
- Per form: `title`, `description`, `submitLabel`, `recipient` (`customer` = people of the organization, default; `agency` = only the agency), `expiresInMinutes`, `remindAfterMinutes`, optional `i18n` with translations per language (`de`, `en`, `es`, `fr`: `title`, `description`, `submitLabel`, `fields.<key>.{label, help, placeholder, options}`); everyone sees the form in their own language.
- The answer continues with `decision: "answered"` and `answers` (one entry per field key, empty optional fields are `null`; files as `{ name, size, type, url }` with a download link valid for 7 days). In workflow runs the form can also be declined: the flow continues with `decision: "rejected"` and `feedback`, and Cleverflows ends the run.

## Follow-up workflow records (0.1.7)

*Complete* in a workflow run can hand entries to the follow-up workflow set in Cleverflows (e.g. topics from a planning run to a blog post workflow). Set *Options → Records* to an array like `[{"table": "handoff", "values": {"topic": "…", "description": "…"}}]`. The entries arrive in the input table of the follow-up workflow with status *In review* and need an approval there. Agents keep using *Records* for the tables granted to them.

## Upgrading to 0.1.5

**Breaking change:** Cleverflows Wait now has **one** output instead of four (Approved, Revise, Rejected, Timed Out). Older n8n versions (e.g. 2.9) only pass the answer to the first output, so the other branches were lost silently.

After updating, existing flows keep only the connection of the former *Approved* output; the connections of *Revise*, *Rejected* and *Timed Out* are removed. Add a **Switch** node after each Cleverflows Wait node, with rules on `{{ $json.decision }}`:

| Rule (`decision` equals) | Connect to what was on |
|---|---|
| `approved` | Approved |
| `revise` | Revise |
| `rejected` | Rejected |
| `timeout` | Timed Out |
| `answered` (questions) | Answered |

The bundled examples (`examples/`) already use this pattern.

## Setup

1. Install the package (Settings → Community Nodes, once published; until then `npm pack` here and `npm install <tgz>` in `~/.n8n/nodes`, then restart n8n).
2. Create the **Cleverflows** credential with the same auth as in Cleverflows under Connections → Automation (e.g. header `X-API-Key` + token).
3. Add **Cleverflows Trigger**, activate the flow and enter its production URL as webhook in Cleverflows (workflow settings, agent configuration, template or agency default).
4. Keep the `cf` field in items between trigger and the report/wait nodes, or set "Cleverflows Context" to `{{ $('Cleverflows Trigger').item.json.cf }}`.

Examples to import: [`examples/workflow-run-review.json`](examples/workflow-run-review.json), [`examples/agent-task.json`](examples/agent-task.json), forms: [`examples/workflow-run-form.json`](examples/workflow-run-form.json), [`examples/agent-task-form.json`](examples/agent-task-form.json).

## Expressions

- Callback context when items were replaced: `{{ $('Cleverflows Trigger').item.json.cf }}`
- Result JSON from a previous node: `{{ $json.article }}` (n8n expressions are case-sensitive)

## Publishing

1. First version once by hand: `npm login`, then `npm publish --access public` in this folder (owner of the npm organisation `cleverflows`).
2. On npmjs.com → package settings → Trusted Publishers: GitHub Actions, repository `intrio/n8n-nodes-cleverflows`, workflow `publish.yml`.
3. Later versions: bump `version`, push a tag with the same value (e.g. `0.1.1`); `.github/workflows/publish.yml` lints, tests and publishes with provenance (required by n8n).

## Development

```bash
npm install
npm test        # build + unit tests of the protocol logic
npm run lint    # n8n community node linter (strict, n8n Cloud rules)
```

