# =============================================================================
# Agrafeuse helper functions
#
# Every script Agrafeuse generates starts with these helpers. They are plain R:
# ggplot2 is needed for the plotting helpers, and emmeans / lme4 / lmerTest
# only for the analyses that use them. All helper names start with `ag_` so
# they never clash with your own objects.
# =============================================================================

`%||%` <- function(a, b) if (is.null(a)) b else a

# ---- Formatting --------------------------------------------------------------

# P values the way most papers print them: 4 decimals, "<0.0001" below that.
ag_fmt_p <- function(p) {
  out <- formatC(round(p, 4), format = "f", digits = 4)
  out[!is.na(p) & p < 1e-4] <- "<0.0001"
  out[is.na(p)] <- "NA"
  out
}

ag_stars <- function(p) {
  out <- ifelse(p < 1e-4, "****", ifelse(p < 1e-3, "***",
         ifelse(p < 0.01, "**", ifelse(p < 0.05, "*", "ns"))))
  out[is.na(p)] <- ""
  out
}

# Text for a p value on a graph. format: "stars", "p" ("p = 0.012") or "number".
ag_p_label <- function(p, format = "stars") {
  switch(format,
    stars = ag_stars(p),
    p = ag_p_text(p),
    number = ag_fmt_p(p),
    ag_stars(p)
  )
}

# "p = 0.0123" or "p < 0.0001", for sentences.
ag_p_text <- function(p) ifelse(!is.na(p) & p < 1e-4, "p < 0.0001", paste("p =", ag_fmt_p(p)))

ag_num <- function(x, digits = 4) {
  out <- formatC(signif(x, digits), digits = digits, format = "fg", flag = "#")
  out <- sub("\\.$", "", trimws(out))
  ifelse(is.na(x), "", out)
}

# Short number for sentences and graph labels.
ag_short <- function(x, digits = 3) {
  vapply(x, function(v) {
    if (is.na(v)) return("NA")
    if (v != 0 && (abs(v) >= 1e5 || abs(v) < 1e-3)) return(formatC(v, digits = digits - 1, format = "e"))
    format(signif(v, digits), scientific = FALSE, trim = TRUE)
  }, character(1))
}

# ---- Summaries for error bars (use with stat_summary(fun.data = ...)) -----------

# direction = "up" or "down" draws only one half of the error bar. Each
# function stands alone, so plots saved in an .RData file still draw in R
# without the rest of these helpers.
ag_mean_sd <- function(x, direction = "both") {
  x <- x[!is.na(x)]
  m <- mean(x); s <- if (length(x) > 1) stats::sd(x) else 0
  data.frame(y = m, ymin = if (direction == "up") m else m - s, ymax = if (direction == "down") m else m + s)
}

ag_mean_sem <- function(x, direction = "both") {
  x <- x[!is.na(x)]
  m <- mean(x); s <- if (length(x) > 1) stats::sd(x) / sqrt(length(x)) else 0
  data.frame(y = m, ymin = if (direction == "up") m else m - s, ymax = if (direction == "down") m else m + s)
}

ag_mean_ci <- function(x, direction = "both", conf = 0.95) {
  x <- x[!is.na(x)]
  n <- length(x); m <- mean(x)
  s <- if (n > 1) stats::qt(1 - (1 - conf) / 2, n - 1) * stats::sd(x) / sqrt(n) else 0
  data.frame(y = m, ymin = if (direction == "up") m else m - s, ymax = if (direction == "down") m else m + s)
}

ag_median_iqr <- function(x, direction = "both") {
  q <- stats::quantile(x, c(0.25, 0.5, 0.75), na.rm = TRUE, names = FALSE)
  data.frame(y = q[2], ymin = if (direction == "up") q[2] else q[1], ymax = if (direction == "down") q[2] else q[3])
}

ag_median_range <- function(x, direction = "both") {
  x <- x[!is.na(x)]
  m <- stats::median(x)
  data.frame(y = m, ymin = if (direction == "up") m else min(x), ymax = if (direction == "down") m else max(x))
}

# Factor whose levels keep the order values first appear in (not alphabetical).
ag_factor <- function(x) {
  if (is.factor(x)) return(droplevels(x))
  factor(x, levels = unique(as.character(x[!is.na(x)])))
}

# Put the given levels first, in that order; any other levels follow.
ag_relevel <- function(x, levels) {
  x <- ag_factor(x)
  factor(x, levels = c(intersect(levels, levels(x)), setdiff(levels(x), levels)))
}

# Swap rows and columns. `names_col` (optional) holds the new column names.
ag_transpose <- function(df, names_col = NULL) {
  df <- as.data.frame(df, check.names = FALSE)
  if (!is.null(names_col)) {
    new_names <- make.unique(as.character(df[[names_col]]))
    df[[names_col]] <- NULL
  } else {
    new_names <- paste0("Row ", seq_len(nrow(df)))
  }
  m <- t(as.matrix(df))
  out <- data.frame(name = factor(rownames(m), levels = rownames(m)), m,
                    check.names = FALSE, row.names = NULL, stringsAsFactors = FALSE)
  names(out) <- c("name", new_names)
  out[-1] <- lapply(out[-1], function(v) utils::type.convert(trimws(v), as.is = TRUE))
  out
}

# ---- Theme --------------------------------------------------------------------

# A clean "lab figure" look: no grid, thick black axes, bold titles.
ag_theme_lab <- function(base_size = 14, base_family = "") {
  ggplot2::theme_classic(base_size = base_size, base_family = base_family) +
    ggplot2::theme(
      axis.line = ggplot2::element_line(linewidth = 0.9, colour = "black", lineend = "square"),
      axis.ticks = ggplot2::element_line(linewidth = 0.9, colour = "black"),
      axis.ticks.length = ggplot2::unit(base_size / 3, "pt"),
      axis.text = ggplot2::element_text(colour = "black", size = ggplot2::rel(0.95)),
      axis.title = ggplot2::element_text(face = "bold"),
      plot.title = ggplot2::element_text(face = "bold", hjust = 0.5),
      legend.title = ggplot2::element_text(face = "bold"),
      strip.background = ggplot2::element_blank(),
      strip.text = ggplot2::element_text(face = "bold", size = ggplot2::rel(1))
    )
}

ag_okabe_ito <- c("#E69F00", "#56B4E9", "#009E73", "#F0E442", "#0072B2",
                  "#D55E00", "#CC79A7", "#000000", "#999999")

# ---- P value brackets ------------------------------------------------------------

# Brackets with p values between groups on a discrete x axis.
# `result` is a Agrafeuse result (it carries a `comparisons` table with
# group1, group2 and p); `data`, `x` and `y` are what the graph shows.
# Comparisons made within each level of the x variable (e.g. treatment within
# each dose) are drawn between side-by-side ("dodged") groups; `dodge` must
# match the dodge width of the graph (Agrafeuse uses 0.8).
ag_brackets <- function(result, data, x, y, format = "stars", hide_ns = FALSE,
                        y_start = NULL, step = 0.09, tip = 0.02, text_size = 4.5,
                        colour = "black", linewidth = 0.6, dodge = 0.8, headroom = 0.08) {
  cmp <- result$comparisons
  if (is.null(cmp) || !nrow(cmp)) return(list())
  if (!all(c("group1", "group2", "p") %in% names(cmp))) return(list())
  by <- attr(cmp, "by") %||% character()
  fac <- attr(cmp, "factor") %||% character()
  if (hide_ns) cmp <- cmp[!is.na(cmp$p) & cmp$p < 0.05, , drop = FALSE]
  if (!nrow(cmp)) return(list())
  xv <- data[[x]]; yv <- data[[y]]
  if (is.null(xv) || is.null(yv)) stop("Brackets: column '", x, "' or '", y, "' is not in the graph data.")
  top_of <- function(v) {
    v <- v[is.finite(v)]
    if (!length(v)) return(NA_real_)
    max(max(v), mean(v) + if (length(v) > 1) stats::sd(v) else 0)
  }

  if (length(by)) {
    # Comparisons within each level of `by`: only drawable when `by` is the x axis
    # and the compared factor is what splits the groups side by side.
    if (!(length(by) == 1 && by == x && length(fac) == 1 && fac %in% names(data))) {
      warning("Brackets: these comparisons are made within each level of '", paste(by, collapse = ", "),
              "'. Put '", paste(by, collapse = ", "), "' on the x axis and split the groups side by side by '",
              paste(fac, collapse = ", "), "' to draw them.", call. = FALSE)
      return(list())
    }
    xl <- levels(ag_factor(xv)); fl <- levels(ag_factor(data[[fac]])); nf <- length(fl)
    off <- function(g) (match(as.character(g), fl) - (nf + 1) / 2) * dodge / nf
    base <- match(as.character(cmp[[by]]), xl)
    pos1 <- base + off(cmp$group1); pos2 <- base + off(cmp$group2)
    cell <- interaction(match(as.character(xv), xl), match(as.character(data[[fac]]), fl), drop = TRUE, sep = "_")
    cell_tops <- vapply(split(yv, cell), top_of, numeric(1))
    idx <- do.call(rbind, strsplit(names(cell_tops), "_", fixed = TRUE))
    cell_pos <- as.numeric(idx[, 1]) + (as.numeric(idx[, 2]) - (nf + 1) / 2) * dodge / nf
  } else if (is.numeric(xv)) {
    pos1 <- suppressWarnings(as.numeric(as.character(cmp$group1)))
    pos2 <- suppressWarnings(as.numeric(as.character(cmp$group2)))
    cell_tops <- vapply(split(yv, xv), top_of, numeric(1))
    cell_pos <- as.numeric(names(cell_tops))
  } else {
    groups <- ag_factor(xv)
    pos1 <- match(as.character(cmp$group1), levels(groups))
    pos2 <- match(as.character(cmp$group2), levels(groups))
    cell_tops <- vapply(split(yv, groups), top_of, numeric(1))
    cell_pos <- seq_along(cell_tops)
  }
  ok <- !is.na(pos1) & !is.na(pos2)
  if (!any(ok)) {
    warning("Brackets: none of the compared groups (", paste(unique(c(cmp$group1, cmp$group2)), collapse = ", "),
            ") are on the x axis '", x, "'.", call. = FALSE)
    return(list())
  }
  if (!all(ok)) warning("Brackets: some compared groups are not on the x axis and were skipped.", call. = FALSE)
  cmp <- cmp[ok, , drop = FALSE]
  lo <- pmin(pos1[ok], pos2[ok]); hi <- pmax(pos1[ok], pos2[ok])

  finite_y <- yv[is.finite(yv)]
  top <- max(cell_tops, na.rm = TRUE)
  rng <- top - min(0, finite_y)
  if (!is.finite(rng) || rng <= 0) rng <- abs(top) + 1
  gap <- 0.07 * rng; stepd <- step * rng
  fixed_start <- !is.null(y_start) && !is.na(y_start)

  # Narrow brackets first. Each sits just above the groups it spans, and above
  # any bracket already placed that it overlaps.
  ord <- order(hi - lo, lo)
  yb <- numeric(length(lo))
  placed <- integer()
  for (k in ord) {
    spanned <- cell_tops[cell_pos >= lo[k] - 1e-9 & cell_pos <= hi[k] + 1e-9]
    yk <- if (fixed_start) y_start else max(spanned, na.rm = TRUE) + gap
    if (!is.finite(yk)) yk <- top + gap
    clash <- placed[lo[placed] <= hi[k] + 1e-9 & hi[placed] >= lo[k] - 1e-9]
    if (length(clash)) yk <- max(yk, max(yb[clash]) + stepd)
    yb[k] <- yk
    placed <- c(placed, k)
  }
  tipd <- tip * rng
  labels <- ag_p_label(cmp$p, format)
  # Asterisks sit high in the line, so they go right on the bracket; text sits above it.
  is_star <- grepl("^\\*+$", labels)

  list(
    ggplot2::annotate("segment",
      x = c(lo, lo, hi), xend = c(lo, hi, hi),
      y = c(yb - tipd, yb, yb), yend = c(yb, yb, yb - tipd),
      colour = colour, linewidth = linewidth),
    ggplot2::annotate("text", x = (lo + hi) / 2, y = yb + ifelse(is_star, 0, 0.012 * rng),
      label = labels, vjust = ifelse(is_star, 0.3, 0), size = text_size, colour = colour),
    ggplot2::expand_limits(y = max(yb) + headroom * rng)
  )
}

# ---- Statistics from a graph's own data (like ggpubr's stat_compare_means) ----

# Pairwise tests between the groups on the x axis or, with `within`, between the
# side-by-side groups of `within` inside each x group; plus an overall test.
#   method: "t.test" (Welch), "t.test.equal" (Student) or "wilcox.test"
#   comparisons: "all" pairs, "control" (each group against `ref`) or "none"
#   paired: values matched by `subject` (paired t test / Wilcoxon signed-rank)
# P values are adjusted with p.adjust(method = p_adjust) across all comparisons.
ag_compare <- function(data, x, y, method = "t.test", comparisons = "all", ref = NULL,
                       p_adjust = "holm", paired = FALSE, subject = NULL, within = NULL) {
  d <- as.data.frame(data)
  need <- c(x, y, within, if (paired) subject)
  if (paired && (is.null(subject) || !nzchar(subject))) stop("Paired comparisons need a column that identifies each subject.")
  miss <- setdiff(need, names(d))
  if (length(miss)) stop("Compare groups: no column ", paste0("'", miss, "'", collapse = ", "), " in the graph data.")
  if (!is.numeric(d[[y]])) stop("Compare groups: '", y, "' must be numbers.")
  d$.g <- ag_factor(d[[if (is.null(within)) x else within]])
  d <- d[!is.na(d[[y]]) & !is.na(d$.g), , drop = FALSE]
  parametric <- method != "wilcox.test"
  pair_test <- if (paired) c(t.test = "paired t test", t.test.equal = "paired t test", wilcox.test = "Wilcoxon signed-rank test")[[method]] else
    c(t.test = "Welch's t test", t.test.equal = "t test", wilcox.test = "Mann-Whitney test")[[method]]

  pair_p <- function(sub, a, b) {
    if (paired) {
      w <- merge(sub[sub$.g == a, c(subject, y)], sub[sub$.g == b, c(subject, y)], by = subject)
      v1 <- w[[2]]; v2 <- w[[3]]
      if (length(v1) < 2) return(NA_real_)
    } else {
      v1 <- sub[[y]][sub$.g == a]; v2 <- sub[[y]][sub$.g == b]
      if (length(v1) < 1 || length(v2) < 1 || (parametric && (length(v1) < 2 || length(v2) < 2))) return(NA_real_)
    }
    tryCatch(suppressWarnings(switch(method,
      t.test = stats::t.test(v1, v2, paired = paired)$p.value,
      t.test.equal = stats::t.test(v1, v2, paired = paired, var.equal = !paired)$p.value,
      wilcox.test = stats::wilcox.test(v1, v2, paired = paired)$p.value)), error = function(e) NA_real_)
  }
  pairs_for <- function(lv) {
    if (comparisons == "none" || length(lv) < 2) return(list())
    if (comparisons == "control") {
      r <- if (!is.null(ref) && ref %in% lv) ref else lv[1]
      return(lapply(setdiff(lv, r), function(o) c(r, o)))
    }
    utils::combn(lv, 2, simplify = FALSE)
  }

  cells <- if (is.null(within)) list(all = d) else split(d, ag_factor(d[[x]]), drop = TRUE)
  rows <- list()
  for (cell in names(cells)) {
    sub <- cells[[cell]]
    for (pr in pairs_for(levels(droplevels(sub$.g)))) {
      r <- data.frame(group1 = pr[1], group2 = pr[2], p_raw = pair_p(sub, pr[1], pr[2]), stringsAsFactors = FALSE)
      if (!is.null(within)) r[[x]] <- cell
      rows[[length(rows) + 1]] <- r
    }
  }
  cmp <- NULL
  if (length(rows)) {
    cmp <- do.call(rbind, rows)
    cmp$p <- stats::p.adjust(cmp$p_raw, method = p_adjust)
    if (!is.null(within)) { attr(cmp, "by") <- x; attr(cmp, "factor") <- within }
  }

  # The overall test, for groups on the x axis.
  label <- NULL
  k <- nlevels(droplevels(d$.g))
  if (is.null(within) && k >= 2) {
    g <- droplevels(d$.g)
    ov <- tryCatch(suppressWarnings(if (k == 2) {
      lv <- levels(g)
      list(name = pair_test, p = pair_p(d, lv[1], lv[2]))
    } else if (paired) {
      if (parametric) {
        tab <- stats::anova(stats::lm(d[[y]] ~ g + factor(d[[subject]])))
        list(name = "Repeated-measures ANOVA", p = tab[["Pr(>F)"]][1])
      } else {
        list(name = "Friedman test", p = stats::friedman.test(d[[y]], g, factor(d[[subject]]))$p.value)
      }
    } else if (parametric) {
      list(name = if (method == "t.test") "Welch's ANOVA" else "One-way ANOVA",
           p = stats::oneway.test(d[[y]] ~ g, var.equal = method == "t.test.equal")$p.value)
    } else {
      list(name = "Kruskal-Wallis", p = stats::kruskal.test(d[[y]], g)$p.value)
    }), error = function(e) NULL)
    if (!is.null(ov) && !is.na(ov$p)) label <- paste0(ov$name, ", ", ag_p_text(ov$p))
  }
  tables <- list()
  if (!is.null(cmp)) tables[["Comparisons"]] <- ag_comparison_table(cmp)
  notes <- c(paste0("Pairwise tests: ", pair_test, if (!is.null(cmp) && p_adjust != "none") paste0(", P values adjusted (", p_adjust, ")")))
  ag_result("Compare groups", summary = label %||% "", tables = tables, comparisons = cmp, label = label, notes = notes)
}

# ag_compare() drawn on a graph: brackets with stars or p values, and the overall
# test's result in a corner. Add it to a ggplot with +.
ag_stat_compare <- function(data, x, y, method = "t.test", comparisons = "all", ref = NULL,
                            p_adjust = "holm", paired = FALSE, subject = NULL, within = NULL,
                            format = "stars", hide_ns = FALSE, overall = TRUE, position = "top-left",
                            y_start = NULL, step = 0.09, text_size = 4.5, label_size = 4.2) {
  res <- ag_compare(data, x, y, method, comparisons, ref, p_adjust, paired, subject, within)
  # Leave room above the brackets for the overall result when it goes at the top.
  label_on_top <- overall && !is.null(res$label) && grepl("top", position)
  out <- ag_brackets(res, data, x, y, format = format, hide_ns = hide_ns, y_start = y_start,
                     step = step, text_size = text_size, headroom = if (label_on_top) 0.24 else 0.08)
  if (overall && !is.null(res$label)) out <- c(out, list(ag_corner_label(res$label, position, size = label_size)))
  out
}

# A text label (e.g. "r = 0.82, p = 0.003") in a corner of the panel.
# Positioned relative to the panel with I(), so it also works on log axes.
ag_corner_label <- function(label, position = "top-left", size = 4.2, colour = "black") {
  if (is.null(label) || !nzchar(label)) return(list())
  left <- grepl("left", position); top <- grepl("top", position)
  ggplot2::annotate("text", x = I(if (left) 0.04 else 0.96), y = I(if (top) 0.96 else 0.04),
    label = label, hjust = if (left) 0 else 1, vjust = if (top) 1 else 0,
    size = size, colour = colour, lineheight = 1.1)
}

# A text box on a graph. x and y are fractions of the panel (0 to 1, from the
# bottom left) unless data = TRUE, when they are values on the axes. hjust is
# the alignment (0 left, 0.5 centre, 1 right) around the point. fill = NA
# gives plain text with no box; border is the box outline's width.
ag_text_box <- function(label, x = 0.5, y = 0.9, data = FALSE, size = 4, colour = "black",
                        fill = "white", border = 0.25, face = "plain", hjust = 0.5, vjust = 0.5) {
  if (!data) { x <- I(x); y <- I(y) }
  if (is.na(fill) || !nzchar(fill)) {
    return(ggplot2::annotate("text", x = x, y = y, label = label, size = size, colour = colour,
                             fontface = face, hjust = hjust, vjust = vjust, lineheight = 1.1))
  }
  args <- list("label", x = x, y = y, label = label, size = size, colour = colour, fill = fill,
               fontface = face, hjust = hjust, vjust = vjust, lineheight = 1.1)
  # ggplot2 4.0 renamed the outline width of labels.
  if (utils::packageVersion("ggplot2") >= "4.0.0") args$linewidth <- border else args$label.size <- border
  do.call(ggplot2::annotate, args)
}

# The fitted curve of a regression result, optionally with its 95% confidence band.
ag_fit_curve <- function(result, colour = "black", linewidth = 0.9, band = TRUE, band_alpha = 0.15) {
  cv <- result$curve
  if (is.null(cv) || !nrow(cv)) return(list())
  out <- list()
  if (band && all(c("lwr", "upr") %in% names(cv))) {
    out <- c(out, list(ggplot2::geom_ribbon(data = cv, ggplot2::aes(x = x, ymin = lwr, ymax = upr),
      inherit.aes = FALSE, fill = colour, alpha = band_alpha)))
  }
  c(out, list(ggplot2::geom_line(data = cv, ggplot2::aes(x = x, y = y), inherit.aes = FALSE,
    colour = colour, linewidth = linewidth)))
}

# ---- Analysis results -----------------------------------------------------------

# Every analysis returns one of these: a title, a one-line summary, a set of
# tables, and (where it makes sense) group comparisons, a graph label and a
# fitted curve that graphs can draw.
ag_result <- function(title, summary = "", tables = list(), comparisons = NULL,
                      label = NULL, curve = NULL, model = NULL, notes = character(), ...) {
  structure(list(title = title, summary = summary, tables = tables,
                 comparisons = comparisons, label = label, curve = curve,
                 model = model, notes = notes, ...),
            class = "ag_result")
}

print.ag_result <- function(x, ...) {
  cat(x$title, "\n", sep = "")
  if (nzchar(x$summary)) cat(x$summary, "\n", sep = "")
  for (nm in names(x$tables)) {
    cat("\n", nm, "\n", sep = "")
    print(x$tables[[nm]], row.names = FALSE)
  }
  if (length(x$notes)) cat("\nNote: ", paste(x$notes, collapse = "\nNote: "), "\n", sep = "")
  invisible(x)
}

ag_group_summary <- function(d, y, group) {
  sp <- split(d[[y]], d[[group]], drop = TRUE)
  rows <- lapply(names(sp), function(g) {
    v <- sp[[g]]; v <- v[!is.na(v)]; n <- length(v)
    s <- if (n > 1) stats::sd(v) else NA_real_
    ci <- if (n > 1) stats::qt(0.975, n - 1) * s / sqrt(n) else NA_real_
    q <- if (n) stats::quantile(v, c(0.25, 0.75), names = FALSE) else c(NA, NA)
    data.frame(Group = g, N = n, Mean = if (n) mean(v) else NA, SD = s, SEM = s / sqrt(n),
               `Lower 95% CI` = mean(v) - ci, `Upper 95% CI` = mean(v) + ci,
               Median = if (n) stats::median(v) else NA, Q1 = q[1], Q3 = q[2],
               Min = if (n) min(v) else NA, Max = if (n) max(v) else NA,
               check.names = FALSE)
  })
  do.call(rbind, rows)
}

ag_descriptive <- function(d, y, group = NULL) {
  if (is.null(group)) { d$.all <- y; group <- ".all" }
  tab <- ag_group_summary(d, y, group)
  ag_result("Descriptive statistics", sprintf("%s summarised by %s.", y, if (group == ".all") "(all values)" else group),
            tables = list(`Descriptive statistics` = tab))
}

ag_normality <- function(d, y, group = NULL) {
  sp <- if (is.null(group)) list(All = d[[y]]) else split(d[[y]], d[[group]], drop = TRUE)
  tab <- do.call(rbind, lapply(names(sp), function(g) {
    v <- sp[[g]][!is.na(sp[[g]])]
    if (length(v) < 3 || length(v) > 5000 || stats::sd(v) == 0) {
      return(data.frame(Group = g, N = length(v), W = NA, `P value` = NA, `Normal?` = "too few / constant values", check.names = FALSE))
    }
    t <- stats::shapiro.test(v)
    data.frame(Group = g, N = length(v), W = unname(t$statistic), `P value` = t$p.value,
               `Normal?` = ifelse(t$p.value >= 0.05, "Yes (p >= 0.05)", "No (p < 0.05)"), check.names = FALSE)
  }))
  ag_result("Shapiro-Wilk normality test",
            "A small p value suggests the values in that group are not normally distributed.",
            tables = list(`Normality test` = tab),
            notes = "With small samples normality tests have little power; with very large samples they flag trivial deviations. Look at the data too.")
}

# Two-group tests (t tests, Mann-Whitney, Wilcoxon) -------------------------------

ag_result_two_group <- function(test, d, y, group, groups, title, paired = FALSE, ratio = FALSE) {
  st <- unname(test$statistic); df <- unname(test$parameter %||% NA)
  p <- test$p.value
  est <- test$estimate; ci <- test$conf.int
  diff_name <- if (ratio) "Geometric mean ratio" else if (grepl("Wilcoxon|Mann", title)) "Location shift (Hodges-Lehmann)" else "Mean difference"
  if (!is.null(est) && length(est) == 2) est <- est[[1]] - est[[2]]
  est <- if (is.null(est)) NA_real_ else unname(est[[1]])
  if (ratio) { est <- exp(est); if (!is.null(ci)) ci <- exp(ci) }
  stat_name <- names(test$statistic) %||% "statistic"
  main <- data.frame(Test = title, Statistic = stat_name, Value = st,
                     DF = df, `P value` = p, Significance = ag_stars(p), check.names = FALSE)
  main[[diff_name]] <- est
  if (!is.null(ci)) {
    main[["Lower 95% CI"]] <- ci[1]; main[["Upper 95% CI"]] <- ci[2]
  }
  if (all(is.na(main$DF))) main$DF <- NULL
  df_txt <- if (!is.na(df)) sprintf("(%s)", ag_short(df)) else ""
  summary <- sprintf("%s: %s%s = %s, %s (%s). %s %s vs %s = %s.",
                     title, stat_name, df_txt, ag_short(st), ag_p_text(p), ag_stars(p),
                     diff_name, groups[1], groups[2], ag_short(est))
  ag_result(title, summary,
            tables = list(Test = main, `Group summary` = ag_group_summary(d, y, group)),
            comparisons = data.frame(group1 = groups[1], group2 = groups[2], p = p),
            label = paste0(title, ", ", ag_p_label(p, "p")),
            model = test)
}

ag_result_one_sample <- function(test, d, y, mu, title) {
  p <- test$p.value; st <- unname(test$statistic)
  main <- data.frame(Test = title, `Hypothetical value` = mu, Statistic = names(test$statistic),
                     Value = st, DF = unname(test$parameter %||% NA), `P value` = p,
                     Significance = ag_stars(p), check.names = FALSE)
  if (!is.null(test$conf.int)) {
    main[["Estimate"]] <- unname(test$estimate)
    main[["Lower 95% CI"]] <- test$conf.int[1]; main[["Upper 95% CI"]] <- test$conf.int[2]
  }
  if (all(is.na(main$DF))) main$DF <- NULL
  ag_result(title, sprintf("%s against %s: %s (%s).", title, ag_short(mu), ag_p_text(p), ag_stars(p)),
            tables = list(Test = main),
            label = paste0(title, ", ", ag_p_label(p, "p")), model = test)
}

# Multiple comparisons ---------------------------------------------------------------

# Turn an emmeans contrast object into a tidy comparison table. The groups each
# contrast compares are read from the contrast coefficients, so level names
# containing spaces or dashes are handled correctly.
ag_emm_comparisons <- function(mc) {
  s <- as.data.frame(summary(mc, infer = c(TRUE, TRUE)))
  cf <- stats::coef(mc)
  by_vars <- mc@misc$by.vars %||% character()
  coef_cols <- grep("^c\\.[0-9]+$", names(cf), value = TRUE)
  fac_cols <- setdiff(names(cf), c(coef_cols, by_vars))
  lab <- if (length(fac_cols) == 1) as.character(cf[[fac_cols]]) else
    do.call(paste, c(lapply(cf[fac_cols], as.character), sep = ":"))
  g1 <- vapply(coef_cols, function(cc) paste(lab[cf[[cc]] > 0], collapse = "+"), character(1))
  g2 <- vapply(coef_cols, function(cc) paste(lab[cf[[cc]] < 0], collapse = "+"), character(1))
  lcl <- grep("lower|LCL", names(s), value = TRUE)[1]
  ucl <- grep("upper|UCL", names(s), value = TRUE)[1]
  out <- data.frame(group1 = unname(g1), group2 = unname(g2), estimate = s$estimate,
                    lower = if (!is.na(lcl)) s[[lcl]] else NA, upper = if (!is.na(ucl)) s[[ucl]] else NA,
                    p = s$p.value, stringsAsFactors = FALSE)
  for (b in by_vars) out[[b]] <- as.character(s[[b]])
  attr(out, "by") <- by_vars
  attr(out, "factor") <- fac_cols
  out
}

ag_comparison_table <- function(cmp, estimate_name = "Mean difference") {
  if (is.null(cmp) || !nrow(cmp)) return(NULL)
  by <- setdiff(names(cmp), c("group1", "group2", "estimate", "lower", "upper", "p", "p_raw", "statistic"))
  tab <- data.frame(Comparison = paste(cmp$group1, "vs", cmp$group2), check.names = FALSE)
  for (b in by) tab[[b]] <- cmp[[b]]
  if ("estimate" %in% names(cmp)) tab[[estimate_name]] <- cmp$estimate
  if ("lower" %in% names(cmp) && !all(is.na(cmp$lower))) {
    tab[["Lower 95% CI"]] <- cmp$lower; tab[["Upper 95% CI"]] <- cmp$upper
  }
  if ("statistic" %in% names(cmp)) tab[["Statistic"]] <- cmp$statistic
  if ("p_raw" %in% names(cmp)) tab[["Unadjusted P value"]] <- cmp$p_raw
  tab[["Adjusted P value"]] <- cmp$p
  tab[["Significance"]] <- ag_stars(cmp$p)
  tab
}

# Games-Howell test: pairwise comparisons that do not assume equal SDs.
ag_games_howell <- function(y, g, conf = 0.95) {
  ok <- !is.na(y) & !is.na(g)
  y <- y[ok]; g <- droplevels(factor(g[ok]))
  lev <- levels(g); k <- length(lev)
  n <- tapply(y, g, length); m <- tapply(y, g, mean); v <- tapply(y, g, stats::var)
  pr <- utils::combn(k, 2)
  res <- lapply(seq_len(ncol(pr)), function(j) {
    a <- pr[1, j]; b <- pr[2, j]
    se <- sqrt(v[a] / n[a] + v[b] / n[b])
    df <- (v[a] / n[a] + v[b] / n[b])^2 / ((v[a] / n[a])^2 / (n[a] - 1) + (v[b] / n[b])^2 / (n[b] - 1))
    diff <- m[a] - m[b]
    q <- abs(diff) / se * sqrt(2)
    p <- stats::ptukey(q, k, df, lower.tail = FALSE)
    h <- stats::qtukey(conf, k, df) * se / sqrt(2)
    data.frame(group1 = lev[a], group2 = lev[b], estimate = unname(diff),
               lower = unname(diff - h), upper = unname(diff + h), p = unname(p))
  })
  do.call(rbind, res)
}

# Dunn's test after Kruskal-Wallis (rank-based pairwise comparisons, with a
# correction for ties).
ag_dunn <- function(y, g, adjust = "bonferroni", control = NULL) {
  ok <- !is.na(y) & !is.na(g)
  y <- y[ok]; g <- droplevels(factor(g[ok]))
  lev <- levels(g); N <- length(y)
  r <- rank(y)
  n <- tapply(r, g, length); rbar <- tapply(r, g, mean)
  ties <- table(y)
  tie_corr <- sum(ties^3 - ties) / (12 * (N - 1))
  pr <- if (is.null(control)) utils::combn(length(lev), 2) else
    rbind(match(setdiff(lev, control), lev), match(control, lev))
  res <- lapply(seq_len(ncol(pr)), function(j) {
    a <- pr[1, j]; b <- pr[2, j]
    se <- sqrt((N * (N + 1) / 12 - tie_corr) * (1 / n[a] + 1 / n[b]))
    z <- (rbar[a] - rbar[b]) / se
    data.frame(group1 = lev[a], group2 = lev[b], estimate = unname(rbar[a] - rbar[b]),
               statistic = unname(z), p_raw = unname(2 * stats::pnorm(-abs(z))))
  })
  out <- do.call(rbind, res)
  out$p <- stats::p.adjust(out$p_raw, method = adjust)
  out
}

# Paired Wilcoxon signed-rank tests between every pair of groups (after Friedman).
ag_pairwise_wilcox_paired <- function(d, y, group, subject, adjust = "holm") {
  d <- as.data.frame(d)[, c(subject, group, y)]
  d[[group]] <- as.character(d[[group]])
  w <- stats::reshape(d, idvar = subject, timevar = group, direction = "wide")
  lev <- levels(droplevels(factor(d[[group]])))
  pr <- utils::combn(length(lev), 2)
  res <- lapply(seq_len(ncol(pr)), function(j) {
    a <- paste0(y, ".", lev[pr[1, j]]); b <- paste0(y, ".", lev[pr[2, j]])
    t <- suppressWarnings(stats::wilcox.test(w[[a]], w[[b]], paired = TRUE))
    data.frame(group1 = lev[pr[1, j]], group2 = lev[pr[2, j]], statistic = unname(t$statistic), p_raw = t$p.value)
  })
  out <- do.call(rbind, res)
  out$p <- stats::p.adjust(out$p_raw, method = adjust)
  out
}

# ANOVA-type results ---------------------------------------------------------------------

ag_anova_table <- function(tab) {
  tab <- as.data.frame(tab)
  out <- data.frame(Source = trimws(rownames(tab)), check.names = FALSE)
  pick <- function(pattern) { nm <- grep(pattern, names(tab), value = TRUE, ignore.case = TRUE); if (length(nm)) tab[[nm[1]]] else NULL }
  cols <- list(DF = pick("^Df$|^NumDF$"), `Denominator DF` = pick("^DenDF$"),
               `Sum of squares` = pick("Sum Sq|Sum of Sq"), `Mean square` = pick("Mean Sq"),
               F = pick("F value|^F$|^F-value$"), `P value` = pick("Pr\\(>F\\)|^Pr|^p-value$"))
  for (nm in names(cols)) if (!is.null(cols[[nm]])) out[[nm]] <- cols[[nm]]
  out <- out[!out$Source %in% c("<none>", "(Intercept)"), , drop = FALSE]
  if ("P value" %in% names(out)) out$Significance <- ag_stars(out[["P value"]])
  rownames(out) <- NULL
  out
}

ag_result_anova <- function(fit, mc, d, y, group, title, posthoc = NULL, extra_tables = list(), notes = character()) {
  if (inherits(fit, "aov") || inherits(fit, "lm")) {
    at <- ag_anova_table(summary(fit)[[1]])
    r2 <- summary.lm(fit)$r.squared
  } else {
    at <- ag_anova_table(stats::anova(fit)); r2 <- NA
  }
  eff <- at[1, , drop = FALSE]
  summary_txt <- sprintf("%s: F(%s, %s) = %s, %s (%s).", title, ag_short(eff$DF),
                         ag_short(if ("Denominator DF" %in% names(at)) eff[["Denominator DF"]] else at$DF[nrow(at)]),
                         ag_short(eff$F), ag_p_text(eff[["P value"]]), ag_stars(eff[["P value"]]))
  if (!is.na(r2)) summary_txt <- paste0(summary_txt, sprintf(" R squared = %s.", ag_short(r2)))
  cmp <- if (is.null(mc)) NULL else if (is.data.frame(mc)) mc else ag_emm_comparisons(mc)
  tables <- c(list(ANOVA = at), extra_tables)
  if (!is.null(cmp)) tables[[posthoc %||% "Multiple comparisons"]] <- ag_comparison_table(cmp)
  tables[["Group summary"]] <- ag_group_summary(d, y, group)
  ag_result(title, summary_txt, tables = tables, comparisons = cmp,
            label = paste0(title, ", ", ag_p_label(eff[["P value"]], "p")), model = fit, notes = notes)
}

ag_result_htest_groups <- function(test, cmp, d, y, group, title, posthoc = NULL, notes = character(),
                                   estimate_name = "Mean difference") {
  p <- test$p.value
  main <- data.frame(Test = title, Statistic = names(test$statistic) %||% "", Value = unname(test$statistic),
                     DF = paste(ag_short(test$parameter), collapse = ", "), `P value` = p,
                     Significance = ag_stars(p), check.names = FALSE)
  tables <- list(Test = main)
  if (!is.null(cmp)) tables[[posthoc %||% "Multiple comparisons"]] <- ag_comparison_table(cmp, estimate_name)
  tables[["Group summary"]] <- ag_group_summary(d, y, group)
  ag_result(title, sprintf("%s: %s = %s, %s (%s).", title, names(test$statistic) %||% "statistic",
                           ag_short(unname(test$statistic)), ag_p_text(p), ag_stars(p)),
            tables = tables, comparisons = cmp, label = paste0(title, ", ", ag_p_label(p, "p")),
            model = test, notes = notes)
}

# Two-way ANOVA with Type I (sequential) or Type III sums of squares.
ag_anova2_table <- function(fit, type = "III") {
  if (type == "III") {
    tab <- stats::drop1(fit, scope = stats::formula(fit)[-2], test = "F")
    tab <- tab[rownames(tab) != "<none>", , drop = FALSE]
    rss <- stats::deviance(fit); rdf <- stats::df.residual(fit)
    out <- data.frame(Source = rownames(tab), DF = tab$Df, `Sum of squares` = tab$`Sum of Sq`,
                      `Mean square` = tab$`Sum of Sq` / tab$Df, F = tab$`F value`, `P value` = tab$`Pr(>F)`,
                      check.names = FALSE)
    out <- rbind(out, data.frame(Source = "Residuals", DF = rdf, `Sum of squares` = rss,
                                 `Mean square` = rss / rdf, F = NA, `P value` = NA, check.names = FALSE))
    out$Significance <- ag_stars(out[["P value"]])
    rownames(out) <- NULL
    out
  } else {
    ag_anova_table(stats::anova(fit))
  }
}

ag_result_anova2 <- function(fit, mc, d, y, factors, type = "III", title = "Two-way ANOVA", posthoc = NULL) {
  at <- ag_anova2_table(fit, type)
  terms <- at[at$Source != "Residuals", , drop = FALSE]
  summary_txt <- paste(sprintf("%s: F(%s, %s) = %s, %s (%s)", terms$Source, ag_short(terms$DF),
                               ag_short(stats::df.residual(fit)), ag_short(terms$F),
                               ag_p_text(terms[["P value"]]), ag_stars(terms[["P value"]])), collapse = "; ")
  cmp <- if (is.null(mc)) NULL else ag_emm_comparisons(mc)
  tables <- list(`ANOVA table` = at)
  if (!is.null(cmp)) tables[[posthoc %||% "Multiple comparisons"]] <- ag_comparison_table(cmp)
  cell <- interaction(d[factors], sep = " : ", drop = TRUE, lex.order = TRUE)
  d$.cell <- cell
  tables[["Cell summary"]] <- ag_group_summary(d, y, ".cell")
  ag_result(paste0(title, " (Type ", type, " sums of squares)"), paste0(summary_txt, "."),
            tables = tables, comparisons = cmp, model = fit,
            label = paste(sprintf("%s: %s", terms$Source, ag_p_label(terms[["P value"]], "p")), collapse = "\n"))
}

# Mixed-effects models (lme4 + lmerTest) ---------------------------------------------------

ag_result_mixed <- function(fit, mc, d, y, group = NULL, title = "Mixed-effects model", posthoc = NULL) {
  notes <- character()
  if (inherits(fit, "lme")) {
    # nlme::lme (used when lme4 is not available)
    at <- ag_anova_table(stats::anova(fit, type = "marginal"))
    vc <- nlme::VarCorr(fit)
    num <- suppressWarnings(as.numeric(vc[, "Variance"]))
    grp <- ""
    rows <- list()
    for (i in seq_len(nrow(vc))) {
      if (is.na(num[i])) { grp <- sub(" =.*", "", rownames(vc)[i]); next }
      term <- rownames(vc)[i]
      rows[[length(rows) + 1]] <- data.frame(Group = if (term == "Residual") "Residual" else if (nzchar(grp)) grp else names(fit$groups)[1],
        Term = if (term == "Residual") "" else term, Variance = num[i], SD = as.numeric(vc[i, "StdDev"]), check.names = FALSE)
    }
    re <- do.call(rbind, rows)
    tt <- as.data.frame(summary(fit)$tTable)
    fe <- data.frame(Term = rownames(tt), Estimate = tt$Value, SE = tt$Std.Error, DF = tt$DF,
                     t = tt$`t-value`, `P value` = tt$`p-value`, check.names = FALSE)
    fx_title <- "Fixed effects (marginal F tests, nlme)"
  } else {
    at <- ag_anova_table(stats::anova(fit))
    vc <- as.data.frame(lme4::VarCorr(fit))
    re <- data.frame(Group = vc$grp, Term = ifelse(is.na(vc$var2), vc$var1, paste(vc$var1, vc$var2, sep = " x ")),
                     Variance = vc$vcov, SD = vc$sdcor, check.names = FALSE)
    re$Term[is.na(re$Term)] <- ""
    fe <- as.data.frame(summary(fit)$coefficients)
    fe <- data.frame(Term = rownames(fe), Estimate = fe$Estimate, SE = fe$`Std. Error`,
                     DF = fe$df %||% NA, t = fe$`t value`, `P value` = fe$`Pr(>|t|)` %||% NA, check.names = FALSE)
    fx_title <- "Fixed effects (Type III, Satterthwaite)"
    if (lme4::isSingular(fit)) notes <- c(notes, "The fit is singular: a random effect is estimated as (close to) zero. The model may be more complex than the data support.")
  }
  summary_txt <- if (nrow(at)) paste(sprintf("%s: F(%s, %s) = %s, %s (%s)", at$Source, ag_short(at$DF),
    ag_short(at[["Denominator DF"]]), ag_short(at$F), ag_p_text(at[["P value"]]), ag_stars(at[["P value"]])), collapse = "; ") else ""
  cmp <- if (is.null(mc)) NULL else ag_emm_comparisons(mc)
  tables <- list()
  tables[[fx_title]] <- at
  if (!is.null(cmp)) tables[[posthoc %||% "Multiple comparisons"]] <- ag_comparison_table(cmp)
  tables[["Random effects"]] <- re
  tables[["Coefficients"]] <- fe
  if (!is.null(group)) tables[["Group summary"]] <- ag_group_summary(d, y, group)
  ag_result(title, paste0(summary_txt, "."), tables = tables, comparisons = cmp, model = fit,
            label = if (nrow(at)) paste(sprintf("%s: %s", at$Source, ag_p_label(at[["P value"]], "p")), collapse = "\n") else NULL,
            notes = notes)
}

# Correlation ---------------------------------------------------------------------

ag_result_cor <- function(test, d, x, y, method) {
  sym <- switch(method, pearson = "r", spearman = "rho", kendall = "tau")
  est <- unname(test$estimate); p <- test$p.value
  main <- data.frame(Method = test$method, Coefficient = sym, Value = est, N = nrow(d),
                     `P value` = p, Significance = ag_stars(p), check.names = FALSE)
  if (!is.null(test$conf.int)) { main[["Lower 95% CI"]] <- test$conf.int[1]; main[["Upper 95% CI"]] <- test$conf.int[2] }
  if (method == "pearson") main[["R squared"]] <- est^2
  ag_result(test$method,
            sprintf("%s between %s and %s: %s = %s, %s (%s), n = %d.", test$method, x, y, sym,
                    ag_short(est), ag_p_text(p), ag_stars(p), nrow(d)),
            tables = list(Correlation = main),
            label = sprintf("%s = %s, %s", sym, ag_short(est), ag_p_label(p, "p")), model = test)
}

# Correlation matrices ----------------------------------------------------------------

# Every pair of the chosen number columns (all number columns when none are
# given), each pair once: r, its 95% CI (Pearson), P value, the P value
# adjusted for the number of pairs (p.adjust), and n. Each pair uses the rows
# where both columns have values.
ag_cor_pairs <- function(df, columns = NULL, method = "pearson", adjust = "none") {
  df <- as.data.frame(df, check.names = FALSE)
  if (!length(columns)) columns <- names(df)[vapply(df, is.numeric, logical(1))]
  miss <- setdiff(columns, names(df))
  if (length(miss)) stop("No column ", paste0("'", miss, "'", collapse = ", "), " in the data.")
  notnum <- columns[!vapply(df[columns], is.numeric, logical(1))]
  if (length(notnum)) stop("Correlations need number columns; not numbers: ", paste(notnum, collapse = ", "), ".")
  if (length(columns) < 2) stop("A correlation matrix needs at least two number columns.")
  idx <- utils::combn(length(columns), 2)
  rows <- lapply(seq_len(ncol(idx)), function(j) {
    a <- columns[idx[1, j]]; b <- columns[idx[2, j]]
    ok <- stats::complete.cases(df[[a]], df[[b]])
    out <- data.frame(column1 = a, column2 = b, r = NA_real_, lower = NA_real_, upper = NA_real_,
                      p = NA_real_, n = sum(ok), stringsAsFactors = FALSE)
    if (out$n >= 3) {
      t <- tryCatch(suppressWarnings(stats::cor.test(df[[a]][ok], df[[b]][ok], method = method,
                                                     exact = if (method == "pearson") NULL else FALSE)),
                    error = function(e) NULL)
      if (!is.null(t)) {
        out$r <- unname(t$estimate); out$p <- t$p.value
        if (!is.null(t$conf.int)) { out$lower <- t$conf.int[1]; out$upper <- t$conf.int[2] }
      }
    }
    out
  })
  out <- do.call(rbind, rows)
  out$p_adjusted <- stats::p.adjust(out$p, method = adjust)
  attr(out, "columns") <- columns
  out
}

# A correlation matrix as a long table, ready for a heatmap: one row per pair of
# columns, both ways round, and each column with itself (triangle = "full"), or
# each pair once ("half"). column1 runs left to right and column2 top to bottom
# in the order the columns were given. label is r to 2 decimals, label_stars
# adds significance stars (adjusted P < 0.05). Use it in a pipe: df |> ag_correlate().
ag_correlate <- function(.data, columns = NULL, method = "pearson", adjust = "none", triangle = "full") {
  half <- ag_cor_pairs(.data, columns, method, adjust)
  lv <- attr(half, "columns")
  d <- as.data.frame(.data, check.names = FALSE)
  self <- data.frame(column1 = lv, column2 = lv, r = 1, lower = NA_real_, upper = NA_real_, p = NA_real_,
                     n = vapply(lv, function(v) sum(!is.na(d[[v]])), integer(1)), p_adjusted = NA_real_,
                     stringsAsFactors = FALSE)
  other <- half
  other$column1 <- half$column2; other$column2 <- half$column1
  out <- if (identical(triangle, "half")) rbind(half, self) else rbind(half, other, self)
  out$column1 <- factor(out$column1, levels = lv)
  out$column2 <- factor(out$column2, levels = rev(lv))
  out <- out[order(as.integer(out$column1), -as.integer(out$column2)), , drop = FALSE]
  out$label <- ifelse(is.na(out$r), "", sprintf("%.2f", out$r))
  sig <- !is.na(out$p_adjusted) & out$p_adjusted < 0.05
  out$label_stars <- paste0(out$label, ifelse(sig, ag_stars(out$p_adjusted), ""))
  rownames(out) <- NULL
  out
}

# Text for a correlation: r with stars or its P value ("p = 0.012" or just
# "0.012"), stars or the P value alone, or nothing. format: "r", "r_stars",
# "r_p", "r_pnum", "stars", "p", "pnum" or "none".
ag_cor_label <- function(r, p, format = "r", digits = 2) {
  rr <- ifelse(is.na(r), "", formatC(r, digits = digits, format = "f"))
  has_p <- !is.na(p)
  pnum <- ifelse(has_p, ag_fmt_p(p), "")
  ptxt <- ifelse(has_p, ag_p_text(p), "")
  stars <- ifelse(has_p & p < 0.05, ag_stars(p), "")
  switch(format,
    r = rr,
    r_stars = paste0(rr, stars),
    r_p = ifelse(has_p, paste0(rr, "\n", ptxt), rr),
    r_pnum = ifelse(has_p, paste0(rr, "\n", pnum), rr),
    stars = stars,
    p = ptxt,
    pnum = pnum,
    rep("", length(r)))
}

# A correlation heatmap, as layers to add to a ggplot: one tile per pair of
# columns, filled by r, with r (and its P value or stars) written in. The fill
# scale is the plot's own (scale_fill_viridis_c() and others). triangle:
# "full", "lower" or "upper". text_colour "auto" writes white on dark tiles:
# dark = "low" (e.g. viridis, dark for low r), "both" (dark at both ends,
# e.g. blue-red) or "none"; limits = the colour scale's range.
ag_cor_heatmap <- function(data, columns = NULL, method = "pearson", adjust = "none", triangle = "full",
                           label = "r", digits = 2, text_size = NULL, text_colour = "auto",
                           dark = "low", limits = c(-1, 1), border = "white") {
  d <- ag_correlate(data, columns, method, adjust, triangle = if (triangle == "full") "full" else "half")
  # Text that fits the tiles: smaller with more columns, and with two lines.
  if (is.null(text_size) || is.na(text_size)) {
    k <- nlevels(d$column1)
    text_size <- max(1.8, min(4, 30 / k)) * if (label %in% c("r_p", "r_pnum")) 0.85 else 1
  }
  if (triangle == "upper") {
    off <- as.character(d$column1) != as.character(d$column2)
    lv <- levels(d$column1)
    a <- as.character(d$column1); b <- as.character(d$column2)
    d$column1 <- factor(ifelse(off, b, a), levels = lv)
    d$column2 <- factor(ifelse(off, a, b), levels = rev(lv))
  }
  p <- if (adjust != "none") d$p_adjusted else d$p
  d$text <- ag_cor_label(d$r, p, label, digits)
  if (identical(text_colour, "auto")) {
    lo <- limits[1]; hi <- limits[2]
    t <- pmin(1, pmax(0, (d$r - lo) / (hi - lo)))
    on_dark <- switch(dark, low = t < 0.5, high = t > 0.5, both = abs(t - 0.5) > 0.35, rep(FALSE, nrow(d)))
    d$text_colour <- ifelse(!is.na(on_dark) & on_dark, "white", "black")
  } else d$text_colour <- text_colour
  sym <- switch(method, pearson = "r", spearman = "rho", kendall = "tau")
  out <- list(ggplot2::geom_tile(data = d, ggplot2::aes(x = column1, y = column2, fill = r),
                                 colour = border, inherit.aes = FALSE))
  if (label != "none") {
    out <- c(out, list(ggplot2::geom_text(data = d, ggplot2::aes(x = column1, y = column2, label = text, colour = I(text_colour)),
                                          size = text_size, lineheight = 0.9, inherit.aes = FALSE)))
  }
  c(out, list(ggplot2::labs(x = NULL, y = NULL, fill = sym)))
}

# Every pair of the chosen number columns as x and y, one block of rows per
# pair (x_column, y_column), for a scatterplot matrix. Other columns (groups,
# IDs) come along. triangle: "lower" (each pair once), "upper", or "both".
ag_pairs_long <- function(.data, columns = NULL, triangle = "lower") {
  d <- as.data.frame(.data, check.names = FALSE)
  if (!length(columns)) columns <- names(d)[vapply(d, is.numeric, logical(1))]
  miss <- setdiff(columns, names(d))
  if (length(miss)) stop("No column ", paste0("'", miss, "'", collapse = ", "), " in the data.")
  if (length(columns) < 2) stop("A scatterplot matrix needs at least two number columns.")
  keep <- setdiff(names(d), c(columns, "x", "y", "x_column", "y_column"))
  idx <- expand.grid(i = seq_along(columns), j = seq_along(columns))
  idx <- switch(triangle, upper = idx[idx$j < idx$i, ], both = idx[idx$i != idx$j, ], idx[idx$j > idx$i, ])
  out <- do.call(rbind, lapply(seq_len(nrow(idx)), function(k) {
    a <- columns[idx$i[k]]; b <- columns[idx$j[k]]
    cbind(d[keep], data.frame(x_column = a, y_column = b, x = d[[a]], y = d[[b]], stringsAsFactors = FALSE))
  }))
  out$x_column <- factor(out$x_column, levels = columns)
  out$y_column <- factor(out$y_column, levels = columns)
  out
}

# A scatterplot matrix, as layers to add to a ggplot: each pair of columns in
# its own panel, with an optional regression line (straight, with or without
# an intercept, or a smoother) and r with its P value or stars in a corner.
ag_scatter_matrix <- function(data, columns = NULL, triangle = "lower", method = "pearson", adjust = "none",
                              point_size = 1.6, point_colour = "black", alpha = 0.8, colour_by = NULL,
                              line = "lm", intercept = TRUE, se = FALSE, line_colour = "#0072B2",
                              line_type = "solid", line_width = 0.8,
                              label = "r_p", digits = 2, label_size = 3.4, position = "top-left") {
  long <- ag_pairs_long(data, columns, triangle)
  pts <- if (length(colour_by) && nzchar(colour_by)) {
    if (!colour_by %in% names(long)) stop("Colour by: no column '", colour_by, "'.")
    ggplot2::geom_point(data = long, ggplot2::aes(x = x, y = y, colour = .data[[colour_by]]),
                        size = point_size, alpha = alpha, inherit.aes = FALSE)
  } else {
    ggplot2::geom_point(data = long, ggplot2::aes(x = x, y = y), size = point_size, colour = point_colour,
                        alpha = alpha, inherit.aes = FALSE)
  }
  out <- list(pts)
  if (line != "none") {
    fml <- if (line == "lm" && !isTRUE(intercept)) y ~ x - 1 else y ~ x
    out <- c(out, list(ggplot2::geom_smooth(data = long, ggplot2::aes(x = x, y = y),
      method = if (line == "loess") "loess" else "lm", formula = fml, se = se,
      colour = line_colour, linetype = line_type, linewidth = line_width, inherit.aes = FALSE)))
  }
  out <- c(out, list(ggplot2::facet_grid(rows = ggplot2::vars(y_column), cols = ggplot2::vars(x_column),
                                         scales = "free", switch = "both"),
                     ggplot2::labs(x = NULL, y = NULL),
                     ggplot2::theme(strip.placement = "outside", strip.background = ggplot2::element_blank())))
  if (label != "none") {
    pairs <- unique(long[c("x_column", "y_column")])
    stats <- do.call(rbind, lapply(seq_len(nrow(pairs)), function(k) {
      sub <- long[long$x_column == pairs$x_column[k] & long$y_column == pairs$y_column[k], ]
      ok <- stats::complete.cases(sub$x, sub$y)
      t <- if (sum(ok) >= 3) tryCatch(suppressWarnings(stats::cor.test(sub$x[ok], sub$y[ok], method = method,
                                                                      exact = if (method == "pearson") NULL else FALSE)), error = function(e) NULL)
      data.frame(r = if (is.null(t)) NA_real_ else unname(t$estimate), p = if (is.null(t)) NA_real_ else t$p.value)
    }))
    p <- stats::p.adjust(stats$p, method = adjust)
    sym <- switch(method, pearson = "r", spearman = "rho", kendall = "tau")
    text <- ag_cor_label(stats$r, p, label, digits)
    if (label %in% c("r", "r_stars", "r_p", "r_pnum")) text <- paste0(sym, " = ", text)
    lab <- cbind(pairs, text = text)
    left <- grepl("left", position); top <- grepl("top", position)
    out <- c(out, list(ggplot2::geom_text(data = lab, ggplot2::aes(label = text),
      x = if (left) -Inf else Inf, y = if (top) Inf else -Inf,
      hjust = if (left) -0.08 else 1.08, vjust = if (top) 1.25 else -0.4,
      size = label_size, lineheight = 0.9, inherit.aes = FALSE)))
  }
  out
}

# The correlation matrix as an analysis result: the r and P value matrices and
# a table of every pair.
ag_result_cormatrix <- function(d, columns = NULL, method = "pearson", adjust = "none") {
  pairs <- ag_cor_pairs(d, columns, method, adjust)
  lv <- attr(pairs, "columns"); k <- length(lv)
  i <- match(pairs$column1, lv); j <- match(pairs$column2, lv)
  square <- function(v, diagonal) {
    m <- matrix(diagonal, k, k, dimnames = list(lv, lv))
    m[cbind(i, j)] <- v; m[cbind(j, i)] <- v
    m
  }
  as_table <- function(m) data.frame(Column = lv, as.data.frame(m, check.names = FALSE), check.names = FALSE, row.names = NULL)
  sym <- switch(method, pearson = "r", spearman = "rho", kendall = "tau")
  name <- switch(method, pearson = "Pearson's r", spearman = "Spearman's rho", kendall = "Kendall's tau")
  padj <- adjust != "none"
  pv <- if (padj) pairs$p_adjusted else pairs$p
  pmat <- square(ag_fmt_p(pv), "")
  pmat[is.na(square(pv, NA))] <- ""
  diag(pmat) <- ""
  tab <- data.frame(`Column 1` = pairs$column1, `Column 2` = pairs$column2, check.names = FALSE)
  tab[[sym]] <- pairs$r
  if (method == "pearson") { tab[["Lower 95% CI"]] <- pairs$lower; tab[["Upper 95% CI"]] <- pairs$upper }
  tab[["P value"]] <- pairs$p
  if (padj) tab[["Adjusted P value"]] <- pairs$p_adjusted
  tab[["N"]] <- pairs$n
  tab[["Significance"]] <- ag_stars(pv)
  best <- which.max(abs(pairs$r))
  summary <- sprintf("%s between %d columns (%d pairs).", name, k, nrow(pairs))
  if (length(best)) summary <- paste0(summary, sprintf(" Strongest: %s and %s, %s = %s, %s.", pairs$column1[best], pairs$column2[best],
                                                       sym, ag_short(pairs$r[best]), ag_p_text(pv[best])))
  notes <- "Each pair uses the rows where both columns have values."
  if (padj) notes <- c(notes, sprintf("P values adjusted for the %d pairs (%s).", nrow(pairs), adjust))
  ag_result("Correlation matrix", summary,
            tables = list(`Correlation coefficients` = as_table(square(pairs$r, 1)),
                          `P values` = as_table(pmat), Pairs = tab),
            notes = notes, model = pairs)
}

# Regression ------------------------------------------------------------------------

ag_curve_grid <- function(xs, log_spaced = FALSE, n = 200) {
  xs <- xs[is.finite(xs)]
  if (log_spaced) {
    xs <- xs[xs > 0]
    return(10^seq(log10(min(xs)), log10(max(xs)), length.out = n))
  }
  seq(min(xs), max(xs), length.out = n)
}

ag_result_lm <- function(fit, d, x, y, model = "linear") {
  s <- summary(fit)
  cf <- as.data.frame(s$coefficients)
  ci <- suppressMessages(stats::confint(fit))
  coefs <- data.frame(Term = rownames(cf), Estimate = cf$Estimate, SE = cf$`Std. Error`,
                      `Lower 95% CI` = ci[, 1], `Upper 95% CI` = ci[, 2], t = cf$`t value`,
                      `P value` = cf$`Pr(>|t|)`, check.names = FALSE)
  b <- stats::coef(fit)
  eq <- switch(model,
    linear = sprintf("y = %s x %s %s", ag_short(b[2]), if (b[1] < 0) "-" else "+", ag_short(abs(b[1]))),
    origin = sprintf("y = %s x", ag_short(b[1])),
    log = sprintf("y = %s + %s ln(x)", ag_short(b[1]), ag_short(b[2])),
    poly2 = , poly3 = paste0("y = ", paste(sprintf("%s%s", ag_short(b), c("", " x", " x^2", " x^3")[seq_along(b)]), collapse = " + ")),
    "")
  eq <- gsub("+ -", "- ", eq, fixed = TRUE)
  f <- s$fstatistic
  fit_stats <- data.frame(`R squared` = s$r.squared, `Adjusted R squared` = s$adj.r.squared,
                          `Residual SD` = s$sigma, N = stats::nobs(fit),
                          F = if (!is.null(f)) unname(f[1]) else NA,
                          `P value` = if (!is.null(f)) stats::pf(f[1], f[2], f[3], lower.tail = FALSE) else NA,
                          AIC = stats::AIC(fit), check.names = FALSE)
  grid <- data.frame(ag_curve_grid(d[[x]], log_spaced = model == "log")); names(grid) <- x
  pr <- stats::predict(fit, newdata = grid, interval = "confidence")
  curve <- data.frame(x = grid[[x]], y = pr[, "fit"], lwr = pr[, "lwr"], upr = pr[, "upr"])
  ag_result(paste("Regression:", y, "vs", x),
            sprintf("%s. R squared = %s, n = %d.", eq, ag_short(s$r.squared), stats::nobs(fit)),
            tables = list(Coefficients = coefs, `Goodness of fit` = fit_stats),
            label = sprintf("%s\nR² = %s", eq, ag_short(s$r.squared, 3)),
            curve = curve, model = fit)
}

ag_result_nls <- function(fit, d, x, y, model) {
  s <- summary(fit)
  cf <- as.data.frame(s$coefficients)
  ci <- tryCatch(suppressMessages(stats::confint.default(fit)), error = function(e) matrix(NA, nrow(cf), 2))
  coefs <- data.frame(Parameter = rownames(cf), Estimate = cf$Estimate, SE = cf$`Std. Error`,
                      `Lower 95% CI` = ci[, 1], `Upper 95% CI` = ci[, 2], `P value` = cf$`Pr(>|t|)`,
                      check.names = FALSE)
  b <- stats::coef(fit)
  derived <- NULL
  label <- ""
  if (model == "4pl") {
    hill <- 1 / (b[["scal"]] * log(10))
    derived <- data.frame(Parameter = c("Bottom", "Top", "LogEC50", "EC50", "Hill slope"),
                          Estimate = c(b[["bottom"]], b[["top"]], b[["logEC50"]], 10^b[["logEC50"]], hill))
    label <- sprintf("EC50 = %s\nHill slope = %s", ag_short(10^b[["logEC50"]]), ag_short(hill))
  } else if (model == "mm") {
    label <- sprintf("Vmax = %s\nKm = %s", ag_short(b[["Vmax"]]), ag_short(b[["Km"]]))
  } else if (model == "exp") {
    label <- sprintf("y = %s e^(%s x)", ag_short(b[["a"]]), ag_short(b[["b"]]))
  } else if (model == "power") {
    label <- sprintf("y = %s x^%s", ag_short(b[["a"]]), ag_short(b[["b"]]))
  } else if (model == "decay") {
    k <- exp(b[["log_k"]])
    derived <- data.frame(Parameter = c("Plateau", "Y0", "K", "Half-life"),
                          Estimate = c(b[["plateau"]], b[["y0"]], k, log(2) / k))
    label <- sprintf("K = %s\nHalf-life = %s", ag_short(k), ag_short(log(2) / k))
  }
  res <- stats::residuals(fit); yy <- d[[y]]
  r2 <- 1 - sum(res^2) / sum((yy - mean(yy))^2)
  fit_stats <- data.frame(`R squared` = r2, `Residual SD` = s$sigma, N = length(res),
                          AIC = stats::AIC(fit), check.names = FALSE)
  grid <- data.frame(ag_curve_grid(d[[x]], log_spaced = model %in% c("4pl", "power"))); names(grid) <- x
  curve <- data.frame(x = grid[[x]], y = stats::predict(fit, newdata = grid))
  tables <- list(`Best-fit values` = coefs)
  if (!is.null(derived)) tables[["Derived values"]] <- derived
  tables[["Goodness of fit"]] <- fit_stats
  ag_result(paste("Nonlinear regression:", y, "vs", x),
            sprintf("%s. R squared = %s, n = %d.", gsub("\n", ", ", label), ag_short(r2), length(res)),
            tables = tables, label = sprintf("%s\nR² = %s", label, ag_short(r2, 3)),
            curve = curve, model = fit)
}

# ---- Talking to the app (JSON in / out) -------------------------------------------------

ag_json <- function(x) jsonlite::toJSON(x, auto_unbox = TRUE, null = "null", na = "null", digits = NA)

# Evaluate code in the global environment and report errors and warnings as JSON.
ag_eval_json <- function(code) {
  warns <- character(); msgs <- character()
  value <- NULL
  err <- tryCatch({
    withCallingHandlers({
      exprs <- parse(text = code, keep.source = FALSE)
      for (e in exprs) value <- eval(e, envir = globalenv())
      NULL
    }, warning = function(w) {
      warns <<- c(warns, conditionMessage(w)); invokeRestart("muffleWarning")
    }, message = function(m) {
      msgs <<- c(msgs, trimws(conditionMessage(m))); invokeRestart("muffleMessage")
    })
  }, error = function(e) {
    msg <- conditionMessage(e)
    call <- conditionCall(e)
    if (!is.null(call) && !grepl("^ag_|eval", deparse(call)[1])) msg <- paste0(msg, "  [in ", deparse(call, nlines = 1)[1], "]")
    msg
  })
  out <- list(ok = is.null(err), error = err, warnings = I(unique(warns)), messages = I(unique(msgs)))
  if (is.null(err) && is.character(value) && length(value) == 1) out$value <- value
  ag_json(out)
}

ag_col_type <- function(v) {
  if (is.factor(v)) "factor" else if (is.logical(v)) "logical" else if (is.numeric(v)) "numeric" else
    if (inherits(v, c("Date", "POSIXt"))) "date" else "character"
}

# Column names, types and levels of a data frame, for the app's dropdowns.
ag_describe_list <- function(df) {
  if (!is.data.frame(df)) stop("not a data frame")
  cols <- lapply(names(df), function(nm) {
    v <- df[[nm]]; type <- ag_col_type(v)
    lev <- if (type == "factor") levels(v) else if (type %in% c("character", "logical")) {
      u <- unique(as.character(v[!is.na(v)])); if (length(u) <= 500) u else NULL } else NULL
    if (type == "numeric") { u <- unique(v[!is.na(v)]); if (length(u) <= 30) lev <- as.character(sort(u)) }
    list(name = nm, type = type, levels = I(lev %||% character()), missing = sum(is.na(v)))
  })
  list(nrow = nrow(df), columns = cols)
}

ag_describe <- function(df) ag_json(ag_describe_list(df))

ag_cell_text <- function(v, digits = 15) {
  if (is.numeric(v)) out <- as.character(signif(v, digits)) else out <- as.character(v)
  out[is.na(v)] <- ""
  out
}

# First rows of a data frame as text, for importing into the grid (full
# precision) and for previews (digits = 6).
ag_table_list <- function(df, n = Inf, digits = 15) {
  df <- as.data.frame(df, check.names = FALSE, stringsAsFactors = FALSE)
  if (is.finite(n)) df <- utils::head(df, n)
  cols <- lapply(names(df), function(nm) list(name = nm, type = ag_col_type(df[[nm]]),
    levels = if (is.factor(df[[nm]])) I(levels(df[[nm]])) else I(character())))
  rows <- if (nrow(df)) do.call(mapply, c(list(FUN = function(...) I(c(...)), SIMPLIFY = FALSE, USE.NAMES = FALSE),
                                         lapply(df, ag_cell_text, digits = digits))) else list()
  out <- list(columns = cols, rows = rows)
  # Real row names (e.g. car models in mtcars), not just 1, 2, 3…
  if (is.character(attr(df, "row.names"))) out$row_names <- I(rownames(df))
  out
}

ag_table_json <- function(df, n = Inf) ag_json(ag_table_list(df, n))

ag_preview <- function(df, n = 200) {
  out <- ag_table_list(df, n, digits = 6)
  out$nrow <- nrow(df)
  ag_json(out)
}

# A data table's own pipeline, run one step at a time so that a problem can be
# pinned to its step. `steps` holds each step's code, to follow `df |>`.
# Returns the columns after every step and the first `n` rows of the result.
ag_pipe_eval <- function(df, steps, n = 200, digits = 6) {
  out <- list(input = ag_describe_list(df), stages = list(), failed = NULL, error = NULL)
  for (i in seq_along(steps)) {
    env <- new.env(parent = globalenv())
    env$.ag_in <- df
    res <- tryCatch(eval(parse(text = paste(".ag_in |>", steps[[i]]), keep.source = FALSE)[[1]], env),
                    error = function(e) e)
    if (!inherits(res, "error") && !is.data.frame(res)) res <- simpleError("This step did not return a table.")
    if (inherits(res, "error")) {
      out$failed <- i
      out$error <- conditionMessage(res)
      break
    }
    df <- res
    out$stages[[i]] <- ag_describe_list(df)
  }
  if (inherits(df, "grouped_df")) df <- dplyr::ungroup(df)
  out$table <- ag_table_list(df, n, digits)
  out$table$nrow <- nrow(df)
  ag_json(out)
}

# An analysis result as JSON, with numbers formatted for display.
ag_result_json <- function(res) {
  fmt_table <- function(tab) {
    tab <- as.data.frame(tab, check.names = FALSE, stringsAsFactors = FALSE)
    cols <- names(tab)
    vals <- lapply(cols, function(nm) {
      v <- tab[[nm]]
      if (is.numeric(v) && grepl("p value", nm, ignore.case = TRUE)) ifelse(is.na(v), "", ag_fmt_p(v))
      else if (is.numeric(v)) ifelse(is.na(v), "", ifelse(abs(v - round(v)) < 1e-9 & abs(v) < 1e7, format(round(v), trim = TRUE, scientific = FALSE), ag_num(v)))
      else ifelse(is.na(v), "", as.character(v))
    })
    rows <- if (nrow(tab)) lapply(seq_len(nrow(tab)), function(i) I(vapply(vals, `[`, character(1), i))) else list()
    list(columns = I(cols), rows = rows)
  }
  ag_json(list(title = res$title, summary = res$summary, notes = I(res$notes %||% character()),
               tables = lapply(names(res$tables), function(nm) c(list(name = nm), fmt_table(res$tables[[nm]]))),
               has_comparisons = !is.null(res$comparisons) && nrow(res$comparisons) > 0,
               has_curve = !is.null(res$curve), label = res$label))
}

# ---- Drawing and saving plots ----------------------------------------------------------

ag_open_device <- function(file, format, width, height, dpi = 300) {
  cairo <- isTRUE(capabilities("cairo"))
  switch(format,
    svg = grDevices::svg(file, width = width, height = height),
    # SVG with real, editable text (needs the svglite package).
    svg_text = svglite::svglite(file, width = width, height = height),
    pdf = if (cairo) grDevices::cairo_pdf(file, width = width, height = height) else grDevices::pdf(file, width = width, height = height),
    png = if (cairo) grDevices::png(file, width = width, height = height, units = "in", res = dpi, type = "cairo")
          else grDevices::png(file, width = width, height = height, units = "in", res = dpi),
    tiff = if (cairo) grDevices::tiff(file, width = width, height = height, units = "in", res = dpi, compression = "lzw", type = "cairo")
           else grDevices::tiff(file, width = width, height = height, units = "in", res = dpi, compression = "lzw"),
    stop("Unknown format ", format))
}

# Draw a plot to a file. Returns JSON with any error and warnings, and the SVG
# text itself when format = "svg" and inline = TRUE (used for the live preview).
# With geometry = TRUE it also reports where the plotting panel sits in the
# image and the range of each continuous axis, so axes can be dragged.
ag_draw <- function(plot, file, format = "svg", width = 5, height = 4, dpi = 300, inline = FALSE, geometry = FALSE) {
  warns <- character()
  dev <- NULL
  geom <- NULL
  err <- tryCatch({
    withCallingHandlers({
      ag_open_device(file, format, width, height, dpi)
      dev <- grDevices::dev.cur()
      if (geometry && inherits(plot, "ggplot")) {
        built <- ggplot2::ggplot_build(plot)
        table <- ggplot2::ggplot_gtable(built)
        grid::grid.newpage()
        grid::grid.draw(table)
        geom <- tryCatch(ag_panel_geometry(built, table, width, height), error = function(e) NULL)
      } else {
        print(plot)
      }
      NULL
    }, warning = function(w) {
      warns <<- c(warns, conditionMessage(w)); invokeRestart("muffleWarning")
    }, message = function(m) invokeRestart("muffleMessage"))
  }, error = function(e) conditionMessage(e),
  finally = if (!is.null(dev)) try(grDevices::dev.off(dev), silent = TRUE))
  out <- list(ok = is.null(err), error = err, warnings = I(unique(warns)))
  if (is.null(err) && inline) out$svg <- paste(readLines(file, warn = FALSE, encoding = "UTF-8"), collapse = "\n")
  if (!is.null(geom)) out$geometry <- geom
  ag_json(out)
}

# The panel's edges as fractions of the image (from the top-left corner) and
# the visible range of the horizontal (h) and vertical (v) axes, in the scale's
# own units (e.g. log10 units on a log axis). Only for single-panel plots.
ag_panel_geometry <- function(built, table, width, height) {
  panels <- table$layout[grepl("^panel", table$layout$name), , drop = FALSE]
  if (nrow(panels) != 1) return(NULL)
  grid::seekViewport("layout")
  grid::pushViewport(grid::viewport(layout.pos.row = panels$t:panels$b, layout.pos.col = panels$l:panels$r))
  ll <- grid::deviceLoc(grid::unit(0, "npc"), grid::unit(0, "npc"), valueOnly = TRUE)
  ur <- grid::deviceLoc(grid::unit(1, "npc"), grid::unit(1, "npc"), valueOnly = TRUE)
  grid::upViewport(0)
  pp <- built$layout$panel_params[[1]]
  axis <- function(s) if (is.null(s) || s$is_discrete()) NULL else list(range = I(s$continuous_range))
  list(left = ll$x / width, right = ur$x / width, top = 1 - ur$y / height, bottom = 1 - ll$y / height,
       h = axis(pp$x), v = axis(pp$y))
}

# ---- Project files (.RData) -----------------------------------------------------------------

# Save the named objects plus the app's project description into one .RData file.
ag_save_rdata <- function(file, objects, project_json) {
  env <- new.env()
  for (o in objects) if (exists(o, envir = globalenv(), inherits = FALSE)) assign(o, get(o, envir = globalenv()), envir = env)
  assign(".agrafeuse_project", project_json, envir = env)
  # So analysis results print as readable tables in R too.
  assign("print.ag_result", print.ag_result, envir = env)
  save(list = ls(env, all.names = TRUE), envir = env, file = file)
  invisible(file)
}

# Read an .RData file. Returns the saved Agrafeuse project (if any) and every
# data frame in the file, so plain .RData files from R can be opened too.
ag_load_rdata <- function(file) {
  env <- new.env()
  load(file, envir = env)
  nms <- ls(env, all.names = TRUE)
  project <- if (exists(".agrafeuse_project", envir = env, inherits = FALSE)) get(".agrafeuse_project", envir = env) else NULL
  frames <- list()
  for (nm in setdiff(nms, c(".agrafeuse_project", "print.ag_result"))) {
    obj <- get(nm, envir = env)
    if (is.matrix(obj) && length(dim(obj)) == 2) obj <- as.data.frame(obj)
    if (is.data.frame(obj)) frames[[nm]] <- ag_table_list(obj)
  }
  ag_json(list(project = project, frames = frames, objects = I(nms)))
}

# The R version and the versions of the packages the app has loaded, for the
# disclaimer and for citing them.
ag_versions <- function(pkgs) {
  pkgs <- pkgs[vapply(pkgs, function(p) nzchar(system.file(package = p)), logical(1))]
  vers <- vapply(pkgs, function(p) as.character(utils::packageVersion(p)), character(1))
  ag_json(list(r = paste(R.version$major, R.version$minor, sep = "."), packages = as.list(vers)))
}

# Check that a piece of user-written code parses, without running it.
ag_check_code <- function(code) {
  res <- tryCatch({ parse(text = code, keep.source = FALSE); NULL }, error = function(e) conditionMessage(e))
  ag_json(list(ok = is.null(res), error = res))
}
