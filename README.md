# OpenClaw Colab Provisioner

Run an OpenAI-compatible local gateway backed by an on-demand Google Colab T4 GPU. The gateway creates a runtime and Jupyter session, installs Ollama, pulls a model, and releases its own runtime after a configurable idle period.

**Version:** 1.3.0-beta.3 · **Requirements:** Node.js 22+, `gcloud`, `curl`, `openssl`, a Linux host running systemd user services, and a Google Colab account eligible for T4 Standard runtimes.

The gateway listens on `127.0.0.1:18080`. It does not expose the Colab runtime to the public internet. Colab usage may consume compute units. Availability and session lifetime depend on Google.

## Installation

```bash
unzip openclaw-colab-provisioner-v1.3.0-beta.3.zip
cd openclaw-colab-provisioner
npm test
```

Existing installations can be upgraded by copying the release into the project directory; keep `~/.config/openclaw-colab/gateway.env` and the Google ADC credentials outside the repository.

### Google OAuth

Create a **Desktop** OAuth client in your Google Cloud project. In Google Auth Platform, add your Google account under **Audience → Test users** while the application is in Testing mode. Save the client JSON outside the repository.

```bash
mkdir -p ~/.config/openclaw-colab
chmod 700 ~/.config/openclaw-colab
# Save your downloaded OAuth Desktop client as:
# ~/.config/openclaw-colab/oauth-client.json
chmod 600 ~/.config/openclaw-colab/oauth-client.json

gcloud auth application-default login \
  --client-id-file="$HOME/.config/openclaw-colab/oauth-client.json" \
  --scopes="openid,https://www.googleapis.com/auth/userinfo.email,https://www.googleapis.com/auth/cloud-platform,https://www.googleapis.com/auth/colaboratory"

gcloud auth application-default print-access-token >/dev/null && echo 'ADC ready'
```

The consent process may require Google approval depending on account and scope policy. Testing-mode OAuth authorizations may expire after seven days.

Verify Colab access:

```bash
node bin/colabmcp.mjs gpu status
node bin/colabctl.mjs specs
```

The account must show `eligible: true` for `VARIANT_GPU / T4 / SHAPE_STANDARD`.

## Configure the gateway

If upgrading from v1.2, first check `node bin/colabctl.mjs list` and remove any unused manually-created Colab runtime. Autopilot does not adopt these runtimes.

Use the service installer:

```bash
./scripts/install-service.sh
```

It writes `~/.config/openclaw-colab/gateway.env` with a generated API key and the settings below. Existing configuration files are preserved.

```dotenv
COLAB_GATEWAY_API_KEY=<generated-secret>
COLAB_MODEL=qwen3:4b-instruct-2507-q4_K_M
COLAB_GATEWAY_PORT=18080
COLAB_IDLE_MINUTES=30
COLAB_DELETE_OWNED_RUNTIME_ON_IDLE=yes
```

Keep the API key private. Protect the file with `chmod 600 ~/.config/openclaw-colab/gateway.env`.

Autopilot only starts a Colab runtime on the **first chat request**. The first request can take several minutes because runtime allocation, package installation and model download occur before inference. Consecutive requests reuse the session and loaded model.

Check the service:

```bash
systemctl --user status openclaw-colab-gateway
journalctl --user -u openclaw-colab-gateway -f
```

To keep user services running after logout:

```bash
sudo loginctl enable-linger "$USER"
loginctl show-user "$USER" -p Linger
```

The legacy `colabgateway.mjs` and manual `colabctl.mjs`/`colabmcp.mjs` commands remain included. Do not run the legacy gateway and Autopilot simultaneously on port 18080.

## Test

In another terminal:

```bash
source ~/.config/openclaw-colab/gateway.env
curl -fsS http://127.0.0.1:18080/v1/chat/completions \
  -H "Authorization: Bearer $COLAB_GATEWAY_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"colab-t4","stream":false,"messages":[{"role":"user","content":"Explain Kubernetes in one sentence."}]}' | jq .
```

A successful response contains `choices[0].message.content`. `GET /healthz` and `GET /v1/models` use the same bearer key.

## Configure OpenClaw

Register a custom model provider pointing at the local gateway:

```bash
source ~/.config/openclaw-colab/gateway.env
cp -a ~/.openclaw/openclaw.json ~/.openclaw/openclaw.json.bak.$(date +%Y%m%d-%H%M%S)
openclaw config set models.providers.colab "$(jq -nc --arg key "$COLAB_GATEWAY_API_KEY" '{baseUrl:"http://127.0.0.1:18080/v1",apiKey:$key,auth:"api-key",api:"openai-completions",timeoutSeconds:600,request:{allowPrivateNetwork:true},models:[{id:"colab-t4",name:"Qwen3 4B via Colab T4",reasoning:false,input:["text"],contextWindow:4096,maxTokens:1024,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]}')" --strict-json
openclaw config validate
openclaw models list
```

This registers `colab/colab-t4`. It does not change your default model, agents, Telegram rules or Smart Router plugin. Routing and fallback must be configured separately.

## Runtime ownership and shutdown

The gateway records the runtime it creates in `~/.config/openclaw-colab/autopilot-state.json`. Only that runtime can be removed automatically. The state file must be kept between service restarts. It does not adopt existing runtimes created through Colab browser or `colabctl`.

Only authenticated, valid chat requests (and completion of in-flight requests) reset the idle timer. Health checks, unauthorized requests, and malformed chat requests do not keep the GPU allocated. The default timeout is 30 minutes, and the timer is based on gateway activity, not the Colab provider's own lifetime policy.

When there are no in-flight chat requests for `COLAB_IDLE_MINUTES`, the gateway deletes its own runtime. The local HTTP service stays online. A new request provisions a new runtime and downloads the model again.

**Stop GPU costs:** stopping the systemd service does **not** delete an allocated runtime. Check existing runtimes and delete an unused runtime manually:

```bash
node bin/colabctl.mjs list
node bin/colabctl.mjs delete runtimes/ACTUAL_RUNTIME_ID --confirm-delete
```

Never delete a runtime that is actively used elsewhere. The gateway cannot detect browser jobs or third-party Jupyter clients on its runtime. Do not change the model or runtime ownership state while a request is active.

## Operations

```bash
systemctl --user restart openclaw-colab-gateway
systemctl --user stop openclaw-colab-gateway
systemctl --user disable --now openclaw-colab-gateway
node bin/colabctl.mjs list
node bin/colabmcp.mjs gpu status
npm test
```

### Troubleshooting

| Symptom | Check |
|---|---|
| `Unauthorized` | Gateway API key in `gateway.env` must match the bearer token. |
| `EADDRINUSE` | Stop the manually launched gateway or any other process on port 18080. |
| OAuth authentication fails | Renew ADC login, confirm the OAuth test user and Colab scope. |
| T4 is not eligible | Verify the account's `specs` output and available compute units. |
| First request times out | Initial bootstrap can take minutes; inspect the service logs and `colabctl list`. |
| Ollama bootstrap error | Inspect the returned error; the Colab runtime needs working `apt`, network access and NVIDIA GPU support. |

## Limitations

- Text chat completions only; `stream: true`, tool calling, image inputs and structured outputs are not implemented.
- The first request includes runtime provisioning, Ollama installation and model download. Model files are not persisted after the Colab runtime is deleted.
- There is no automatic failover to another provider inside this gateway. Configure fallback in OpenClaw or Smart Router separately.
- OAuth ADC credentials and Colab API access are account-dependent. The Colab API and its quotas may change.
- The gateway serializes requests to a single Jupyter session. It is designed for a trusted local host, not as a public multi-user API.

## Other commands

```bash
node bin/colabctl.mjs help
node bin/colabmcp.mjs --help
```

License: MIT.

## Runtime creation and recovery

`create_runtime` may return an operation name (`operations/...`) before the runtime appears. Autopilot waits for the newly created T4 Standard runtime to become visible. If a T4 Standard runtime is already present but not recorded in the Autopilot state file, Autopilot stops rather than creating another one or claiming ownership. Inspect your runtimes with:

```bash
node bin/colabmcp.mjs runtimes
```

An existing unmanaged runtime can be removed explicitly using `colabctl delete` after confirming it is unused. The legacy `colabctl` requires `COLAB_ACCESS_TOKEN` to be set; MCP CLI commands refresh ADC credentials automatically.

## Runtime cleanup

Autopilot clears its owned-runtime state if the runtime was already removed by Colab. Other runtimes are never adopted or deleted. A missing owned runtime is rediscovered on the next request.


### OpenAI-compatible tool calling (staging)

The Colab gateway now forwards function-tool definitions to Ollama and returns OpenAI-compatible `tool_calls`. OpenClaw remains responsible for executing tools; no arbitrary tools run inside the gateway. Follow-up requests must include the assistant tool call, matching `tool_call_id`, tool results and relevant conversation history. This gateway does not store conversation memory.

`tool_choice` supports `auto` and `none`; forced/required tools, streaming, multimodal messages and structured outputs remain unsupported. The configured Ollama model must actually support tools. Actual Colab GPU and OpenClaw integration testing remains pending.
