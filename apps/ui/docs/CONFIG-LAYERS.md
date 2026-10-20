# Mars configuration layers

Mars resolves settings in three layers. Later layers override earlier ones, key by key.

| Layer | Location | Shared? |
| --- | --- | --- |
| Default | `packages/pi-host/defaults.json` | Committed. A fresh clone gets exactly this. |
| User | `~/.config/mars/config.json` (or `$XDG_CONFIG_HOME/mars`, or `$MARS_CONFIG_DIR`) | Personal. Lives outside the repository and is never pushed. |
| Environment | `MARS_MODEL_CONCURRENCY`, `MARS_MODEL_MAX_OUTPUT_TOKENS` | Operator overrides for a single service. |

Only name the keys you want to change. For example, a personal layer that raises parallel model calls:

```json
{ "models": { "concurrency": 16 } }
```

`models.concurrency` (1 to 32) limits simultaneous model calls across the host and sets the maximum workers per fanout. A broken user or environment layer is logged and skipped, so the host still starts on defaults. Restart `mars-pi-trial.service` after changing a layer.

Run `node packages/pi-host/check-config.mjs` to verify the loader.
