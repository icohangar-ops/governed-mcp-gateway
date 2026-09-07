# Stack Overflow answers (paste-ready)

Stack Exchange **write** methods need a user OAuth `access_token`. A Stack Apps key only raises the read quota — it cannot post as you. Answers below are ready to paste. Unanswered threads first.

## 1. FastMCP: stream tokens chunk by chunk

Question: [79850215](https://stackoverflow.com/questions/79850215/is-there-a-way-in-mcp-to-stream-a-llm-response-chunk-by-chunk-back-to-the-client) · 0 answers

A `tools/call` result is one JSON-RPC payload. FastMCP will not stream the `content` array token-by-token as the return value of the tool. Chunks have to travel as **notifications** on the same session (stdio or SSE), not as the tool's return.

```python
from fastmcp import FastMCP, Context

mcp = FastMCP("streamer")

@mcp.tool()
async def generate(prompt: str, ctx: Context) -> str:
    parts = []
    async for chunk in llm.astream(prompt):  # whatever client you use
        text = chunk or ""
        parts.append(text)
        # Progress/log notifications are the streaming channel.
        await ctx.info(text)
        await ctx.report_progress(progress=len(parts), total=None)
    return "".join(parts)  # final tool result stays a single string
```

On SSE transports, every notification must still carry identity. Do not stash the `Principal` only on the HTTP handshake — put it on `_meta` of **each** event. Thread-local security context is dropped when the tool runs on a worker thread (see 79618824).

If the client is Claude Desktop / VS Code, they currently render `tools/call` when it completes; they may ignore `notifications/progress`. In that case you cannot get token streaming in the UI until the client subscribes to those notifications. Your server can still emit them.

---

## 2. Spring AI MCP: security context not propagated to tools

Question: [79618824](https://stackoverflow.com/questions/79618824/security-context-not-propagated-when-calling-tools-in-spring-ai-mcp-server)

`SecurityContextHolder` is `ThreadLocal`. `listTools` runs on the request thread (Bearer works). `tools/call` over SSE is dispatched on a different thread, so `SecurityContextHolder.getContext().getAuthentication()` is `null`.

Do both of these:

**A. Pass the principal in MCP metadata, not via ThreadLocal**

On the gateway, inject the authenticated principal into every call:

```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "secure.tool",
    "arguments": {},
    "_meta": {
      "cubiczan": { "principal": { "id": "user-123" } }
    }
  }
}
```

Read `_meta` inside the tool. Do not call `SecurityContextHolder` from tool code.

**B. If you must keep Spring Security**

```java
SecurityContextHolder.setStrategyName(
    SecurityContextHolder.MODE_INHERITABLETHREADLOCAL);
```

is not enough for a thread *pool*. Wrap the MCP executor:

```java
@Bean
TaskExecutor mcpExecutor() {
  var pool = new ThreadPoolTaskExecutor();
  pool.initialize();
  return new DelegatingSecurityContextAsyncTaskExecutor(pool);
}
```

And copy the context onto SSE events: the original handshake is gone by the time you write `event: message`. Repeat the principal on every frame.

---

## 3. VS Code: rotate an MCP input without changing its id

Question: [79679413](https://stackoverflow.com/questions/79679413/how-do-you-update-an-input-for-an-mcp-configuration-in-vscode)

VS Code stores MCP `inputs` in Secret Storage keyed by **`inputs[].id`**. There is no field editor for “change this secret”.

Workarounds that keep the same `id`:

1. Command Palette → **MCP: List Servers** → your server → **Clear Cached Inputs** / **Reset Secrets** (wording varies by VS Code version). Reload the window. The next start re-prompts for the same `id`.
2. If that command is missing: Command Palette → **Preferences: Open User Settings (JSON)** is the wrong layer. Delete the secret via **Developer: Show Running Extensions** is also wrong. Use:
   - Command Palette → **Developer: Reload Window** after running **MCP: Reset Trust** on that server, then restart the server so the password input fires again.
3. Nuclear option: temporarily rename `id` (`github_token` → `github_token_v2`), start once, then you have two secrets. Prefer (1).

If a **gateway** owns the credential, keep the VS Code input stable (`github_token`) and rotate behind it:

```http
POST /v1/credentials/github_token/rotate
Authorization: Bearer <operator>
{"secret":"ghp_new_..."}
```

The old secret hashes stop verifying immediately; the input name does not change. That is the production fix — VS Code should not be the vault.

---

## 4. LangGraph: stop waiting on the slowest parallel node

Question: [79192884](https://stackoverflow.com/questions/79192884/how-can-i-parallelize-nodes-in-langgraph-without-having-to-wait-for-the-slowest) · 0 answers

Pregel supersteps wait for **all** nodes that started in that step. Fan-out with `Send` still joins at the next barrier. There is no “cancel the other branch” in the public API for a running node.

Patterns that actually work:

1. **Short-circuit in state, not in the scheduler.** Both nodes write; a downstream router ignores the slow field if the fast path already set `winner`. The slow node still finishes (wasted work) but you do not *block user-visible progress* if you stream from the fast node with `astream(stream_mode="updates")`.
2. **Do not put the optional work in the same superstep.** Run the cheap node first; `conditional_edges` skip the expensive node.
3. **Hard cancel** only exists if you own the node body: check an `asyncio.Event` / abort flag in the slow node and return early. LangGraph will not kill a thread for you.
4. Recursion limit (`config={"recursion_limit": N}`) is unrelated — that caps supersteps, it does not cancel siblings.

---

## 5. LangGraph: GraphRecursionError of 25

Question: [78337975](https://stackoverflow.com/questions/78337975/setting-recursion-limit-in-langgraphs-stategraph-with-pregel-engine)

`StateGraph.compile()` does not take `recursion_limit`. Pass it at **invoke/stream** time:

```python
app.invoke(state, config={"recursion_limit": 50})
# or
app.astream(state, config={"recursion_limit": 50})
```

If you still hit 25, you have a cycle with no `END` edge. Fix the graph: a node that always routes to itself will burn any limit. Add a counter in state and an edge to `END` when `iteration_count >= max`. Raising the limit on a stuck loop only delays the crash.

---

## 6. CrewAI / LiteLLM: “LLM Provider NOT provided”

Question: [79111773](https://stackoverflow.com/questions/79111773/litellm-badrequesterror-llm-provider-not-provided-pass-in-the-llm-provider-you)

LiteLLM infers the provider from a **string** `model="gemini/gemini-1.5-flash"`, not from a LangChain `ChatGoogleGenerativeAI` instance stuffed into `model=`. You passed an object whose `repr` is `model='models/gemini-1.5-flash' ...`, so LiteLLM never sees a provider prefix.

```python
from crewai import LLM, Agent

llm = LLM(
    model="gemini/gemini-1.5-flash",
    api_key=os.environ["GOOGLE_API_KEY"],
    temperature=0.5,
)
agent = Agent(..., llm=llm)
```

Do not do `llm=ChatGoogleGenerativeAI(...)` unless that CrewAI version documents LangChain objects. The slash prefix (`openai/`, `gemini/`, `anthropic/`) *is* the provider.

---

## 7. IntelliJ MCP: CreateProcess error=193 on npx

Question: [79722494](https://stackoverflow.com/questions/79722494/intellij-idea-cannot-run-program-c-program-files-nodejs-npx-createprocess-e)

Error 193 on Windows means the path is not a Win32 application. `C:\Program Files\nodejs\npx` is a **shell shim** (npx.cmd), not an `.exe`. IntelliJ's MCP launcher uses `CreateProcess`, which will not run `.cmd` without `cmd.exe`.

```json
{
  "mcpServers": {
    "DaisyUI Docs": {
      "command": "cmd.exe",
      "args": ["/c", "npx", "-y", "mcp-remote", "https://gitmcp.io/saadeghi/daisyui"]
    }
  }
}
```

Or point `command` at `npx.cmd` with `"shell": true` if the JetBrains schema allows it. Installing Node via nvm-windows and using the full `npx.cmd` path is the same fix.

---

## 8. Spring AI MCP MVC Streamable HTTP + Kubernetes replicas

Question: [79962720](https://stackoverflow.com/questions/79962720/spring-ai-mcp-mvc-1-1-2-with-streamable-http-on-kubernetes-how-to-handle-mcp)

`Mcp-Session-Id` is a **process-local** map in typical Streamable HTTP servers (Spring AI MVC included). Replica A mints `abc123`; the Service load-balances `tools/call` to replica B; B has no session. Sticky ingress hides that until a rolling deploy or scale-in kills the pod.

Three production options (pick one; do not rely on accidental in-process affinity):

1. **STATELESS** (preferred when the tool only needs the authenticated principal). Do not mint `Mcp-Session-Id`. Spring: `spring.ai.mcp.server.protocol=STATELESS`. Cubiczan gateway: `MCP_SESSION_MODE=stateless` (default). Stamp the principal on every RPC / SSE frame — ThreadLocal will not survive the next replica.
2. **Externalize** the session (`SessionStore` / Redis). Any replica can serve the next call. Unknown ids must **fail closed** (`UNKNOWN_SESSION`), not return an empty 200.
3. **Sticky ingress** (cookie or hash of `Mcp-Session-Id`). Acceptable for short demos. Not acceptable as HA: deploys and scale-in produce `SESSION_STICKY_MISMATCH`. Clients must `initialize` again.

Cubiczan runbook with Kubernetes snippets and curl proofs: [`docs/streamable-http-multi-replica.md`](../streamable-http-multi-replica.md). This repo does not post the answer to Stack Overflow.

---

## Posting

These cannot be posted with the Stack Apps key alone. To publish: open each link, paste the corresponding section, or run Stack Exchange OAuth and `POST /2.3/questions/{id}/answers/add` with `access_token` + `key` + `preview=false`.
