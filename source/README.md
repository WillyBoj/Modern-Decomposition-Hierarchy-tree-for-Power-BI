# Source code

The source for the Hierarchy Explorer Power BI visual, written in TypeScript with native SVG and
no third-party runtime libraries apart from Microsoft's Power BI API packages.

## Build

Requires Node.js 18 or later.

```bash
npm ci                 # install the pinned tools
npm test               # lint and unit tests
npm run package        # builds dist/*.pbiviz
npm run audit:cert     # build with the Power BI certification audit
npm start              # development server for Power BI developer mode
```

## Layout

| Path | Contents |
|---|---|
| `src/visual.ts` | The visual: drawing, interaction, selection, tooltips, animation, details panel |
| `src/tree.ts` | Builds the tree from the data and holds the focus rules |
| `src/layout.ts` | Layout, view fitting and the smooth zoom path |
| `src/details.ts` | Details panel values and initials |
| `src/format.ts` | Number formatting and label shortening |
| `src/settings.ts` | Format pane |
| `style/visual.less` | Styles |
| `capabilities.json` | Field wells and format pane properties |
| `test/` | Unit tests |
| `tools/generate_showcase.py` | Recreates the made-up example data in `../examples` |

## Notes

- Parent values are sums of their rows, so use additive measures.
- The visual reads up to 30,000 rows.
- `pbiviz.json` holds the visual's ID, version and author. Keep the ID unchanged in future
  versions so Power BI treats them as updates of the same visual.
