# bridex-plugin-tripo

[Tripo3D](https://developers.tripo3d.ai)'s API for Bridex agents: 3D models from
text, an image or several views — the H series for detail, the P series for
clean game-ready topology (P2 with native quads, P1 low-poly) — then texture,
rig, animate, retopologize, segment, re-UV and convert them. Every operation
is an async task: the plugin uploads local inputs, waits, and saves the outputs
into the task's artifacts with provenance at once (Tripo's download links die
after five minutes), with the credits spent in the usage charts.

## Install

From the Bridex plugin catalog (Settings → Plugins → Catalog, or the operator
MCP `plugin_admin install tripo`), then set the key:

- **Settings → Integrations → Tripo** (`TRIPO_API_KEY`, `tsk_…`, create at
  developers.tripo3d.ai → API Keys). Read per call — no restart needed.

API credits are bought on the developer platform (1 credit = $0.01); a Tripo
Studio subscription does not pay for API calls.

Optional `bridex.yaml`:

```yaml
plugins:
  tripo:
    config:
      api_key: ${TRIPO_API_KEY}   # default
      default_wait_s: 240         # how long tripo_run waits before handing back the task id
      low_balance_credits: 300    # the balance tile turns «running out» below this
```

## Tools

| Tool | Cost | What |
|---|---|---|
| `tripo_docs` | free | parameters of one operation, from Tripo's own docs (H or P series for generation) |
| `tripo_run` | **paid** | any operation — `text_to_model`, `image_to_model`, `multiview_to_model`, `image_to_splat`, `text_to_image`, `image_to_image`, `image_to_multiview`, `edit_multiview`, `texture`, `convert`, `import`, `rig_check`, `rig`, `retarget`, `segment`, `complete`, `retopology`, `smart_segment`, `smart_uv`. `params` is the request body; local files (`artifacts/…png`, `…glb`) in image or model fields are uploaded (presigned, up to 150 MB), a previous task's id goes in `input` for the next step. Waits (default 4 min), saves every output into `artifacts/<task>/`, shows the preview render, records the credits |
| `tripo_task` | — | status of a task that outlived the wait; saves a finished one, returns the files of a saved one |
| `tripo_balance` | free | credits available and frozen |

A task is tracked in the instance DB from the first second: if the run ends or
the server restarts mid-wait, the watcher saves the outputs when the task lands
and **wakes the agent** in the session it came from. Reading the task with
`tripo_task` after that wake takes the wake back.

Outputs are named `<operation>-<task tail>.<ext>` (the model), `…-preview.<ext>`
(the render) and `…-<output key>.<ext>` for the rest, inside the task's
artifact folder (or `artifacts/tripo/` outside a task), with a sidecar naming
the operation, task id, parameters and cost.

Rate and concurrency limits are Tripo's: task creation is spaced about a
second apart, and a 429 (rate limit 1007, a full category pool 2000) is retried
after the time Tripo asks for. An empty balance (2010) puts one card in the
inbox.

## Why kind: integration

The plugin writes into workspace artifacts, stamps provenance, records usage
and wakes agents — in-process facilities. A catalog plugin of kind `tool` runs
out of process with flat schemas and no artifact access.

## Test

`node --test test.mjs` — against a stand-in for the API, no key and no credits.
