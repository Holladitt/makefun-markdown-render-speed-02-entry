# makefun-markdown-render-speed-02-entry

![competition](https://make.fun/badge/markdown-render-speed-02.svg)
![rank](https://make.fun/badge/markdown-render-speed-02/Holladitt/makefun-markdown-render-speed-02-entry/rank.svg)
![reward](https://make.fun/badge/markdown-render-speed-02/Holladitt/makefun-markdown-render-speed-02-entry/reward.svg)

A fast, dependency-free Markdown renderer that produces HTML byte-identical to [marked](https://github.com/markedjs/marked) 18.1.3 with default options (GFM on, breaks off, pedantic off, synchronous).

Built for the [Make Markdown rendering faster](https://make.fun/c/markdown-render-speed-02) competition on make.fun.

## Files

- `parse.js` — the renderer. Exports a single function `parse(markdown)` returning the HTML string. Dependency-free ES module, no network, stateless per call.
- `main.ts` — the sandbox driver. Reads `/input/cases.json`, renders each case in order with `parse`, writes `/output/html.json`.

## License

MIT — see [LICENSE](LICENSE).
