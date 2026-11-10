# SEP-XXXX: Response Compaction Manifests

- **Status**: Draft
- **Type**: Extensions Track
- **Created**: 2026-11-10
- **Author(s)**: mcp-faster contributors
- **Sponsor**: None (seeking sponsor)
- **PR**: Not filed yet

## Abstract

Tool results are often much larger than the model needs. A chat message from a typical API has
dozens of fields. The model needs four of them. The rest costs tokens on every call.

Only the server author knows which fields are safe to cut. Dropping `thread_ts` from a Slack
message makes the next call (a reply in the thread) impossible. So a client cannot guess.

This SEP defines an extension, `io.modelcontextprotocol/response-compaction`. A server puts a small
manifest in each tool's `_meta`. The manifest maps result fields to one of three policies: `keep`,
`drop` or `summarize`. When a result is over the client's token budget, the client (or a proxy
acting for it) cuts what the manifest allows. It never cuts a `keep` field. It keeps what it cut and
gives the model a tool to read the cut content back, page by page, with a cursor.

Compaction is deterministic and needs no model call. The server does not change how it answers
calls. A client that does not know the extension sees no change.

## Motivation

Anthropic's guide "Writing effective tools for agents" gives server authors three tools against
large results: a `response_format` parameter with `concise` and `detailed` values, pagination and
filtering with sensible defaults, and truncation that tells the agent what to do next. It also
notes that Claude Code limits tool responses to 25,000 tokens by default.

This is advice, not protocol. Each server must build it. Many do not. When a server does not, the
client has two bad options:

1. Pass the whole result to the model. This wastes context on every call.
2. Cut the result blindly, for example at a character limit. This can remove the one field the next
   call needs. IDs look like noise to a heuristic, but they are often the most important fields.

The knowledge of what is safe to cut lives with the server author. Today there is no place to write
it down. This SEP adds that place, plus the client behaviour that uses it.

Measured on three synthetic results shaped like real server families (see
[Reference Implementation](#reference-implementation)), compaction under a budget cut the
estimated token count by 76 to 94 percent, kept every `keep` field, and returned exactly the cut
content through the cursor.

## Specification

The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are to be read as described in BCP 14
(RFC 2119, RFC 8174) when, and only when, they appear in all capitals.

**Applier**: the party that applies a manifest. This is the client, or a proxy that sits between
the client and the server. The server is never the applier.

### Extension identifier and negotiation

The extension identifier is `io.modelcontextprotocol/response-compaction`.

A server that ships manifests SHOULD list the extension in `capabilities.extensions` with an empty
settings object. Clients MUST NOT require this: the manifest on a tool is enough.

The client does not need to declare anything. The server's results do not change, so the server
does not need to know whether the client compacts.

### Where the manifest lives

The manifest is the value of `_meta["io.modelcontextprotocol/response-compaction"]` on a `Tool`
in the `tools/list` result.

```json
{
  "name": "read_channel",
  "description": "Read recent messages from a channel.",
  "inputSchema": {
    "type": "object",
    "properties": { "channel": { "type": "string" } },
    "required": ["channel"]
  },
  "_meta": {
    "io.modelcontextprotocol/response-compaction": {
      "fields": {
        "/channel": "keep",
        "/messages/*/ts": "keep",
        "/messages/*/thread_ts": "keep",
        "/messages/*/user": "keep",
        "/messages/*/text": "summarize",
        "/messages/*/blocks": "drop",
        "/messages/*/reactions": "drop",
        "/messages/*/files": "drop",
        "/messages/*/files/*/id": "keep"
      }
    }
  }
}
```

### Manifest format

A manifest is a JSON object. The JSON Schema is in
[`compaction-manifest.schema.json`](compaction-manifest.schema.json).

- `fields` (required): an object. Each key is a path. Each value is a policy: `keep`, `drop` or
  `summarize`.
- Appliers MUST ignore members they do not know. Later versions MAY add optional members.
- An applier MUST treat a manifest that does not match the schema as no manifest.

### Paths

A path is a JSON Pointer (RFC 6901) with one addition: the segment `*` matches every array element
and every object member at that level. The empty path `""` is the whole value.

A path that matches nothing in a result is ignored.

### What a manifest applies to

One manifest applies to every value in a `CallToolResult` that it can address:

| Part of the result | Root value the paths start from | What happens |
| --- | --- | --- |
| `structuredContent` | the `structuredContent` object | Paths apply. See the `outputSchema` rule below. |
| Text block whose text parses as a JSON object or array | the parsed value | Paths apply. The applier writes the value back as JSON. Whitespace MAY change. |
| Text block that is a JSON copy of `structuredContent` | — | It follows `structuredContent`: the applier SHOULD write the compacted `structuredContent` as its text, and SHOULD NOT store its cut parts twice. |
| Text block that is not JSON | the text, as one string | Only the rule for `""` can match. |
| Image, audio, resource link, embedded resource | — | MUST NOT change. |
| A result with `isError: true` | — | MUST NOT change. |
| The result's `_meta` | — | MUST NOT change, except for the key this SEP adds. |

**`outputSchema` rule.** Clients validate `structuredContent` against the tool's `outputSchema`
(the TypeScript SDK client does this by default). If the compacted `structuredContent` does not
validate, the applier MUST return the original `structuredContent` instead. Servers SHOULD NOT mark
as `drop` a member their `outputSchema` lists as `required`.

### Policies

- **`keep`**: the value MUST be in the compacted result. If it is a string, number, boolean or
  null, it MUST be unchanged. If it is an object or array, it MUST be there, and rules on its
  descendants still apply.
- **`drop`**: the applier MAY remove this object member.
- **`summarize`**: the applier MAY shorten the value:
  - A string keeps its first characters, followed by the marker `… [cut N chars]`, where `N` is
    the number of UTF-16 code units removed. The applier MUST NOT split a surrogate pair.
  - An array keeps its first elements. The rest are cut.
  - An object is not shortened itself. `summarize` passes down to its members.
  - Numbers, booleans and null do not change.

Summaries are mechanical. The applier MUST NOT call a model to summarize. The same result, manifest
and budget MUST give the same compacted result (except the cursor value).

### Which policy applies to a value

1. If one or more paths match the value exactly, their policy applies. If they disagree, `keep`
   wins over `summarize`, and `summarize` wins over `drop`.
2. If no path matches, the value takes the policy of its parent. The root value takes `keep`.
3. **Protection.** If a `keep` path lies below a value, that value MUST NOT be removed, and if it is
   an array it MUST NOT be shortened. Its children are handled by these same rules. This is what
   makes "drop the files, but keep each file's id" work.
4. Some values cannot be removed: the root value, and array elements. For them, `drop` acts as
   `summarize`. Array elements are never removed one by one, so array indexes never shift. The
   only way an array loses elements is a `summarize` that cuts its tail.

A manifest can be a blocklist (root stays `keep`, list what may go) or an allowlist (`"": "drop"`,
list what must stay):

```json
{
  "fields": {
    "": "drop",
    "/total": "keep",
    "/issues/*/id": "keep",
    "/issues/*/key": "keep",
    "/issues/*/title": "keep",
    "/issues/*/state": "keep",
    "/issues/*/url": "keep",
    "/issues/*/body": "summarize",
    "/issues/*/labels": "summarize"
  }
}
```

### Token budget

The **budget** is the most tokens the applier wants one tool result to take in the model's
context. The applier sets it, for example from its configuration or from the context it has left.
It is never sent to the server.

- The applier estimates tokens over `content` and `structuredContent`, including the notice it
  adds. It MAY use a rough estimate, such as characters divided by four. This SEP does not name a
  tokenizer.
- If the result fits the budget, the applier MUST NOT change it.
- If not, the applier applies the policies. It SHOULD cut no more than it needs to fit. For
  example, it can try `drop` alone first, then shorten `summarize` values in steps.
- `keep` wins over the budget. If the result still does not fit after every allowed cut, the
  applier returns it over budget and says so in the notice.

### The notice

When the applier cuts anything, it:

1. MUST append one text block to `content`. The block tells the model, in plain words: the size
   before and after, which paths were cut and how many values each, that text ending in
   `… [cut N chars]` is shortened, the cursor, how to read the cut content, and that shortened
   values must not be sent back to a tool. It is appended last so that `content[0]` keeps its place.
2. MUST add `_meta["io.modelcontextprotocol/response-compaction"]` to the result:

```json
{
  "cursor": "9b7f65ae-52cc-4ecf-b69c-52a60eda4b50",
  "cut": 6,
  "tokensBefore": 625,
  "tokensAfter": 252,
  "budget": 300
}
```

### Reading the cut content

The applier MUST keep what it cut and MUST offer a tool the model can call to read it. The applier
names the tool. The reference implementation calls it `compaction_more`. The applier SHOULD list the
tool only when at least one tool has a manifest. It MUST NOT list it under a name an upstream tool
already uses.

Input:

- `cursor` (string, required): the cursor from the notice, or from an earlier page.
- `path` (string, optional): return only cut content at or below this path, or the cut piece that
  holds this path.

Output, as JSON in one text block. There is no `structuredContent` copy, because it would double
the size of every page:

```json
{
  "pieces": [
    { "path": "/structuredContent/messages/0/text", "offset": 40, "value": "failed? The log says the cache key changed after the lockfile update." },
    { "path": "/structuredContent/messages/0/blocks", "value": [{ "type": "rich_text", "block_id": "a1" }] }
  ],
  "cursor": "1f0c2a5e-8f53-4f7e-9d0e-3c1b8a2f6d10"
}
```

(Values are short here to keep the example small.) Pieces come in document order. Only the last
piece on a page can be a partial slice of a string.

- `path` is a JSON Pointer into the original `CallToolResult`. It starts with `/structuredContent`
  or `/content/{i}/text`. For a text block that holds JSON, the pointer goes on into the parsed
  value, for example `/content/0/text/issues/3/body`. Array indexes are the original indexes. They
  are also the indexes in the compacted result, because elements never shift.
- A piece without `offset` is a whole value that was removed: an object member, or an element from
  a cut array tail.
- A piece with `offset` is a slice of the original string that starts at that offset.
- `cursor` is present when more pieces are left.

**Exactness.** Taking the compacted result (without the notice) and applying every piece in order
MUST give back the original result. To apply a piece without `offset`, set the value at `path`. To
apply a piece with `offset`, take the current string at `path` (empty if missing), keep its first
`offset` characters, and append `value`. Pieces MUST NOT hold content that was not cut.

**Paging.** Each page SHOULD fit the budget. A long string is split into slices with offsets. The
applier MAY return a single non-string piece over budget.

**Cursors.** A cursor is opaque. Calling with the same cursor again MUST return the same pieces. The
applier MUST bind cursors to the caller and MUST NOT return cut content to a different caller. The
applier MAY expire cursors. For an unknown or expired cursor, it returns a tool result with
`isError: true` that tells the model to call the original tool again.

### Writing shortened values back

A model can read a shortened issue body and send it back in an update. That would destroy data. An
applier SHOULD reject a `tools/call` whose arguments contain the marker `… [cut N chars]`, with a
tool result that has `isError: true` and tells the model to read the full value first. The call
MUST NOT reach the server.

### No manifest

If a tool has no manifest, or an invalid one, the applier does nothing. The result passes through
unchanged. No notice is added. If no tool has a manifest, the "more" tool is not listed.

### Example

The `read_channel` tool above returns one message: about 625 tokens, counting `structuredContent`
and its JSON text copy. With a budget of 300 tokens, the applier returns this `structuredContent`.
The JSON text copy in `content[0]` matches it, and the notice is appended as `content[1]`. All of
it together is about 252 tokens.

```json
{
  "ok": true,
  "channel": "C0123",
  "messages": [
    {
      "user": "U0101",
      "ts": "1762790000.000100",
      "thread_ts": "1762790000.000100",
      "text": "Can someone check why the nightly build … [cut 371 chars]",
      "files": [{ "id": "F0001" }]
    }
  ]
}
```

The model can still reply in the thread (`ts`, `thread_ts`) and open the file (`files[0].id`).
If it needs the file name, it calls `compaction_more` with the cursor and
`path: "/structuredContent/messages/0/files"`.

## Rationale

### Why the server declares it

Only the server author knows that `thread_ts` is needed for the next call and `blocks` is a second
copy of `text`. A heuristic in the client cannot know this. A wrong guess fails silently: the model
gets a smaller result and then cannot do the next step. A small declared contract fails safe: no
manifest means no change.

### Why tool `_meta`

- It travels with `tools/list`, which every client already fetches and caches (with `ttlMs` since
  SEP-2549). No extra request.
- It is per tool, which is the right grain. Each tool has its own result shape.
- It changes when the tool changes. A server that changes a result shape changes the manifest in
  the same place, and `notifications/tools/list_changed` covers both.
- `_meta` already exists on `Tool`, and clients ignore keys they do not know. No schema change.

Alternatives:

- **A resource** (for example `compaction://manifest`): needs an extra read, a separate cache, and
  a way to tie it to tool list changes. Nothing is gained.
- **`ToolAnnotations`**: annotations are a typed core schema object. Adding a field there is a core
  change, not an extension.
- **A keyword inside `outputSchema`** (for example `"x-compaction": "drop"` on a property): this
  is attractive for `structuredContent`. But many tools have no `outputSchema`, and it cannot
  describe JSON in text content or plain text. A future version could allow both.
- **Server Card**: describes the server, not each tool's result, and clients may not fetch it.

### Why the client applies it, not the server

A server-side design would send a budget with each `tools/call` and have the server cut and page.
That needs every server to build compaction and keep cursor state, which works against stateless
servers (SEP-2567, SEP-2575). With a client-side applier, one implementation in each client or
proxy covers every server that ships a manifest, and the server only ships data.

The cost: the server still sends the full result over the wire. This SEP saves model context, not
bandwidth. A server that wants to save bandwidth should still paginate and filter.

### Why a tool for "more"

The model must be able to ask for the cut content. Options:

- **A tool added by the applier (chosen).** Every client can show it. The model already knows how
  to call tools. No server change. It costs one tool definition in the list.
- **A reserved argument on every tool** (for example `_cursor`). This changes every input schema,
  can clash with real arguments, and breaks schemas with `additionalProperties: false`. Worst, the
  model would call `send_message` again to read more. If the applier lost the cursor, that call
  would reach the server and send a second message.
- **A `resource_link` to the cut content.** It fits MCP well, but many clients do not let the model
  read resources, and the applier would need to serve `resources/read`.
- **A new protocol method.** The cut content lives in the applier, not the server, so a method
  between client and server does not fit.

### Why JSON Pointer with `*`

JSON Pointer is already used across JSON Schema and JSON Patch, and has a precise escape rule.
One wildcard covers the common case: "this field of every item". JSONPath (RFC 9535) is much larger
(filters, recursive descent) and is not needed to name fields. Dotted paths have no escape rule.

### Why mechanical summaries

A model call would cost money and time, could invent content, and would make the result differ from
run to run. A cut with a marker is cheap, honest and repeatable. The model can always read the rest.

### Why `keep` beats the budget, and why lists are not paged

If an item holds a `keep` field, cutting the item would hide that field. So the applier never cuts
an item that holds a `keep` field, even when the result stays over budget. The number of items in a
list stays the server's job, through its own pagination arguments. Compaction cuts fields.

### Relation to existing guidance

- **`response_format` (`concise` / `detailed`)**: the model picks, and the server must build both
  shapes. A manifest needs no second shape. The two work together: a `concise` result usually fits
  the budget, so the applier does nothing.
- **Pagination**: the server's pagination limits how many items it fetches and returns. The
  compaction cursor only reads cut content held by the applier. It never calls the server. It is not
  the protocol's `Cursor` type for list methods.
- **Truncation with instructions**: the notice is exactly that, done the same way for every server.

### Prior art

- `mcp-spine` minifies tool schemas. That is the tool list, not results.
- `mcp-cache` splits responses over 900 KB. That is a size guard, not a token budget, and it has no
  per-field policy.
- Partial responses in web APIs (Google APIs `fields`, JSON:API sparse fieldsets, GraphQL selection
  sets) let the caller pick fields. That needs the caller to know the shape and the server to build
  the feature. Here, the server declares once and the client does the work.

No earlier SEP or issue in the `modelcontextprotocol` repository proposes per-field result
compaction, as far as a search on 2026-11-10 found.

## Backward Compatibility

None. The manifest is a new `_meta` key, which clients that do not know it ignore. Servers do not
change their results. An applier adds one tool to the list the model sees, and MUST NOT shadow an
existing tool.

## Security Implications

- **No new data exposure.** Compaction only removes content from what the server already returned
  to this caller.
- **Cut content is user data held by the applier.** The applier MUST bind cursors to the caller and
  MUST NOT serve them across callers. A shared proxy is the main risk. Cursors SHOULD be
  unguessable, SHOULD expire, and cut content SHOULD NOT be logged.
- **Data loss on write-back.** See [Writing shortened values back](#writing-shortened-values-back).
  A shortened array has no marker, so the guard cannot catch it. Servers SHOULD mark as `keep` any
  field that a write tool expects back whole.
- **Hidden content.** A dropped field can hold a warning the user should see. Hosts that show tool
  results to the user SHOULD show the original result, not the compacted one.
- **Untrusted manifests.** The manifest comes from the server, which already controls the result,
  so a bad manifest can only hide that server's own content. Appliers MUST validate the manifest and
  MAY limit the number of paths to bound work.
- **Marker in server data.** A server can put the marker text in its data. The write-back guard then
  blocks a call. This fails safe.

## Reference Implementation

The `compact` layer of `mcp-faster` (`src/compact/index.ts`), a proxy layer that sits between any
client and any MCP server. Tests are in `src/compact/compact.test.ts`. It is not yet in an official
SDK, which SEP-2133 requires before review.

Measured on synthetic results. Tokens are estimated as characters divided by four: text blocks by
their text, `structuredContent` by its JSON. "After" includes the notice.

| Result shape | Budget | Before | After | Drop | Pages to read all cut content |
| --- | --- | --- | --- | --- | --- |
| Chat message list, 40 messages (`structuredContent` plus JSON text copy) | 5000 | 17240 | 4217 | 76% | 3 |
| Issue tracker search, 25 issues (pretty-printed JSON in text, allowlist manifest) | 2500 | 10909 | 1989 | 82% | 4 |
| Document fetch (JSON metadata block plus long markdown text) | 1000 | 6738 | 426 | 94% | 8 |

The reference implementation tries fixed steps (drop only, then strings at 1000, 200 and 40
characters). This is why the document lands far under its budget: the next larger step did not fit.

The tests also check that every `keep` field survives unchanged, that applying the pieces gives back
the original result exactly, that a result with no manifest passes through untouched, and that the
example manifests in this document match the JSON Schema.

### Performance Implications

The applier walks each JSON value once per step it tries, checking each node against the paths.
Cost grows with result size times the number of paths. The reference implementation tries at most
four steps. Cut content is held in memory until the cursor expires.

### Testing Plan

Conformance cases for an applier:

1. No manifest: the result is byte-for-byte unchanged.
2. Under budget: unchanged.
3. `isError: true`: unchanged.
4. Every `keep` path keeps its value, including under a `drop` parent.
5. Applying all pieces gives back the original.
6. A compacted `structuredContent` that breaks `outputSchema` is returned whole.
7. A cursor from caller A fails for caller B.
8. A call whose arguments contain the marker does not reach the server.
9. Non-JSON text and JSON text are both handled; images and resources are untouched.

## Open Questions

1. **Literal `*` keys.** A member named `*` cannot be addressed. Is an escape (for example `~2`)
   worth adding?
2. **Size hints.** Should a path carry a size, such as `{"summarize": {"maxChars": 200}}`, or is the
   applier's choice enough?
3. **Opting out per call.** Should the model be able to ask for the full result, like
   `response_format: "detailed"`? It can read everything through the cursor today, at the cost of
   extra calls.
4. **Several result shapes.** One manifest applies to every value in a result. Should paths be able
   to target one content block?
5. **Embedded resources.** Should text inside an embedded resource be compacted?
6. **Item paging.** Should a server be able to say "items of this list may be cut even though they
   hold `keep` fields", so the applier can page long lists?
7. **Checking against `outputSchema` early.** Should appliers check the manifest against
   `outputSchema` at `tools/list` time, instead of validating each result?
8. **Standard tool name.** Should the "more" tool have a fixed name, so models can learn it?
9. **Marker format.** Is `… [cut N chars]` clear across languages? Should the marker be fixed by
   the spec, as it is now, so guards can find it?
10. **Identifier before acceptance.** The prototype uses the proposed `io.modelcontextprotocol/`
    key, which is reserved for MCP. Should drafts use a different prefix until accepted?
11. **Working group and maintainers.** SEP-2133 asks an Extensions Track SEP to name them. None yet.
