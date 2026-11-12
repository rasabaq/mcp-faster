# The mcp-faster web page

A static page: plain HTML, one CSS file and ES modules. There is no build step and no npm dependency.

## Run it

```sh
npm run site
```

Then open <http://localhost:4173>. The command runs `python3 -m http.server 4173 --directory site`,
so it needs Python 3. If port 4173 is taken, run that command yourself with another port.
The page needs a web server, because browsers do not load ES modules from `file://`.

## Refresh the data

Every number on the page comes from `data.js`. Do not edit that file by hand.

```sh
npm run site:data
```

The script (`src/site/cli.ts`) reads your Claude Code logs and the newest file in `bench-results/`,
and writes `data.js` again. Servers with private names become "Custom server N", and their tool names are left out.
`data.js` holds numbers from your own logs, so read it before you commit it. The script prints:

- the servers it hid. Add one to the allowlist in `src/site/data.ts` only if its name may be public.
- the tool names it will publish. Check that none of them names a client or a project.
- a warning for each claim in the page text that the new data breaks.

It refuses a bench run that stopped early or does not have exactly the four ways, because the page
cannot show it truthfully. It also refuses a stats report with no servers or no log files.

The words in three places were written for the local mirror winning against all upfront.
If the script warns, reread them:

- chapter 4 of the story ("The local mirror runs hottest")
- the three big numbers above the benchmark table
- the FAQ answer "Which way should I use?"

## Preview links

Headless browsers do not paint after a scroll, so these links show one part of the page without scrolling.
A page opened with `p`, `at` or `open` stands still: nothing animates.

| Link | What it shows |
|---|---|
| `?p=1.5` | The story frozen at a point from 0 to 3. `0` is chapter 1, `1.5` is halfway between chapters 2 and 3. |
| `?at=servers` | The page from that section down. Use a section id: `features`, `servers`, `score`, `bench`, `faq`, `start`, `footer`. |
| `?open=Slack` | The drawer of that server, open. Works together with `at=servers`. |
| `?menu` | The phone menu, open. |

## Files

| File | What it holds |
|---|---|
| `index.html` | The markup and all the words. A number from the data is an empty slot: `<span data-v="sessions"></span>`. |
| `styles.css` | All the styles, in the same order as the page. |
| `data.js` | Generated. The numbers from `mcp-faster stats` and `mcp-faster bench`. |
| `favicon.svg` | The logo. |
| `js/main.js` | Starts each part in order and runs the one animation loop. |
| `js/util.js` | Small helpers, number formats and the preview-link flags. |
| `js/values.js` | The table of values that fills the `data-v` slots. |
| `js/ways.js` | The names and descriptions of the four ways of the benchmark. |
| `js/heat.js` | The colour ramps and the glyph surfaces (the canvases filled with coloured characters). |
| `js/copy.js` | The copy buttons. |
| `js/features.js` | The mock screens in the feature cards, and the glow under the last call to action. |
| `js/servers.js` | The big numbers, the server tiles, the filters and the drawer. |
| `js/score.js` | The four stacked cards of the heat score. |
| `js/bench.js` | The sortable benchmark table. |
| `js/story.js` | The 600-dot canvas and its four chapters. |
| `js/nav.js` | Scrolling to a section, the phone menu, the current nav link and the progress line. |

## Change something

- **A word**: edit `index.html`. Names and descriptions of the four ways are in `js/ways.js`; health labels are in `js/servers.js`.
- **A number in the text**: add a `data-v="name"` slot in `index.html` and a value with that name in `js/values.js`.
  A slot with an unknown name stops the page with a clear error in the console.
- **The story canvas**: the maths in `js/story.js` is the approved design. Take screenshots with the preview links before and after a change.
- **The story layout**: `styles.css` decides it, and `js/story.js` reads it. The phone layout (text under the canvas) sets `--phone: 1`,
  and a short screen (a phone on its side) sets `--short: 1`. Change the media queries there, not a width in the script.
