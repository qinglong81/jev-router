# Jev router for Claude Code

A one-click **ON / OFF** switch above the Claude Code prompt box. When it is on, every prompt you send is first judged by [Jev](https://docs.typesafe.ai/introduction) (TypeSafe's fast decision model), which picks the cheapest adequate model tier (haiku, sonnet or opus) and the most relevant skills. Claude receives that as advice, and can hand separable work to a cheaper subagent.

The bar also shows how many tokens Jev has used and what it charged you (Jev costs $0.042 per million input tokens; output tokens are free), and a **Log** button opens a table of your last routed prompts.

- Orange `ON`: the router is running. Blue `OFF`: Claude Code behaves as normal.
- If Jev is slow (4 s timeout), errors, or has no key, your prompt goes through untouched.

## Install

There are two parts: the switch bar (a Claude Code mod) and the router script it controls.

**1. The switch bar**, at the prompt of a terminal session:

```
/plugin install jev-toggle --marketplace qinglong81/jev-router
```

or from a shell:

```
claude plugin install jev-toggle --marketplace qinglong81/jev-router
```

**2. The router script.** Copy `router/jev.mjs` to `~/.claude/jev/jev.mjs` (on Windows: `%USERPROFILE%\.claude\jev\jev.mjs`). Needs Node 18 or newer.

**3. The hook.** Add this to `~/.claude/settings.json` (merge it into any existing `hooks`):

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"/absolute/path/to/.claude/jev/jev.mjs\" hook",
            "timeout": 6
          }
        ]
      }
    ]
  }
}
```

Use the absolute path to the copy from step 2.

**4. Your key.** Get a TypeSafe API key and put it in the `TYPESAFE_API_KEY` environment variable (never in a file), then restart Claude Code.

```powershell
[Environment]::SetEnvironmentVariable('TYPESAFE_API_KEY','<your key>','User')
```

## Use

Click the switch. You can also run the script directly: `node jev.mjs on | off | status | refresh | log`.

Decisions and token counts are logged to `~/.claude/jev/log.jsonl`, on your machine only.
