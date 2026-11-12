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

The words in two places assume that the local mirror beats all upfront.
If the script warns, reread them in `index.html`:

- the "winner" row under "what it measured"
- the FAQ answer "which way should I use?"

## Take a screenshot

Add `?still` to the address, for example <http://localhost:4173/?still>. A still page skips the orange loader,
draws one frame of the horse, shows the race bars at their final length and warms up every server tile at once.
Headless browsers do not run animations reliably, so use a still page for screenshots.

A visitor who turns on reduced motion in their system settings gets the same still page.

## Files

| File | What it holds |
|---|---|
| `index.html` | The markup and all the words. A number from the data is an empty slot: `<span data-v="sessions"></span>`. |
| `styles.css` | All the styles, in the same order as the page. |
| `data.js` | Generated. The numbers from `mcp-faster stats` and `mcp-faster bench`. |
| `favicon.svg` | The logo. |
| `js/main.js` | Fills the numbers, then starts each part of the page. |
| `js/util.js` | Small helpers, number formats, the `?still` flag and the reduced-motion flag. |
| `js/values.js` | The table of values that fills the `data-v` slots. |
| `js/ways.js` | The names and descriptions of the four ways of the benchmark. |
| `js/heat.js` | The colour ramp from cold blue to hot cream, and the 0 to 100 heat score. |
| `js/intro.js` | The orange loader and the headline lines that slide in. It plays once per visit. |
| `js/art.js` | Draws the horse in coloured characters on the hero canvas, and heats it up under the mouse. |
| `js/horse-frames.js` | Generated. The 15 frames of the horse, one hex digit of darkness per character cell. |
| `js/copy.js` | The copy buttons. |
| `js/servers.js` | The server tiles, the label filters, the warm-up on scroll and the label rules in the FAQ. |
| `js/logos.js` | The server logos (Simple Icons, CC0) and the two-letter monograms for servers without one. |
| `js/bench.js` | The benchmark race and the results table. |

## Change something

- **A word**: edit `index.html`. Names and descriptions of the four ways are in `js/ways.js`. Health labels are in `js/servers.js`.
- **A number in the text**: add a `data-v="name"` slot in `index.html` and a value with that name in `js/values.js`.
  A slot with an unknown name stops the page with a clear error in the console.
- **A logo**: add the icon's colour and SVG path from [Simple Icons](https://simpleicons.org) to `ICONS` in `js/logos.js`,
  then map the server name to it in `LOGO`. Simple Icons no longer has a Slack logo, so Slack shows a monogram.
- **The horse**: `js/horse-frames.js` comes from Eadweard Muybridge's *The Horse in Motion* (1878, public domain).
  To build it again, run `node scripts/horse-frames.ts`. The script needs `ffmpeg`. It downloads the GIF from
  Wikimedia Commons, or reads a GIF path that you pass as an argument.
