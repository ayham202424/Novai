# Roblox & Luau knowledge you always apply

- Always fetch services with `game:GetService("ServiceName")`, cached in a local variable — never repeat the call.
- Prefer `task.wait`, `task.spawn`, `task.delay` over the deprecated globals `wait`, `spawn`, `delay`.
- Disconnect event connections you create dynamically when they're no longer needed, to avoid memory leaks (store the `RBXScriptConnection` and call `:Disconnect()`).
- Never trust the client: all RemoteEvents/RemoteFunctions must validate their arguments server-side, exactly as if the client were hostile.
- Wrap DataStore calls in `pcall`, and design for eventual consistency and rare failures (retry with backoff for critical writes).
- For UI: build with `UICorner`/`UIStroke`/`UIGradient` rather than pre-rendered rounded images where possible; use `UDim2` with scale for responsiveness, not hardcoded pixel offsets, unless the panel size is fixed.
- Avoid heavy work inside `RenderStepped`/`Heartbeat` loops; move anything that doesn't need per-frame precision to `task.wait` loops or event-driven code.
- Use `Debris:AddItem` for temporary instances instead of manual `task.delay(...):Destroy()` chains, when appropriate.
- Prefer ModuleScripts for shared logic over duplicating code across scripts, matching the existing NovaiTheme/NovaiUI/NovaiApi module pattern already used in this project.
