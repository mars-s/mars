# Pi Durable self-extension trial

Build and natively register a local Mock Discord extension inside this Pi Durable agent. All content is synthetic. Never access Discord, real accounts or messaging endpoints. For this fixture, create only the extension package in the selected workspace.

The extension must supply mock_discord_status, returning label mock, proof MARS_DSH_DISCORD_V1, server Tuatara Test Server/mock-server-001, channel listening-room/mock-channel-001, and currentSong Synthetic Skies by Fixture Ensemble. Include a compact browser UI clearly labelled Mock Discord and Synthetic fixture only, sends nothing. It must render through this trial host's documented extension UI contract and have an accessible local copy-proof interaction.

The model must author the package and code, check its actual behaviour, and invoke install_extension itself. The operator supplies the host and installer, not the Discord plugin. The installer must use Pi Durable registry.install, preserve validated versioned bytes and reload its saved catalogue before resuming after restart. Tool output and model execution must be real Pi Durable, never local echo.

Acceptance: actual native installation receipt, live tool execution, rendered UI and working local interaction, then fresh tool execution and UI after process restart with no new installation and identical installed hashes. Also interrupt an explicitly replay-safe synthetic durable task mid-work and show recovery without duplicating its committed fixture effect. No claims of exactly-once external actions.

The operator must distinguish functionality Pi supplies from the custom web shell, installer and UI contract. Record all failures and intervention. Do not claim restart/recovery before the operator independently verifies it.
