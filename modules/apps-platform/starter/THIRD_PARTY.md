# Third-party code and designs

Component source vendored into this starter (the shadcn way: copied, then owned here), and where designs were taken
from. Only MIT or Apache-2.0 sources; no paid or "pro" templates.

| What | Source | Licence |
|---|---|---|
| `src/components/ui/*` (every shadcn/ui component, added with `bunx shadcn@4.23.0 add`, then adapted to the theme and CSP) | shadcn/ui, https://github.com/shadcn-ui/ui | MIT, Copyright (c) 2023 shadcn |
| `src/components/blocks/combobox.tsx`, `date-picker.tsx`, `command-palette.tsx`, `table-toolbar.tsx`, `settings.tsx` (patterns from shadcn's combobox, date picker, command, data-table example and settings blocks; code written here) | shadcn/ui, https://ui.shadcn.com | MIT, Copyright (c) 2023 shadcn |
| `src/components/blocks/tracker.tsx`, `kpi.tsx` (after Tremor's Tracker and KPI cards; code written here, no Tremor code) | Tremor, https://github.com/tremorlabs/tremor | Apache-2.0 |
| `src/components/blocks/stepper.tsx`, `timeline.tsx` (after Origin UI's stepper and timeline; code written here) | Origin UI (legacy, MIT), https://originui.com | MIT |
| `src/styles/presets/slate.css`, `minimal.css`, `graphite.css` (colours adapted from tweakcn's Clean Slate, Modern Minimal and Graphite presets, changed to pass AA) | tweakcn, https://github.com/jnsahaj/tweakcn | Apache-2.0 |
| `src/styles/tokens.css` colour steps | Radix Colors, https://github.com/radix-ui/colors | MIT, Copyright (c) 2021 Radix |

npm dependencies the components use: `radix-ui` (MIT), `cmdk` 1.1.1 (MIT; Command), `react-day-picker` 10.0.2 (MIT;
Calendar, with `date-fns` underneath), `lucide-react` (ISC), `class-variance-authority`, `clsx`, `tailwind-merge`
(MIT).

The MIT licence (shadcn/ui, Origin UI, Radix Colors, cmdk, react-day-picker): permission is hereby granted, free of
charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to
do so, subject to the following conditions: the above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE
OR OTHER DEALINGS IN THE SOFTWARE.

Apache-2.0 (Tremor, tweakcn): https://www.apache.org/licenses/LICENSE-2.0. The preset files say what was adapted.
