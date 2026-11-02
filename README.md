# OpenClaw Colab Provisioner (v1 community beta)

Experimental, **operator-controlled** Google Colab runtime management for OpenClaw. Designed as an independent companion to [OpenClaw Smart Router](https://github.com/konradsoares/openclaw-smart-router).

> **Scope of v1:** official Colab API discovery, eligible runtime listing, explicit create/delete operations, optional read-only Telegram help, and an interactive Ollama notebook. **Not yet an automatic LLM inference backend.** Nothing provisions a GPU automatically. Account eligibility, quotas, and compute-unit charges must be confirmed with Google. No public ngrok tunnels are created.

## Architecture

```text
OpenClaw gateway (optional !colab status/help)
              |
       colabctl (operator CLI)
              |
       Google Colab REST v1beta
              |
     Runtime specs / list / create / delete
              |
 Interactive Colab notebook (separate experiment)
              |
       Ollama + model (manual, local notebook execution)
```

## Prerequisites

- Node.js 22+; tests validated with Node.js 24
- OpenClaw with plugin support
- A Google account with access to Colab Runtime API and eligible compute resources (AI Pro does not guarantee API access)
- An OAuth access token for `https://www.googleapis.com/auth/colaboratory`; read-only discovery can use the `.readonly` scope
- The Google Colab API enabled in a Google Cloud project if your OAuth flow requires it
- GPU capacity/compute units available in your Colab account

**Important:** An ordinary Gemini API key does **not** authorize the Colab runtime API. The plugin never asks you to put Google access tokens into `openclaw.json`.

## Install directly from GitHub

```bash
openclaw plugins install git:github.com/YOUR_USERNAME/openclaw-colab-provisioner@main
openclaw plugins enable colab-provisioner
openclaw plugins inspect colab-provisioner --runtime --json
openclaw plugins doctor
```

Review and approve installation permissions. OpenClaw's Git installs require explicit trust approval. If you use `plugins.allow`, make sure `colab-provisioner` is included.

### Configure OpenClaw (safe defaults)

```bash
openclaw config set plugins.entries.colab-provisioner.config.enabled true
openclaw config set plugins.entries.colab-provisioner.config.mode observe
openclaw config set plugins.entries.colab-provisioner.config.telegramCommands false
openclaw config get plugins.entries.colab-provisioner
```

`observe` does not intercept Telegram messages or create runtimes. GPU operations only happen through an explicit command on the Gateway host.

Optional Telegram read-only helper (not needed for CLI management):

```bash
openclaw config set plugins.entries.colab-provisioner.config.mode manual
openclaw config set plugins.entries.colab-provisioner.config.telegramCommands true
openclaw config set plugins.entries.colab-provisioner.config.allowedTelegramIds '["YOUR_NUMERIC_TELEGRAM_USER_ID"]'
```

Then send `!colab status` or `!colab help` to your Telegram bot. This replies with a static instruction message; it does not consult the Colab API. Other messages are not intercepted.

## Use the CLI

**The npm package is not published to npm.** The CLI is included in this Git repository. A Git-managed OpenClaw install lives in a host-managed directory that you can locate with `openclaw plugins inspect colab-provisioner --runtime --json`. For easiest operator usage, clone the repository separately:

```bash
cd ~/Documents/Projects
git clone https://github.com/YOUR_USERNAME/openclaw-colab-provisioner.git
cd openclaw-colab-provisioner
npm test
npm run check
node bin/colabctl.mjs help
```

### OAuth access

Get a **short-lived, user-authorized OAuth access token** with scope `https://www.googleapis.com/auth/colaboratory` through a Google OAuth flow you control, such as a Google Cloud OAuth desktop app. Do not use a Gemini key or paste a token into GitHub, Telegram, or ChatGPT. You can use a Google-approved OAuth client flow or an appropriately configured `gcloud auth application-default login --scopes=...` if your version and account allow that scope.

For a temporary shell session:

```bash
read -rsp 'Paste short-lived Colab OAuth access token: ' COLAB_ACCESS_TOKEN; echo
export COLAB_ACCESS_TOKEN
node bin/colabctl.mjs specs
```

The tool does not persist access tokens. Use `unset COLAB_ACCESS_TOKEN` when finished. Your OAuth flow may need reauthorization on expiry. API errors `403 PERMISSION_DENIED` or `FAILED_PRECONDITION` can indicate insufficient scopes, project/API restrictions, unsupported account eligibility, or missing capacity. The tool does not attempt to bypass restrictions.

### Read-only discovery (no GPU allocation)

```bash
node bin/colabctl.mjs specs
node bin/colabctl.mjs list
node bin/colabctl.mjs subscription
```

The `specs` response includes a `runtimeSpecs` array and eligibility flags. **Array indices are zero-based** and used by the create command. `list` and `get` redact runtime connection tokens.

### Provision a runtime (manual, opt-in)

Only after confirming eligibility and budget:

```bash
node bin/colabctl.mjs specs
node bin/colabctl.mjs create --spec 0 --confirm-create
node bin/colabctl.mjs list
```

The `--spec` index is illustrative, not a recommendation; inspect the actual returned key and eligibility before choosing. `create` returns a long-running **Operation**, not necessarily an immediately usable runtime. The beta does not poll operations or start a model automatically. Creating resources may consume compute units.

### Delete a runtime assignment

```bash
node bin/colabctl.mjs delete runtimes/YOUR_RUNTIME_ID --confirm-delete
```

This unassigns the selected runtime and can discard ephemeral notebook state. Do not delete runtimes containing work you need. The Colab API recommends reusing existing runtimes where practical.

## Ollama + Hugging Face proof of concept

See [`notebooks/colab-ollama-experiment.ipynb`](notebooks/colab-ollama-experiment.ipynb). It deliberately **does not** automatically run arbitrary installation scripts, pull models, or expose Ollama on the public internet. The GPU diagnostic cell is executable. The rest are reviewed/manual instructions for an interactive Colab session. Ollama's model catalog is distinct from directly downloading GGUF files from Hugging Face.

A future release may support model presets via Hugging Face Hub, secure Jupyter-kernel execution using the API-issued short-lived runtime proxy token, and user-approved remote inference. This is not implemented in v1.

## Tests

```bash
npm test
npm run check
```

Tests mock the REST API. No GPU or Google credentials are needed.

## Limitations and safety

- **No guaranteed Google AI Pro entitlement** for Colab Runtime API. Check actual eligibility before allocating a runtime.
- No on-demand model inference, startup automation, Hugging Face downloading, health polling, auto-shutdown or cost accounting in v1.
- No Ollama public tunnel: Colab managed runtimes restrict unrelated public web-service hosting. Avoid exposing unauthenticated inference ports.
- `COLAB_ACCESS_TOKEN` is an ephemeral credential. Protect your shell and process environment.
- Runtime assignment deletion is destructive for ephemeral state.
- Google runtime connection info includes sensitive tokens. The CLI redacts these from display.
- Read-only Telegram help does not send messages to Google and is off by default.

References: [Colab API](https://developers.google.com/colab/api/reference/rest), [Colab FAQ](https://research.google.com/colaboratory/faq.html), [OpenClaw plugin installation](https://docs.openclaw.ai/tools/plugin).

## License

MIT. Community project, not affiliated with Google, NVIDIA, or OpenClaw.
