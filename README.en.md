# QQ ↔ DeepSeek Harness bridge

[中文](README.md) · [AI installation guide, in Chinese](README.ai.md) · [Documentation](docs/README.md)

Connect QQ private chats and groups to DeepSeek Harness (DSH) through SnowLuma. Each QQ conversation gets a separate DSH session. A local console manages access, personas, operating modes, and usage.

## Install with an AI assistant

Clone this repository and open it in an AI coding assistant that can read local files and run commands. Send:

> Read README.ai.md and help me install qq-bridge. Check the environment and existing configuration first. Ask only for missing information. Tell me when I need to log in to SnowLuma or test QQ messaging, and report what you actually verified.

The assistant can install bridge dependencies, configure DSH plugins, and check connections. Download the full package for your platform from [SnowLuma Releases](https://github.com/SnowLuma/SnowLuma/releases), extract it, start SnowLuma, and complete QQ login yourself. The AI guide explains how to enable the OneBot endpoints.

## Prepare the environment

- Node.js ≥ 22.13.0 and npm.
- An initialized [DSH](https://github.com/deepseek-ai/deepseek-harness) installation with a reachable Web service, a working model, and the `dsh` CLI on PATH.
- [SnowLuma](https://github.com/SnowLuma/SnowLuma/releases) logged in to QQ, with its OneBot v11 WebSocket server and HTTP API enabled.

The default setup runs all components on one machine under the same OS user. Repository adaptation records cover DSH `0.2.1-rc.2` and SnowLuma runtime `1.14.20`. Verify other versions separately. See the [documentation index](docs/README.md) for adaptation notes.

## Install manually

```sh
git clone https://github.com/4shen-hj/qq-bridge.git
cd qq-bridge
npm install
```

1. Copy `config.example.json` to `config.json` only if no configuration exists. Set the SnowLuma endpoints, token, and installation directory, plus `ownerQQ` and `allow.private` or `allow.groups`. Empty allowlists reject messages by default.
2. Run `node scripts/setup-dsh.mjs web`. Replace `web` with the profile your DSH instance uses; desktop installations may use `desktop`.
3. Restart that DSH instance, then run `npm start`.
4. Open the [local console](http://127.0.0.1:3100). Sign in with a valid `consoleToken` from `config.json`. If empty or invalid, the bridge uses an automatic token stored locally in `state/console-token`. Startup logs show only its first six characters.
5. Check DSH, SnowLuma upstream health, and the allowlists. Send a message from an allowed QQ account and confirm that the reply arrives in QQ.

The [AI installation guide](README.ai.md) includes configuration fields, validation steps, and troubleshooting for manual installation too.

## Choose a mode

Switch modes in the console.

| Mode | Behavior |
| --- | --- |
| `chat` | Chats within the allowlists and forwards replies automatically. |
| `reserved2` | Second-generation group simulation. The agent decides when to read, speak, and wait. Default for new installations. |
| `reserved` | First-generation group simulation with selective participation. |
| `closed-agent` | Owner-only private chat with full DSH tools, including local machine access. |

For the first test, temporarily use `chat` so deliberate silence in simulation mode does not look like a failure. Manage personas in the console; see the [role-card guide](roles/README.md).

## Operate the bridge

- Run `npm start` in the foreground and stop with `Ctrl+C`. On Windows, `start.bat` restarts the bridge after crashes; close its window to stop the supervisor. Run one instance per checkout.
- The owner can use `/status`, `/reset`, `/role <name>`, `/silent`, and `/active` in QQ.
- Back up configuration and roles before updating. After pulling changes, run `npm install` and `node scripts/setup-dsh.mjs <actual-profile>`, then restart DSH and the bridge. Create or reset sessions after preset changes.

## Access and data

Keep allowlists enabled. Enable `closed-agent` only when you need owner access to local tools. Messages go to the DSH model. Automatic slang research can also send extracted terms to a search service; set `slang.autoResearch: false` to disable it.

Do not commit `config.json`, `state/`, `audio/`, or credentials. See [access rules](RULES.md) and [privacy notes](docs/guides/PRIVACY.md). The bridge uses the [MIT license](LICENSE); SnowLuma has its own license.
