# dsh-subagent-model-live-policy

Make the subagent model allowlist live, and teach the delegation tools how to
discover routes instead of guessing them.

Two independent problems, one small plugin:

## 1. A Settings change reaches only new Sessions

DSH records the child-LLM allowlist as a Session event
(`subagent/model-selection-policy`) when an Agent is created, and its projection
fold accepts only the **first** such event. Changing the allowlist in Settings
therefore reaches only Sessions created afterwards: the Settings page shows the
new list while `subagent(provider, model)` keeps rejecting routes that are now
listed, and keeps accepting routes that were removed.

Appending more events does not fix this. The projection state is a non-empty
route array or `null`, and the Session-format validator rejects an empty
`allowedModels`, so "the list is now empty" cannot be written at all.

Instead, this plugin overrides the single read path both consumers already use.
`subagent` and `list_subagent_models` read the allowlist through
`ProjectionHandle.stateOf(session)`, which is:

```js
stateOf: session => this.cellFor(registration, session).state
```

`cellFor` is a prototype method on the projection registry. Wrapping it once,
filtered by projection key, makes both consumers read the live preference on
every call, leaving the Session log, the fold, and the format validator
untouched.

Turning the setting **off** yields `null`, which is the projection's own
"no policy recorded" state. DSH then restricts explicit selection to the parent
route — the plugin invents no new semantics.

## 2. The delegation tools do not know the route ids

The `provider` and `model` parameters of `subagent` are free-form strings. A
model that guesses a plausible id — `openai` where the profile registers
`codex`, say — learns the mistake only from the rejection raised after the call.

`tools.schemas()` re-projects every visible definition on each call, so wrapping
it appends a discovery hint to `subagent` and `subagent_fork` only:

> Before passing `provider` or `model`, call `list_subagent_models` … and copy
> an exact id from its reply. Those ids are profile-specific: the provider may
> not be named after the vendor, so do not infer one from a model name.

The hint never names a concrete provider, so it survives swapping the
subscription plugin.

## What this plugin does not do

- It writes no Session events and changes no Session log.
- It registers no tools.
- It adds no system-prompt section.
- It reads the preference from the existing `subagentModelSelection` Host
  service rather than keeping a copy, so the Settings card stays the single
  source of truth.
- If DSH renames `cellFor` or `schemas`, the plugin detects the mismatch, logs
  why it is inactive, and changes nothing.

## Limits that remain

- Turning the setting **off** stops granting authorization; it does not erase a
  list already written into an old Session's log. Those Sessions fall back to
  the parent route, which is DSH's own meaning of "no policy".
- An enabled but empty allowlist grants nothing.

## Install

```sh
dsh plugin --profile desktop add <this package>
```

Or from a GitHub checkout:

```sh
dsh plugin --profile desktop add github:<owner>/<repo>
```

## Test

The suite uses the real `SessionProjectionRegistry` from the running
installation, so it covers the same read path the tools use.

```sh
ELECTRON_RUN_AS_NODE=1 "<DSH executable>" test.mjs
```

## License

MIT
