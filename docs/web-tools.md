# Web Tools: WebFetch and WebSearch

Claude Code includes `WebFetch` and `WebSearch` as built-in tools (both require permission). This package provides shims using freely available services: Jina Reader for fetching and Brave Search for searching.

## WebFetch

### How it works

`WebFetch` uses [Jina Reader](https://jina.ai/reader/) — a free public service that converts any URL to clean, readable markdown. You prepend `https://r.jina.ai/` to any URL and get back the page content stripped of navigation, ads, and other boilerplate.

No API key is required. No account needed. It just works.

```javascript
await WebFetch({ url: "https://docs.anthropic.com/en/docs/claude-code/tools-reference" })
```

### Parameters

```
WebFetch({ url, prompt? })
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `url` | string | The URL to fetch |
| `prompt` | string? | Optional hint about what to look for (included as a comment header, not used for extraction) |

### What gets returned

The full markdown content of the page, prepended with a comment header:

```
<!-- WebFetch: https://example.com/page -->

# Page Title

The main content as clean markdown...
```

If `prompt` is provided:
```
<!-- WebFetch: https://example.com/page | Focus: API rate limits -->
```

Output is truncated at 50KB with a notice if the page is large.

### Differences from Claude Code

| Behaviour | Claude Code | This shim |
|-----------|-------------|-----------|
| Extraction method | Proprietary | Jina Reader (r.jina.ai) |
| API key required | Yes (permission) | No |
| Output format | Markdown | Markdown |
| `prompt` parameter | Used to focus extraction | Stored as header comment only |
| JavaScript rendering | Yes | Depends on Jina |
| Auth-gated content | Handled by Claude | Not accessible |
| Rate limits | Claude account limits | Jina free tier limits |

The `prompt` parameter difference is worth noting: in Claude Code, the `prompt` guides what the model extracts from the page. In this shim, we return the full page content and include the prompt as a header comment so the calling model knows what to focus on when reading the result. The effect is similar — the model still gets the page and still knows what it was looking for — but the filtering happens at the model level rather than at fetch time.

### Tips

- **Documentation pages** work excellently with Jina Reader
- **GitHub repos and files** work well — use raw GitHub URLs for even cleaner output
- **SPAs and dashboards** may return limited content if Jina can't render JavaScript
- **Private/authenticated pages** will not work — Jina fetches as a public client

---

## WebSearch

### How it works

`WebSearch` calls the [Brave Search API](https://api.search.brave.com) directly. Brave provides a generous free tier (2,000 queries/month) that's more than sufficient for agent workflows.

### Setup

1. Create a free account at [api-dashboard.search.brave.com/register](https://api-dashboard.search.brave.com/register)
2. Create a **"Free AI"** subscription (no credit card required for the free tier)
3. Generate an API key under the subscription
4. Add to your shell profile:

```bash
export BRAVE_API_KEY="your-key-here"
```

If `BRAVE_API_KEY` is not set, the tool loads cleanly and returns a setup message with these instructions when called.

### Parameters

```
WebSearch({ query, count? })
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `query` | string | The search query |
| `count` | number? | Number of results (default: 5, max: 20) |

### What gets returned

A numbered list of results in markdown format:

```
1. **Result Title**
   https://example.com/page
   Description snippet from search results
   2 days ago

2. **Another Result**
   ...
```

Each result includes title, URL, snippet, and age where available.

### Differences from Claude Code

| Behaviour | Claude Code | This shim |
|-----------|-------------|-----------|
| Search provider | Claude's provider | Brave Search |
| API key required | Claude account | `BRAVE_API_KEY` (free) |
| Result format | Varies | Numbered markdown list |
| `count` parameter | Not exposed | Optional, default 5, max 20 |
| News/images | Available via Claude | Web results only |
| Rate limits | Claude account limits | 2,000/month free |

### Tips

- **Be specific** — Brave Search, like all search engines, works better with specific queries than vague ones
- **Combine with WebFetch** — search to find the right page, then fetch it for full content:

```javascript
const results = await WebSearch({ query: "pi coding agent extensions API" })
// Pick the most relevant URL from results, then:
const content = await WebFetch({ url: "https://...", prompt: "Extension API methods" })
```

- **Use for documentation lookups** — searching for `site:docs.anthropic.com TaskCreate` or similar patterns works well
- **The free tier resets monthly** — if you're running automated workflows that call WebSearch heavily, track your usage
