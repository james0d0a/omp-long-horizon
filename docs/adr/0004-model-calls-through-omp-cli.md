# Make Extraction and Reflection Model Calls Through the `omp` CLI

Extensions cannot reach OMP's model client: `@oh-my-pi/pi-ai` and `@oh-my-pi/pi-coding-agent` are bundled into the compiled binary and do not resolve from extension code, and `pi.pi` exposes no completion function (verified by probe on omp 18.18). `ctx.runEphemeralTurn` only uses the session's current model and sends the whole conversation. Extraction and trace-reflect therefore run `omp -p --no-session --no-tools --no-extensions --no-skills --no-rules --no-context-files --model @<role>` with the prompt on stdin, which resolves roles and provider auth exactly as OMP does and never recurses into this extension.

## Consequences

- Each call costs a process start (~1–2 s) on top of model latency; acceptable because Extraction runs in the background behind a watermark.
- A failing call (auth, quota, timeout) stalls the watermark and is reported loudly; there is no fallback provider, so data egress never silently changes (Q5).
