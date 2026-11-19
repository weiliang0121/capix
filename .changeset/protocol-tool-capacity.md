---
'@weiliang0121/capix-tool': minor
---

Handle tool arguments, feedback and recovery across Chat Completions, Responses, Messages and Gemini through the common provider contract. Runs with a wire byte limit and pending feedback or context require a synchronous `reserveWireBytes` inspection method. Built-in providers implement it.

Tool identifies its optional trailing user context when reserving the next request. Fixed messages keep their measured wire size while the provider reserves growth for the context text and pending feedback.

Tool catalog precheck policy v5 rejects runs saved under earlier catalog digests, including Chat-only runs. Start a new invocation after upgrading. Tool checkpoint v5 and model node checkpoint v3 retain their formats. Cold confirmation reads the original interaction and feedback; saved capacity decisions also require their effective limits to match.
