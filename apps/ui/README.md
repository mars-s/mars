# Mars UI

The Next.js client for Pi Durable. Install and run the complete application from
the [repository root](../../README.md). The migration and state ownership contract
is in [MONOREPO.md](../../docs/MONOREPO.md).

This workspace uses assistant-ui for chat, shadcn controls, React Bits status
feedback and the supplied local fonts. Pi owns conversations, images, native
subthreads, ordered workflows, model execution and plugin exposure. The browser
owns selection and unsubmitted drafts. Original browser-local demos remain
unmounted reference source.

From the repository root:

```sh
npm run dev
npm run typecheck
npm run lint
npm test
npm run build
```

For UI-only development against another private Pi installation, see
[Mac development](docs/MAC-DEVELOPMENT.md). The Next server binds loopback and
defaults to port3082. `MARS_UI_PORT` selects another port. No provider credential
belongs in browser configuration.

Read [DESIGN.md](DESIGN.md), [PRODUCT.md](PRODUCT.md) and
[PI-INTEGRATION.md](docs/PI-INTEGRATION.md) before extending the client.
Component notices and references remain in `licenses/`,
[SOURCES.md](docs/SOURCES.md) and [the reference pack](design-references/README.md).
