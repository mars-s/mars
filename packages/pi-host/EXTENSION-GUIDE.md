# Native extension with UI

For install_extension, author a directory with manifest.json, extension.mjs and client.js. Absolute paths work; relative paths use the Pi workspace. manifest.json contains name, semantic version, title and description. extension.mjs exports a native Pi extension as default. Example:

```js
export default {
  name: 'my-extension',
  tools: [{
    name: 'my_status', description: 'Return local status.',
    parameters: {type:'object',properties:{}}, replay:'safe',
    async execute() {
      return {output:[{type:'text',text:'ready'}]};
    }
  }]
};
```

Task-only, hook-only and section-only native extensions also install. Use versioned task names such as my.workflow.v1. Keep definitions needed by unfinished tasks in the replacement package; the native registry resolves one definition per task name.

Tools can use the host filesystem, network and installed SDK. Packages installed in the app are available through the data/node_modules link, or install a package in your own directory. Test actual module exports before installation. Native results use output, never content. Use structuredOutputSchema and structuredOutput for programmatic results. Mark side effects replay unsafe, reads safe.

client.js is browser ESM with export function mount(root), optionally returning cleanup. Use DOM elements in root and inherit fonts/colours. The owner-authenticated gateway serves /extensions/HASH/client.js under its existing CSP. Browser code receives no credentials. For deeper Next UI changes edit the checkout directly.

The manager builds cards and tool switches from installed metadata. Add kind:"mcp" to the manifest for an MCP wrapper; it uses the same tool/interface controls. An interface opens only when the owner selects Open interface. Fetch /api/state?conversationId=ID for bounded state, taking the selected ID from the page's conversation query parameter. Images in state are receipts/URLs, not base64. Subthreads and workflows are separate native records. Link to /?conversation=CHILD_ID to open a child. Do not hardcode installed IDs or duplicate the plugin catalogue in browser source.

The installer freezes package bytes by SHA256, installs its native extension immediately, and persists the catalogue before returning a receipt. Same bytes are idempotent. New version bytes replace later calls while already-running calls keep their code. Previous hashes stay on disk. On boot installed extensions load before native tasks resume. Tool schemas are deferred so installation does not bloat every prompt. Discover and invoke the newly installed tool for live proof, then check UI and a fresh call after restart.

For the mocked Discord evaluation, the fixture and UI must clearly say synthetic. It sends no messages. Follow workspace/TRIAL-SPEC.md only for that test. For actual server/UI/dependency changes the agent has full VM access and can restart its own user services.
