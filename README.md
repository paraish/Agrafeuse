<p align="center"><img src="assets/icon.svg" width="120" alt="Agrafeuse logo: a staple"></p>

# Agrafeuse

[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.23693687.svg)](https://doi.org/10.5281/zenodo.23693687)

**Graphs and statistics with R and ggplot2, in your browser.** Point and click to build figures and run statistics, with the flexibility of R underneath: no code needed, and the code is there when you want it.

- **No server, no install.** R runs inside the browser tab ([webR](https://docs.r-wasm.org/webr/latest/)). The app is a folder of static files you can host on GitHub Pages or open from your own computer.
- **Your data stays on your computer.** Nothing is uploaded anywhere.
- **Reproducible.** Every table, analysis and graph is real R code you can see, copy, and run in RStudio.
- **Save everything as `.RData`**, then reopen it in Agrafeuse, or `load()` it in R.

![The graph builder](docs/graph.png)

## What you can do

| | |
|---|---|
| **Enter data** | Type straight into a spreadsheet, paste a block from Excel, import CSV/TSV, open an `.RData` file, or start from a built-in R dataset. Column tables (one column per group), XY tables and long tables. Drag a column by the ⋮⋮ in its header to move it (or use the arrow buttons, or Ctrl+Shift+←/→). **Calculated columns** (like dplyr's `mutate()`): click the **ƒ** on a column's header (or **Calculated column**) and pick what to do — log10 / log2 / ln, square root, × ÷ + − a number, % of the mean, first or largest value, centred, z-score, rank, ratio, difference, sum or % change with another column, the mean of several columns, groups above / below a threshold — or type any R expression. R previews the values; the column updates whenever the data change, and can be turned into plain values. Every table has a row of column names and an optional row-names column (e.g. subject IDs), which R receives as a `row_name` column, so it survives transforms and can identify subjects in paired and repeated-measures tests. |
| **Transform** | Wide → long (melt / `pivot_longer`), long → wide, transpose, filter rows (by value or any R condition), reorder groups, rename, calculate a column with any R expression (log10, % of control, z-score…), change column types, keep/drop columns, summarise by group, count, sort, first / last / top rows (`slice`), remove duplicates (`distinct`) or missing values, a correlation matrix as one row per pair of columns (`correlate`), and `group_by` / `ungroup` so that the steps in between work within each group (e.g. % of each group's mean, top 3 per group). Steps chain together; the original table is never changed. |
| **dplyr pipeline** | Every data table has a pipeline panel on its right. Add dplyr steps with **+**, drag them to change their order, click one to edit it, or turn it off. Each step shows on one line, with the number of rows × columns after it, and a step that fails is flagged with R's message. Steps after a `group_by` are nested under it, until `ungroup` or a `summarise`. The result shows in place of the grid (switch back with the tabs). Turn it into a **new data table**, or into a **linked transform** that updates when the table changes. |
| **Graph** | A layered ggplot2 builder. **Whole plot** sets the data and the aesthetics every layer inherits, like `ggplot(data, aes(x, y, colour, group…))`, including a **group** aesthetic for one line, fit or box per subject without colouring them. Each layer picks one of 23 geoms (points, jitter, dot plot, bars at the mean, error bars, box, violin, histogram, lines, fitted lines, heatmap tiles, text, reference lines…), and for each aesthetic (colour, fill, symbol, size, opacity, line type, group) uses the plot's mapping, its own column, a fixed value, or none. Press **Add layer** to stack more. Templates for the usual figures and a box for any extra ggplot2 code. Under the graph, a formatting panel sets axis titles and tick labels (size, **bold**, *italic*, underline, angle), scales (linear, log, square root, reversed), ranges, tick spacing and number formats, the graph title, font, themes (including a clean "lab figure" look), palettes or per-group colours, the legend and panels (facets). Drag the graph's edges to resize it, and drag along an axis to stretch or shrink its range (double-click the axis to reset it). Axis ranges zoom with `coord_cartesian()`, so points outside the range still count towards means, error bars and fits. |
| **Statistics** | t tests (unpaired / Welch, paired, ratio paired, one-sample), Mann-Whitney, Wilcoxon, one-way ANOVA with Tukey / Dunnett / Šidák / Bonferroni / Holm / FDR, Welch's ANOVA with Games-Howell, Kruskal-Wallis with Dunn's test, repeated-measures ANOVA, Friedman, two-way ANOVA (Type III or I) with simple-effects comparisons, mixed-effects models, correlation (Pearson, Spearman, Kendall) between two columns or as a **correlation matrix** of many (r, P values adjusted for the number of pairs if you like, n and 95% CIs), regression (linear, polynomial, log, exponential, power, 4-parameter dose-response with EC50, Michaelis-Menten, one-phase decay), descriptive statistics and normality tests. Each test has a plain-language explanation. |
| **Stats on graphs** | **Compare groups** right on the graph, like ggpubr's `stat_compare_means`: Welch's or Student's t tests or Mann-Whitney / Wilcoxon tests, all pairs or each against a control, paired by subject if needed, between the groups on the X axis or between side-by-side groups within each X group, with Holm / Bonferroni / FDR adjustment and the overall test (ANOVA, Welch's ANOVA, Kruskal-Wallis, Friedman) in a corner. Or draw the results of a full analysis: P value brackets (stars or numbers, stacked automatically), result text in a corner, fitted curves with confidence bands. |
| **Correlation plots** | A **correlation heatmap**: tiles coloured by r (viridis by default, or magma, plasma, cividis…, blue–red, or two or three colours of your own, with an adjustable range), with r, r and stars, r and its P value (with or without "p ="), stars or P values written in, over the full square or one triangle. A **scatterplot matrix**: each pair of columns as an XY plot, with a regression line (with or without an intercept; solid, dashed or dotted; any width and colour; optional confidence band) or a smoother, points coloured by a group if you like, and r with its P value in each panel. Both from the graph gallery, or from a correlation matrix analysis (**Make a heatmap**). |
| **Text boxes** | Add text anywhere on a graph (several lines, size, colour, bold / italic, alignment, with or without a box), and drag it into place on the preview, or give its position in axis units. |
| **Assistant** | A pane on the right of every screen: ask in plain words ("compare weight between the groups and show it on a bar graph", "which test should I use?"). The assistant proposes steps (pipeline steps, analyses, graphs, compared groups, titles…); you check them and apply them, and one undo takes them all back. It runs a free model in your browser (opt-in download) or connects to LM Studio, Ollama or any OpenAI-compatible API. |
| **Export** | PDF, SVG, PNG or TIFF at any size and resolution. SVG keeps its text as text, so it can be edited in Illustrator or Inkscape (through the svglite package; if that cannot load, the text is drawn as shapes). The R script for the whole project; the project as `.RData`. |

| Data entry | Transforms | Statistics |
|---|---|---|
| ![](docs/data.png) | ![](docs/transform.png) | ![](docs/stats.png) |

## Getting started

### Put it online with GitHub Pages (recommended)

1. Push this folder to a GitHub repository.
2. In the repository: **Settings → Pages → Build and deployment → Deploy from a branch**, choose `main` and `/ (root)`.
3. Open `https://<your-user>.github.io/<repository>/`.

It is still "local": the page is just files, and everything runs in each visitor's browser.

### Or run it on your computer

Browsers will not run webR from a file opened by double-clicking, so serve the folder with any static web server:

```sh
cd agrafeuse
python3 -m http.server 8000      # then open http://localhost:8000
```

The first start downloads R (about 30 MB) and a few R packages from the webR package repository. Your browser keeps them cached, so later starts take a few seconds. An example project (one dataset, taken through a transform, a one-way ANOVA and a graph) opens on first visit; **New** starts a blank one.

## The assistant

Open it from the **Assistant** strip on the right, and choose a model once:

- **A model in this browser** (free, private). Runs with [WebLLM](https://github.com/mlc-ai/web-llm) on your graphics card: nothing leaves your computer. Nothing is downloaded until you pick a model and click **Download and start** (2–6 GB the first time; the browser keeps it). Needs WebGPU: recent Chrome or Edge, and a reasonable graphics card. Qwen3 4B is a good default; Qwen3 8B is better if your card can take it.
- **LM Studio or Ollama on your computer** (free, private). Start the server and let this site call it: in LM Studio, *Developer → Start server* and turn on *Enable CORS*; for Ollama, `OLLAMA_ORIGINS="https://paraish.github.io" ollama serve`. Your browser may ask whether the site may reach apps on your computer: allow it. Larger local models (7–14B) answer better than the in-browser ones.
- **An online API** with your own key: OpenAI, OpenRouter (has free models), Google Gemini (free tier) or any OpenAI-compatible server. The key stays in your browser (and only if you tick *Remember*).

What the model sees: the names of your items, their columns, column types and group names, and what you ask. **Data values and analysis results are only included if you allow it** (the *Let it see data values and results* box, on by default only when the model runs on your computer). With an online API, whatever is sent is handled under that company's rules.

The assistant does not change anything by itself: it proposes steps, and you choose which to apply. Every step is an ordinary step, layer or analysis you can inspect and edit, with its R code; one undo removes a whole batch.

**It plans first.** The model first thinks about what you asked (its thinking is shown) and breaks the request into ordered steps, e.g. *reshape the table → run a Kruskal-Wallis test → make a box plot → put the test's p values on it → add a title*. Then it works through the steps one at a time: for each, it is told the request, the plan and what the earlier steps made (new datasets with their columns), and gives the actions for that step only. You see the plan fill in live, with each step's actions under it. A plain question is just answered.

Before you see a plan, the app tries it on a copy of the project, step by step, so later steps can use what earlier ones make. Names that are nearly right are matched (`Treatment1` → `Treatment 1`; ambiguous ones are not guessed), and a table with one column per group is used as it is (the test compares its columns; the graph uses its long version). Actions that still cannot work go back to the model once (for that step), with the reason, to be fixed; any left are shown unticked with the reason. Apply runs the whole plan; one undo takes it all back. *What the model wrote* under each answer shows its raw reply.

Model size matters most: 1–4B models in the browser handle simple requests; 8–14B models (Qwen3 8B in the browser with a large graphics card, or LM Studio / Ollama) are much more reliable. Check the plan, and the choice of test, before applying.

## Using your files in R

**Save .RData** writes every table, transform, analysis result and graph as R objects, plus the project itself (so Agrafeuse can reopen it):

```r
library(ggplot2)
load("Example_project.RData")

plant_growth_scatter_dot_plot                   # a ggplot: prints the figure
ggsave("figure1.pdf", plant_growth_scatter_dot_plot, width = 4, height = 4)

one_way_anova                                   # the analysis, printed as tables
one_way_anova$tables$ANOVA                      # each table is a data frame
summary(one_way_anova$model)                    # the fitted model itself
```

Opening a plain `.RData` file made in R (no Agrafeuse project inside) adds each of its data frames as a data table.

**Whole project as R code** (bottom of the left panel) gives one script that recreates everything, including the small `ag_…` helper functions Agrafeuse uses (the lab-figure theme, p value brackets, result tables). It runs in R ≥ 4.1 with ggplot2 ≥ 3.5.

## How it works

```
┌──────────────────────────── your browser ────────────────────────────┐
│                                                                      │
│  Agrafeuse UI (plain JavaScript)                                     │
│    project = data tables + transforms + analyses + graphs (JSON)     │
│        │                                                             │
│        │  each item is turned into R code (js/codegen/)              │
│        ▼                                                             │
│  webR: R 4.6 compiled to WebAssembly, in a background worker         │
│    ggplot2 · dplyr · tidyr · emmeans · lme4 · R/helpers.R            │
│        │                                                             │
│        ▼                                                             │
│  SVG previews, result tables, PDF/PNG/TIFF/SVG files, .RData         │
└──────────────────────────────────────────────────────────────────────┘
   webR and R packages are downloaded once from webr.r-wasm.org and
   repo.r-wasm.org (falls back to cdn.jsdelivr.net for webR itself).
```

Items only re-run when their code, or something they depend on, changes. Previews are drawn by R's own Cairo SVG device, so what you see is what you export.

### Statistical methods

| Analysis | R code it runs |
|---|---|
| Unpaired / Welch t test | `t.test(y ~ group, var.equal = …)` |
| Paired / ratio paired t test | `t.test(x1, x2, paired = TRUE)` (ratio: on `log()` values, reported as geometric mean ratio) |
| Mann-Whitney / Wilcoxon | `wilcox.test(…, conf.int = TRUE)` |
| One-way ANOVA + multiple comparisons | `aov()`, then `emmeans::contrast(…, "pairwise" or "trt.vs.ctrl", adjust = …)` |
| Welch's ANOVA + Games-Howell | `oneway.test(var.equal = FALSE)`, `ag_games_howell()` |
| Kruskal-Wallis + Dunn | `kruskal.test()`, `ag_dunn()` (tie-corrected, `p.adjust()`) |
| Repeated-measures ANOVA | `lmerTest::lmer(y ~ group + (1 \| subject))` + `emmeans` |
| Friedman | `friedman.test()`, paired Wilcoxon post-tests |
| Two-way ANOVA | `lm()` with sum-to-zero contrasts and `drop1()` (Type III) or `anova()` (Type I); `emmeans` for comparisons |
| Mixed-effects model | `lmerTest::lmer()` with Satterthwaite degrees of freedom; `emmeans` |
| Correlation | `cor.test(method = "pearson" / "spearman" / "kendall")` |
| Regression | `lm()` for linear / polynomial / log; `nls()` with `SSfpl`, `SSmicmen`, `SSasymp` and others for curves |

If lme4 cannot be loaded in the browser, mixed models fall back to `nlme::lme()` automatically.

## Running offline, or self-hosting webR

By default webR comes from its CDN. To serve it yourself:

1. Download the release archive (e.g. `webr-0.6.0.tar.gz`) from [webR's GitHub releases](https://github.com/r-wasm/webr/releases) and extract it to `vendor/webr/`.
2. Open `http://localhost:8000/?webr=/vendor/webr/`, or change `webrSources` in `js/config.js`.

R packages still download from `repo.r-wasm.org` the first time. For a fully offline setup, mirror the packages you need with [rwasm](https://r-wasm.github.io/rwasm/) and point `repoUrl` in `js/config.js` at your copy.

## Using your own R instead of webR (optional)

If you have R installed, Agrafeuse can use it instead. This is faster for big datasets, and uses your installed packages:

```sh
node dev/r-bridge.mjs     # Node 18+; R needs ggplot2, dplyr, tidyr, jsonlite (+ emmeans, lme4, lmerTest)
```

It prints a link with a one-time token. The server only listens on `127.0.0.1` and rejects requests without the token.

## Project layout

```
index.html, css/app.css     the page
js/main.js                  start-up
js/model.js                 the project: items, R names, dependencies
js/codegen/                 project → R code (data, transforms, graphs, stats, whole script)
js/engine.js                runs R (webR or the bridge); caches results per item
js/ui/                      views: data grid, transforms, graph builder, statistics, dialogs, assistant
js/copilot/                 the assistant: model connections, prompt, actions it can take
js/example.js               the example project
js/about.js                 name, version, citation and credits (shown in the footer)
assets/                     the stapler icon
R/helpers.R                 ag_* R functions: theme, brackets, result tables, drawing, .RData
dev/r-bridge.mjs            optional local server that uses your own R
tests/                      R helper tests, code-generation tests (in R), browser end-to-end tests, fixtures
```

There is no build step: edit a file and reload.

## Tests

```sh
Rscript tests/helpers_test.R                          # R helpers
R_SCRIPT=$(which Rscript) node tests/codegen.test.mjs # generated R code for ~100 configurations runs cleanly
R_SCRIPT=$(which Rscript) node tests/e2e.test.mjs     # drives the UI in Chromium (needs Playwright)
```

## Ideas for later

- **Controlled code entry.** Today you can type an R expression for a calculated column, and add any ggplot2 code to a graph or as a layer, both checked as you type. Next steps could be "R cell" items (your own transform or analysis written in R, with its output usable like any other dataset), column-name autocompletion, and a formula builder.
- Survival curves (Kaplan-Meier, log-rank), contingency tables (chi-square, Fisher), curve fits per group with comparisons, normalisation and baseline transforms.
- Multi-panel figures (patchwork), journal size presets, font choice.
- Excel (`.xlsx`) import.

## Known limitations

- The first start needs an internet connection and downloads roughly 30 MB for R plus the packages.
- webR is slower than desktop R. Tables of tens of thousands of rows are fine; much larger data is better handled with the R bridge.
- P value brackets are drawn between groups on the X axis, or between side-by-side groups within each X group. They are not split across panels (facets).
- Plots use the fonts that ship with webR. Text in PDFs and SVGs is embedded or outlined, so it looks the same everywhere.

## How to cite

If Agrafeuse contributed to your work, please cite it:

> Misra, Paraish S. (2026). Agrafeuse: An open source application for quick quantitative data analysis and visualization (Version 0.1.0) [Computer software]. Zenodo. https://doi.org/10.5281/zenodo.23693687

DOI: [10.5281/zenodo.23693687](https://doi.org/10.5281/zenodo.23693687) (archived on Zenodo). Source code: https://github.com/paraish/Agrafeuse

In author-initial styles: Misra PS (Vancouver) or Misra, P. S. (APA).

GitHub's **Cite this repository** button (from `CITATION.cff`) gives APA and BibTeX. The statistics are computed by R, so please also cite R and the packages your analysis used (in R: `citation()`, `citation("ggplot2")`, `citation("emmeans")`, …). The exact versions of R and of every package in use are listed at the bottom of the app, and at the top of the project's R script.

Agrafeuse is made by the Misra Lab ([misralab.ca](https://misralab.ca/)). Developed by Paraish S. Misra with AI-assisted programming (Claude, Anthropic).

## License

Agrafeuse is free software under the GNU Affero General Public License v3 (`LICENSE`), with an
additional term under section 7(b): copies and modified versions must keep the author
attribution and the "How to cite" notice in the app's footer. See `NOTICE`.

R, webR and the R packages Agrafeuse loads at run time have their own licenses (R is GPL-2 | GPL-3).

For research use only, not for diagnostic procedures. Provided as is, without warranty.

---

Agrafeuse is French for stapler: it pins your data, statistics and figures together.
