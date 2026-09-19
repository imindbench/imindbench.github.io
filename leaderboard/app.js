/* ============================================================
   iMINDBench Leaderboard — app.js
   ============================================================
   Sections:
     1. Config & state
     2. Data helpers & filtering
     3. Table rendering
     4. Modal rendering
     5. Chart rendering
     6. Summary cards
     7. Multi-select task dropdown
     8. Filter UI wiring
     9. Init
   ============================================================ */

/* ============================================================
   1. CONFIG & STATE
   ============================================================ */

// Set to true to show STFT reference roofline on bar charts.
const SHOW_ROOFLINE = false;

// Leaderboard-local manifests define the fixed Main/Challenge split.
const DECODABLE_SET_ID = "val_mean0p60";
const DECODABLE_MANIFEST_DIR = "decodable_subject_sessions/stft_or_htnet_500hz_val_mean0p60/";

// Dataset display order: Neuroprobe → BYD → Pippi
const DATASET_ORDER = ["neuroprobev2", "kelesbyd2024", "berezutskayapippi2022"];

const state = {
  tab: "leaderboard",
  track: "STFT",          // default to STFT track
  dataset: "all",
  models: [],             // [] = all models; non-empty = filter to these model keys
  tasks: [],              // [] = all tasks; non-empty = filter to these task keys
  decodable: "resolved",  // default to Main cohort
  metric: "roc_auc",
  sortCol: "mean_all",
  sortDir: "desc",
};

// Fallback palette for unknown models
const PALETTE = [
  "#4e79a7", "#f28e2b", "#e15759", "#76b7b2",
  "#59a14f", "#edc948", "#b07aa1", "#ff9da7",
];

// Named colors per model — perceptually distinct, colorblind-friendly (Tableau-inspired)
const MODEL_COLORS = {
  "logistic": "#76b7b2",  // steel blue
  "mlp":      "#f28e2b",  // orange
  "cnn":      "#e15759",  // red
  "popt":     "#b07aa1",  // teal
  "diver":    "#59a14f",  // green
  "htnet":    "#4e79a7",  // purple
  "barista":    "#d39c2e",
};

let modelColorMap = {};
let leaderboardData = null;
let modelInfo = {};

const DATASET_LABELS = {
  "kelesbyd2024": "BYD",
  "berezutskayapippi2022": "Pippi",
  "neuroprobev2": "Neuroprobe",
};

const TASK_DISPLAY_NAMES = {
  onset: "Sentence Onset",
  speech: "Speech",
  volume: "Volume",
  delta_volume: "Delta Volume",
  pitch: "Voice Pitch",
  word_index: "Word Position",
  word_gap: "Inter-word Gap",
  gpt2_surprisal: "GPT-2 Surprisal",
  word_head_pos: "Head Word Position",
  word_part_speech: "Part of Speech",
  word_length: "Word Length",
  global_flow: "Global Optical Flow",
  local_flow: "Local Optical Flow",
  frame_brightness: "Frame Brightness",
  face_num: "Number of Faces",
};

const TASK_DISPLAY_ORDER = [
  "Sentence Onset", "Speech", "Word Position", "Inter-word Gap",
  "GPT-2 Surprisal", "Head Word Position", "Word Length", "Part of Speech",
  "Delta Volume", "Volume", "Voice Pitch", "Global Optical Flow",
  "Local Optical Flow", "Frame Brightness", "Number of Faces",
];

function getModelDisplay(model) {
  return (modelInfo[model] && modelInfo[model].display_name) || model;
}

function getModelInfo(model) {
  return modelInfo[model] || { pretrained: null, pretrained_on: null, description: null };
}

function getPreprocessDisplay(runDisplay, modelName) {
  let s = runDisplay;
  if (s.toLowerCase().startsWith(modelName.toLowerCase() + "_")) {
    s = s.slice(modelName.length + 1);
  }
  return s.replace(/_/g, " ");
}

function orderDatasets(datasets) {
  return [...datasets].sort((a, b) => {
    const ai = DATASET_ORDER.indexOf(a);
    const bi = DATASET_ORDER.indexOf(b);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });
}

/* ============================================================
   2. DATA HELPERS & FILTERING
   ============================================================ */

function getData() { return leaderboardData; }

// Per-dataset/per-task subject-session allowlists for the fixed cohort.
function activeDecodableFilters(ld) {
  return (ld.decodable_filters || {})[DECODABLE_SET_ID] || {};
}

function activeRoofline(ld) {
  return (ld.roofline || {})[DECODABLE_SET_ID] || {};
}

function isDecodable(record, decodableFilters) {
  const df = decodableFilters[record.dataset];
  if (!df) return null;
  const allowed = df[record.task];
  if (!allowed) return null;
  return allowed.includes(record.subject_session);
}

function filterRecords(records, decodableFilters) {
  return records.filter(r => {
    if (state.track !== "all" && r.preprocessing_track !== state.track) return false;
    if (state.dataset !== "all" && r.dataset !== state.dataset) return false;
    if (state.models.length > 0 && !state.models.includes(r.model_name)) return false;
    if (state.tasks.length > 0 && !state.tasks.includes(r.task)) return false;
    if (state.decodable !== "all") {
      const dec = isDecodable(r, decodableFilters);
      if (state.decodable === "resolved" && dec !== true) return false;
      if (state.decodable === "unresolved" && dec !== false) return false;
    }
    return true;
  });
}

function getMetricKey(split) {
  return state.metric === "roc_auc" ? split + "_roc_auc" : split + "_accuracy";
}

function mean(arr) {
  const v = arr.filter(x => x != null && !isNaN(x));
  if (!v.length) return null;
  return v.reduce((a, b) => a + b, 0) / v.length;
}

function stdErr(arr) {
  const v = arr.filter(x => x != null && !isNaN(x));
  if (v.length < 2) return 0;
  const m = mean(v);
  const variance = v.reduce((a, b) => a + (b - m) * (b - m), 0) / (v.length - 1);
  return Math.sqrt(variance / v.length);
}

function fmt(v, digits) {
  if (digits === undefined) digits = 3;
  if (v == null || isNaN(v)) return "\u2014";
  return v.toFixed(digits);
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escSvg(s) { return escHtml(s); }

// Stable artifact/URL IDs; eligibility is checked by the Python submission validator.
var TRACK_BADGE_CLASS = { WAV: "track-wav", STFT: "track-stft", Other: "track-other" };

function getTrackLabel(track) {
  return { STFT: "Multi-STFT", WAV: "Waveform", Other: "Custom" }[track] || "Custom";
}

function trackBadgeClass(track) {
  return "track-badge " + (TRACK_BADGE_CLASS[track] || "track-other");
}

function trackBadgeHtml(track) {
  return '<span class="' + trackBadgeClass(track) + '">' + escHtml(getTrackLabel(track)) + "</span>";
}

/**
 * Aggregate filtered records into table rows, grouping by model_preprocess_key.
 * This merges BYD (1000 Hz) and other-dataset (2048 Hz) runs onto a single row.
 */
function aggregateRows(filteredRecords, presentDatasets) {
  const metric = getMetricKey("test");
  const byKey = new Map();

  for (const r of filteredRecords) {
    const key = r.model_preprocess_key || r.run_dir;
    if (!byKey.has(key)) {
      byKey.set(key, {
        key,
        modelName: r.model_name,
        runDisplay: r.run_display,
        preprocessingName: r.preprocessing_name,
        preprocessingTrack: r.preprocessing_track,
        preprocessingChain: r.preprocessing_chain,
        runDirs: new Set(),
        byDataset: {},
        allValues: [],
      });
    }
    const entry = byKey.get(key);
    entry.runDirs.add(r.run_dir);
    if (!entry.byDataset[r.dataset]) entry.byDataset[r.dataset] = [];
    const val = r[metric];
    if (val != null && !isNaN(val)) {
      entry.byDataset[r.dataset].push(val);
      entry.allValues.push(val);
    }
  }

  return [...byKey.values()].map(entry => {
    const datasetStats = {};
    for (const ds of presentDatasets) {
      const vals = entry.byDataset[ds] || [];
      datasetStats[ds] = { mean: mean(vals), se: stdErr(vals), n: vals.length };
    }
    return {
      key: entry.key,
      runDirs: [...entry.runDirs],
      modelName: entry.modelName,
      runDisplay: entry.runDisplay,
      preprocessingName: entry.preprocessingName,
      preprocessingTrack: entry.preprocessingTrack,
      preprocessingChain: entry.preprocessingChain,
      datasets: datasetStats,
      mean_all: mean(presentDatasets.map(ds => datasetStats[ds].mean).filter(v => v != null && !isNaN(v))),
    };
  });
}

function sortRows(rows) {
  const col = state.sortCol;
  const dir = state.sortDir === "desc" ? -1 : 1;
  return [...rows].sort((a, b) => {
    let av, bv;
    if (col === "mean_all") { av = a.mean_all; bv = b.mean_all; }
    else { av = a.datasets[col] ? a.datasets[col].mean : null; bv = b.datasets[col] ? b.datasets[col].mean : null; }
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return dir * (av - bv);
  });
}

/* ============================================================
   3. TABLE RENDERING
   ============================================================ */

function renderTable(filteredRecords, metadata) {
  const container = document.getElementById("table-container");
  const taskNote = document.getElementById("task-scope-note");

  const presentDatasets = orderDatasets(
    metadata.datasets.filter(ds => filteredRecords.some(r => r.dataset === ds))
  );

  if (filteredRecords.length === 0) {
    container.innerHTML = '<div class="empty-state"><p>No results match the current filters.</p></div>';
    updateSummaryCards(filteredRecords);
    return;
  }

  if (state.tasks.length === 0) {
    taskNote.textContent = "Showing averages across all tasks.";
  } else if (state.tasks.length === 1) {
    const d = (metadata.task_display_names || {})[state.tasks[0]] || state.tasks[0];
    taskNote.textContent = "Showing values for task: " + d + ".";
  } else {
    taskNote.textContent = "Showing averages across " + state.tasks.length + " selected tasks.";
  }

  const rows = aggregateRows(filteredRecords, presentDatasets);
  const sorted = sortRows(rows);

  const bestByCol = { mean_all: -Infinity };
  const worstByCol = { mean_all: Infinity };
  sorted.forEach(function(r) {
    if ((r.mean_all != null ? r.mean_all : -Infinity) > bestByCol.mean_all) bestByCol.mean_all = r.mean_all;
    if ((r.mean_all != null ? r.mean_all : Infinity) < worstByCol.mean_all) worstByCol.mean_all = r.mean_all;
  });
  for (const ds of presentDatasets) {
    const vals = sorted.map(r => r.datasets[ds] ? r.datasets[ds].mean : null).filter(v => v != null);
    bestByCol[ds]  = vals.length ? Math.max.apply(null, vals) : null;
    worstByCol[ds] = vals.length ? Math.min.apply(null, vals) : null;
  }

  // Sequential single-hue ramp. This emits only the 0-1 position on the scale
  // and leaves the hue and the alpha range to --heat-* in theme.css, so the
  // cells composite over whichever row background the active theme supplies
  // and re-theme on toggle without the table being rebuilt.
  //
  // Scores in a column often sit within a few points of each other, so the
  // exponent pushes the mid-range apart, which is where entries bunch up.
  function heatColor(v, colMin, colMax) {
    if (v == null || colMin == null || colMax == null || colMin === colMax) return "";
    var t = (v - colMin) / (colMax - colMin); // 0=worst, 1=best
    var pos = Math.pow(t, 0.82).toFixed(3);
    return (
      "background:rgba(var(--heat-rgb),calc(var(--heat-alpha-min) + " +
      "var(--heat-alpha-span) * " + pos + "))"
    );
  }

  const metricLabel = state.metric === "roc_auc" ? "ROC-AUC" : "Accuracy";
  const datasetLabels = metadata.dataset_labels || {};

  function sortClass(col) {
    return state.sortCol === col ? ' class="sorted-' + state.sortDir + '"' : "";
  }

  let html = "<table><thead><tr>";
  html += '<th rowspan="2">Model</th>';
  html += '<th rowspan="2">Track | Preprocessing</th>';
  html += '<th rowspan="2">Pretraining</th>';
  html += '<th colspan="' + (presentDatasets.length + 1) + '" style="text-align:center;">Mean test ' + metricLabel + "</th>";
  html += "</tr><tr>";
  html += '<th data-sort="mean_all"' + sortClass("mean_all") + ">All</th>";
  presentDatasets.forEach(function(ds) {
    html += '<th data-sort="' + ds + '"' + sortClass(ds) + ">" + escHtml(datasetLabels[ds] || ds) + "</th>";
  });
  html += "</tr></thead><tbody>";

  sorted.forEach(function(row, idx) {
    const rank = idx + 1;
    let badge;
    if (rank <= 3) {
      badge = '<span class="rank-badge rank-' + rank + '">' + rank + "</span>";
    } else {
      badge = '<span style="display:inline-block;width:1.4rem;margin-right:0.4rem;text-align:center;font-size:0.78rem;color:var(--text-faint)">' + rank + "</span>";
    }
    const prep = getPreprocessDisplay(row.runDisplay, row.modelName);
    const allBest = row.mean_all != null && Math.abs(row.mean_all - bestByCol.mean_all) < 1e-9;

    let dsCells = "";
    presentDatasets.forEach(function(ds) {
      const v = row.datasets[ds] ? row.datasets[ds].mean : null;
      const best = v != null && Math.abs(v - bestByCol[ds]) < 1e-9;
      const bg = heatColor(v, worstByCol[ds], bestByCol[ds]);
      dsCells += '<td class="num-cell' + (best ? " best-cell" : "") + '"' + (bg ? ' style="' + bg + '"' : '') + '>' + fmt(v) + "</td>";
    });

    var minfo = getModelInfo(row.modelName);
    var showCoverage = minfo.coverage_note;
    var coverageIcon = showCoverage
      ? '<span class="coverage-warn" aria-label="Partial subject coverage">*</span>'
      : '';
    html += '<tr data-key="' + escHtml(row.key) + '" title="Click for details">';
    html += "<td>" + badge + escHtml(getModelDisplay(row.modelName)) + coverageIcon + "</td>";
    html += "<td>";
    var trackCls = trackBadgeClass(row.preprocessingTrack);
    html += '<span class="' + trackCls + '">' + escHtml(getTrackLabel(row.preprocessingTrack)) + "</span>";
    html += '<span style="display:block;font-size:0.8rem;color:var(--text-faint);margin-top:0.1rem;">' + escHtml(prep) + "</span>";
    html += "</td>";
    html += "<td class='pretrain-cell'>";
    if (minfo.pretrained === true) {
      html += '';
      if (minfo.pretrained_on) html += '<span class="pretrain-data">' + escHtml(minfo.pretrained_on) + '</span>';
    } else if (minfo.pretrained === false) {
      html += '<span class="pretrain-no">—</span>';
    } else {
      html += '<span style="color:var(--text-faint)">?</span>';
    }
    html += "</td>";
    var allBg = heatColor(row.mean_all, worstByCol.mean_all, bestByCol.mean_all);
    html += '<td class="num-cell' + (allBest ? " best-cell" : "") + '"' + (allBg ? ' style="' + allBg + '"' : '') + '>' + fmt(row.mean_all) + "</td>";
    html += dsCells;
    html += "</tr>";
  });
  html += "</tbody></table>";

  // Footnote for partial coverage models. Shown in every subject cohort —
  // missing cells skew Main and Challenge averages just as they do All.
  {
    var footnotes = [];
    sorted.forEach(function(row) {
      var note = getModelInfo(row.modelName).coverage_note;
      if (note && !footnotes.some(function(f) { return f.model === row.modelName; })) {
        footnotes.push({ model: row.modelName, note: note });
      }
    });
    footnotes.forEach(function(f) {
      html += '<p class="coverage-footnote"><span class="coverage-warn">*</span> <strong>' + escHtml(getModelDisplay(f.model)) + ':</strong> ' + escHtml(f.note) + '</p>';
    });
  }

  container.innerHTML = html;

  container.querySelectorAll("th[data-sort]").forEach(function(th) {
    th.addEventListener("click", function() {
      const col = th.dataset.sort;
      state.sortDir = (state.sortCol === col && state.sortDir === "desc") ? "asc" : "desc";
      state.sortCol = col;
      update();
    });
  });

  container.querySelectorAll("tr[data-key]").forEach(function(tr) {
    tr.addEventListener("click", function() {
      const row = sorted.find(r => r.key === tr.dataset.key);
      if (row) showModal(row, filteredRecords);
    });
  });

  updateSummaryCards(filteredRecords);
}

/* ============================================================
   4. MODAL RENDERING
   ============================================================ */

function showModal(row, filteredRecords) {
  const overlay = document.getElementById("modal-overlay");
  const title = document.getElementById("modal-title");
  const body = document.getElementById("modal-body");

  title.textContent = getModelDisplay(row.modelName) + " \u2014 " + getTrackLabel(row.preprocessingTrack) + " track";

  const rep = filteredRecords.find(r => (r.model_preprocess_key || r.run_dir) === row.key)
    || filteredRecords.find(r => r.model_name === row.modelName);

  const prep = getPreprocessDisplay(row.runDisplay, row.modelName);
  const ld = getData();
  const dsLabels = (ld && ld.metadata && ld.metadata.dataset_labels) || {};
  const presentDs = Object.keys(row.datasets).map(d => dsLabels[d] || d).join(", ");

  let html = '<div class="modal-section">';
  html += '<div class="modal-section-title">Run</div>';
  html += '<table class="modal-kv-table">';
  html += "<tr><td>Model</td><td>" + escHtml(getModelDisplay(row.modelName)) + "</td></tr>";
  var minfo_modal = getModelInfo(row.modelName);
  if (minfo_modal.description) {
    html += "<tr><td>Description</td><td>" + escHtml(minfo_modal.description) + "</td></tr>";
  }
  if (minfo_modal.pretrained === true) {
    html += '<tr><td>Pretraining</td><td><span class="pretrain-yes">✔ Pretrained</span> on ' + escHtml(minfo_modal.pretrained_on || "external data") + "</td></tr>";
  } else if (minfo_modal.pretrained === false) {
    html += '<tr><td>Pretraining</td><td><span class="pretrain-no">Not pretrained</span></td></tr>';
  }
  html += "<tr><td>Preprocessing</td><td>" + escHtml(row.preprocessingName) + "</td></tr>";
  html += "<tr><td>Track</td><td>" + escHtml(getTrackLabel(row.preprocessingTrack)) + "</td></tr>";
  html += "<tr><td>Eval mode</td><td>" + escHtml((rep && rep.eval_mode) || "within-session") + "</td></tr>";
  html += "</table></div>";

  var configMap = new Map();
  filteredRecords.filter(function(record) {
    return record.model_name === row.modelName && (record.model_preprocess_key || record.run_dir) === row.key;
  }).forEach(function(record) {
    var configKey = record.run_id || record.run_dir;
    if (!configMap.has(configKey)) configMap.set(configKey, { run: record, datasets: new Set() });
    configMap.get(configKey).datasets.add(record.dataset);
  });
  var configurations = [...configMap.values()];
  if (!configurations.length && rep) configurations = [{ run: rep, datasets: new Set([rep.dataset]) }];

  configurations.forEach(function(configuration, configIndex) {
    var config = configuration.run;
    var chain = config.preprocessing_chain || [];
    var configDatasets = orderDatasets([...configuration.datasets]);
    var configTitle = configurations.length > 1
      ? "Configuration " + (configIndex + 1)
      : "Preprocessing configuration";
    var datasetBadges = configDatasets.map(function(dataset) {
      return '<span class="run-config-dataset">' + escHtml(dsLabels[dataset] || dataset) + "</span>";
    }).join("");
    html += '<details class="run-config-card"' + (configIndex === 0 ? " open" : "") + ">";
    html += '<summary class="run-config-summary">';
    html += '<span class="run-config-heading"><span class="run-config-title">' + escHtml(configTitle) + "</span>";
    html += '<span class="run-config-subtitle">' + escHtml(String(config.preprocessing_name || "preprocessing").replace(/_/g, " ")) + "</span></span>";
    html += '<span class="run-config-datasets">' + datasetBadges + "</span>";
    html += '<span class="run-config-chevron" aria-hidden="true"></span></summary>';
    html += '<div class="run-config-content">';
    html += '<table class="modal-kv-table">';
    html += "<tr><td>Run directory</td><td>" + escHtml(config.run_dir) + "</td></tr>";
    html += "<tr><td>Datasets</td><td>" + escHtml(configDatasets.map(function(dataset) {
      return dsLabels[dataset] || dataset;
    }).join(", ")) + "</td></tr>";
    html += "</table>";
    if (chain.length > 0) {
      chain.forEach(function(step) {
        const stepName = step.name || "step";
        const params = Object.entries(step)
          .filter(function(e) { return e[0] !== "name"; })
          .map(function(e) {
            const vs = typeof e[1] === "object" ? JSON.stringify(e[1]) : String(e[1]);
            return '<span style="margin-right:0.8rem"><span style="color:var(--text)">' + escHtml(e[0]) + "</span>: " + escHtml(vs) + "</span>";
          }).join("\n");
        html += '<div class="chain-step">';
        html += '<div class="chain-step-name">' + escHtml(stepName) + "</div>";
        if (params) html += '<div class="chain-step-params">' + params + "</div>";
        html += "</div>";
      });
    }
    html += "</div></details>";
  });

  body.innerHTML = html;
  overlay.classList.remove("hidden");
}

function showModelChartModal(modelName, dataset, filteredRecords) {
  const dsRecords = filteredRecords.filter(r => r.model_name === modelName && r.dataset === dataset);
  if (!dsRecords.length) return;
  const rep = dsRecords[0];
  const syntheticRow = {
    key: rep.model_preprocess_key || rep.run_dir,
    runDirs: [...new Set(dsRecords.map(r => r.run_dir))],
    modelName: rep.model_name,
    runDisplay: rep.run_display,
    preprocessingName: rep.preprocessing_name,
    preprocessingTrack: rep.preprocessing_track,
    preprocessingChain: rep.preprocessing_chain,
    datasets: {},
    mean_all: null,
  };
  // collect dataset means for summary
  const metric = getMetricKey("test");
  const vals = dsRecords.map(r => r[metric]).filter(v => v != null && !isNaN(v));
  syntheticRow.datasets[dataset] = { mean: mean(vals), se: stdErr(vals), n: vals.length };
  showModal(syntheticRow, filteredRecords);
}

function hideModal() {
  document.getElementById("modal-overlay").classList.add("hidden");
}

/* ============================================================
   5. CHART RENDERING
   ============================================================ */

const CHART = {
  marginTop: 20,
  marginRight: 24,
  marginBottomH: 40,     // bottom margin for horizontal labels
  marginBottomTilt: 96,  // bottom margin for tilted labels
  marginLeft: 60,
  barGroupGap: 0.28,
  barInnerGap: 2,
  height: 340,
  avgGroupExtraGap: 28,
  minGroupW: 80,  // minimum px per task group so labels have room
  labelTiltThreshold: 110, // tilt labels when groupW is below this
};

function renderCharts(filteredRecords, metadata, decodableFilters, roofline) {
  const container = document.getElementById("charts-container");
  const presentDatasets = orderDatasets(
    metadata.datasets.filter(ds => filteredRecords.some(r => r.dataset === ds))
  );

  if (!presentDatasets.length) {
    container.innerHTML = '<div class="empty-state"><p>No results match the current filters.</p></div>';
    return;
  }

  container.innerHTML = "";
  const metric = getMetricKey("test");
  const metricLabel = state.metric === "roc_auc" ? "ROC-AUC" : "Accuracy";

  presentDatasets.forEach(function(ds) {
    const dsRecords = filteredRecords.filter(r => r.dataset === ds);
    const section = buildChartSection(ds, dsRecords, filteredRecords, metadata, roofline, metric, metricLabel);
    container.appendChild(section);
  });
}

function buildChartSection(dataset, records, allFilteredRecords, metadata, roofline, metric, metricLabel) {
  const section = document.createElement("div");
  section.className = "chart-section";

  const dsLabel = ((metadata.dataset_labels || {})[dataset]) || dataset;
  const taskDisplayNames = metadata.task_display_names || {};
  const taskDisplayOrder = metadata.task_display_order || [];

  // Canonical task order
  const orderIndex = {};
  taskDisplayOrder.forEach(function(disp, i) {
    const entry = Object.entries(taskDisplayNames).find(function(e) { return e[1] === disp; });
    if (entry) orderIndex[entry[0]] = i;
  });

  const tasksInData = [...new Set(records.map(r => r.task).filter(Boolean))];
  const allTasks = tasksInData.sort(function(a, b) {
    return (orderIndex[a] != null ? orderIndex[a] : 999) - (orderIndex[b] != null ? orderIndex[b] : 999);
  });

  const activeTasks = state.tasks.length === 0 ? allTasks : allTasks.filter(t => state.tasks.includes(t));
  const showAvg = activeTasks.length > 1;

  const models = [...new Set(records.map(r => r.model_name).filter(Boolean))].sort();

  // When the same model_name appears in multiple tracks (e.g. logistic STFT + WAV),
  // create compound keys "model_name|track" so both are shown as separate bars.
  const modelNameHasMultipleTracks = {};
  records.forEach(function(r) {
    if (!r.model_name) return;
    if (!modelNameHasMultipleTracks[r.model_name]) modelNameHasMultipleTracks[r.model_name] = new Set();
    if (r.preprocessing_track) modelNameHasMultipleTracks[r.model_name].add(r.preprocessing_track);
  });
  // modelKeys: one entry per unique (model_name, track) pair that appears in records
  const modelKeysSeen = new Map(); // key -> {model_name, track}
  records.forEach(function(r) {
    if (!r.model_name) return;
    var multi = modelNameHasMultipleTracks[r.model_name] && modelNameHasMultipleTracks[r.model_name].size > 1;
    var key = multi ? (r.model_name + "|" + (r.preprocessing_track || "")) : r.model_name;
    if (!modelKeysSeen.has(key)) modelKeysSeen.set(key, { model_name: r.model_name, track: r.preprocessing_track || "STFT" });
  });
  // Sort: group by model_name, within each name STFT before WAV
  const modelEntries = [...modelKeysSeen.values()].sort(function(a, b) {
    if (a.model_name < b.model_name) return -1;
    if (a.model_name > b.model_name) return 1;
    if (a.track === "STFT" && b.track !== "STFT") return -1;
    if (a.track !== "STFT" && b.track === "STFT") return 1;
    return 0;
  });
  const modelKeys = modelEntries.map(function(e) {
    return modelNameHasMultipleTracks[e.model_name] && modelNameHasMultipleTracks[e.model_name].size > 1
      ? e.model_name + "|" + e.track
      : e.model_name;
  });

  const nModels = modelKeys.length;
  const nTasks = activeTasks.length;

  // Build stats — keyed by modelKey, filtering records by both model_name and track
  const data = {};
  modelKeys.forEach(function(mkey, ki) {
    var mname = modelEntries[ki].model_name;
    var mtrack = modelEntries[ki].track;
    var multi = modelNameHasMultipleTracks[mname] && modelNameHasMultipleTracks[mname].size > 1;
    data[mkey] = {};
    activeTasks.forEach(function(task) {
      const vals = records
        .filter(r => r.model_name === mname && r.task === task && (!multi || r.preprocessing_track === mtrack))
        .map(r => r[metric])
        .filter(v => v != null && !isNaN(v));
      data[mkey][task] = { mean: mean(vals), se: stdErr(vals), n: vals.length };
    });
    if (showAvg) {
      const allVals = activeTasks.flatMap(function(t) {
        return records
          .filter(function(r) { return r.model_name === mname && r.task === t && (!multi || r.preprocessing_track === mtrack); })
          .map(function(r) { return r[metric]; })
          .filter(function(v) { return v != null && !isNaN(v); });
      });
      data[mkey]["__avg__"] = { mean: mean(allVals), se: stdErr(allVals), n: allVals.length };
    }
  });

  // Chart dimensions — tasks SVG only (no avg slot; avg gets its own fixed panel).
  // Avg panel is computed first: Y-axis lives there, so it needs CHART.marginLeft space.
  const avgPanelW = showAvg ? Math.max(nModels * 22 + 28, CHART.minGroupW) + CHART.marginLeft : 0;
  // Tasks SVG has no Y-axis when avg panel is present — Y-axis is fixed inside avg panel.
  const tasksMarginLeft = showAvg ? 0 : CHART.marginLeft;

  const containerEl = document.getElementById("charts-container");
  const availWidth = containerEl ? Math.max(containerEl.clientWidth - 48 - avgPanelW, 700) : 800;
  const minPerGroup = Math.max(nModels * 22 + 28, CHART.minGroupW);
  const minByFormula = nTasks * minPerGroup + tasksMarginLeft + CHART.marginRight;
  const chartWidth = Math.max(availWidth, minByFormula);

  const innerW = chartWidth - tasksMarginLeft - CHART.marginRight;
  const avgInnerW = avgPanelW - CHART.marginLeft;  // no right margin — panel ends flush with tasks SVG

  const yMin = state.metric === "roc_auc" ? 0.4 : 0.3;
  const yMax = 1.0;

  // innerH is declared below, after tiltLabels is known.
  function yScale(v) {
    return innerH - ((v - yMin) / (yMax - yMin)) * innerH;
  }

  // Tasks SVG: divide innerW by nTasks only (avg is separate).
  const groupW = innerW / Math.max(nTasks, 1);
  const avgGroupW = avgInnerW;  // the whole avg inner area is one group
  const barW = Math.max(8, Math.min(28, (groupW * (1 - CHART.barGroupGap)) / Math.max(nModels, 1) - CHART.barInnerGap));
  const avgBarW = Math.max(8, Math.min(28, (avgGroupW * (1 - CHART.barGroupGap)) / Math.max(nModels, 1) - CHART.barInnerGap));
  const totalBarBlockW = nModels * barW + (nModels - 1) * CHART.barInnerGap;
  const totalAvgBarBlockW = nModels * avgBarW + (nModels - 1) * CHART.barInnerGap;

  // Tilt task labels when groupW is narrow; avg label is always horizontal (one group).
  const tiltLabels = groupW < CHART.labelTiltThreshold;
  const innerH = CHART.height - CHART.marginTop - (tiltLabels ? CHART.marginBottomTilt : CHART.marginBottomH);

  function barX(groupIdx, modelIdx) {
    var groupLeft = groupIdx * groupW;
    var baseX = groupLeft + (groupW - totalBarBlockW) / 2;
    return baseX + modelIdx * (barW + CHART.barInnerGap);
  }

  function avgBarX(modelIdx) {
    var baseX = (avgGroupW - totalAvgBarBlockW) / 2;
    return baseX + modelIdx * (avgBarW + CHART.barInnerGap);
  }

  const dsRoofline = (roofline || {})[dataset] || {};

  // Determine track per modelKey
  const modelTrackMap = {};
  modelKeys.forEach(function(mkey, ki) {
    modelTrackMap[mkey] = modelEntries[ki].track;
  });

  // Build SVG hatch pattern defs for WAV-track models (one pattern per model color)
  function hatchDefs(svgId) {
    var defs = '<defs>';
    modelKeys.forEach(function(mkey) {
      if (modelTrackMap[mkey] === "WAV") {
        var color = modelColorMap[modelEntries[modelKeys.indexOf(mkey)].model_name] || PALETTE[0];
        var pid = 'hatch-' + svgId + '-' + mkey.replace(/[^a-zA-Z0-9]/g, '_');
        defs += '<pattern id="' + pid + '" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">';
        defs += '<rect width="6" height="6" fill="' + color + '" opacity="0.85"/>';
        defs += '<line x1="0" y1="0" x2="0" y2="6" stroke="rgba(255,255,255,0.55)" stroke-width="2.5"/>';
        defs += '</pattern>';
      }
    });
    defs += '</defs>';
    return defs;
  }

  function barFill(mkey, svgId) {
    var ki = modelKeys.indexOf(mkey);
    var color = modelColorMap[modelEntries[ki].model_name] || PALETTE[0];
    if (modelTrackMap[mkey] === "WAV") {
      var pid = 'hatch-' + svgId + '-' + mkey.replace(/[^a-zA-Z0-9]/g, '_');
      return 'url(#' + pid + ')';
    }
    return color;
  }

  let svgParts = [];
  // Tasks SVG — scrollable, no avg group.
  svgParts.push('<svg xmlns="http://www.w3.org/2000/svg" width="' + chartWidth + '" height="' + CHART.height + '" style="display:block;width:' + chartWidth + 'px;height:' + CHART.height + 'px">');
  svgParts.push(hatchDefs('tasks-' + dataset.replace(/[^a-zA-Z0-9]/g, '_')));
  svgParts.push('<g transform="translate(' + tasksMarginLeft + ',' + CHART.marginTop + ')">');

  // Grid
  const gridValues = [];
  for (var gv = yMin; gv <= yMax + 1e-9; gv = Math.round((gv + 0.1) * 10) / 10) gridValues.push(gv);
  gridValues.forEach(function(gval) {
    var gy = yScale(gval);
    svgParts.push('<line x1="0" y1="' + gy + '" x2="' + innerW + '" y2="' + gy + '" class="chart-grid" stroke-width="0.75"/>');
  });

  // Chance line
  if (yMin <= 0.5) {
    var cy = yScale(0.5);
    svgParts.push('<line x1="0" y1="' + cy + '" x2="' + innerW + '" y2="' + cy + '" class="chart-chance" stroke-width="1.5" stroke-dasharray="3,4"/>');
  }

  // Bars
  activeTasks.forEach(function(task, ti) {
    // Roofline (conditional)
    if (SHOW_ROOFLINE && state.metric === "roc_auc") {
      var roofVal = dsRoofline[task] ? dsRoofline[task].mean_test_roc_auc : null;
      if (roofVal != null && !isNaN(roofVal)) {
        var ry = yScale(Math.min(Math.max(roofVal, yMin), yMax));
        var rx0 = barX(ti, 0, false);
        var rx1 = barX(ti, nModels - 1, false) + barW;
        svgParts.push('<line x1="' + rx0 + '" y1="' + ry + '" x2="' + rx1 + '" y2="' + ry + '" class="chart-roofline" stroke-width="1.5" stroke-dasharray="4,3"/>');
      }
    }

    modelKeys.forEach(function(mkey, mi) {
      var d = data[mkey][task];
      if (!d || d.mean == null) return;
      var fill = barFill(mkey, 'tasks-' + dataset.replace(/[^a-zA-Z0-9]/g, '_'));
      var x = barX(ti, mi);
      var barH = Math.max(0, innerH - yScale(Math.max(d.mean, yMin)));
      var y = yScale(Math.max(d.mean, yMin));
      var mname = modelEntries[mi].model_name;
      svgParts.push('<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + barW + '" height="' + barH.toFixed(1) + '" fill="' + fill + '" opacity="1" rx="1" data-model="' + escSvg(mname) + '" data-dataset="' + escSvg(dataset) + '" data-task="' + escSvg(task) + '" data-task-display="' + escSvg(taskDisplayNames[task] || task) + '" data-mean="' + d.mean.toFixed(4) + '" data-se="' + (d.se || 0).toFixed(4) + '" data-n="' + d.n + '" style="cursor:pointer"/>');
      svgParts.push(seBars(d, x, barW, yScale, yMin, yMax));
    });
  });

  // X axis line
  svgParts.push('<line x1="0" y1="' + innerH + '" x2="' + innerW + '" y2="' + innerH + '" class="chart-axis" stroke-width="1"/>');

  // Task x-axis labels — centered when there is room, tilted when narrow.
  activeTasks.forEach(function(task, ti) {
    var disp = taskDisplayNames[task] || task;
    var cx = (ti * groupW + groupW / 2).toFixed(1);
    if (tiltLabels) {
      svgParts.push('<text transform="translate(' + cx + ',' + (innerH + 12) + ') rotate(40)" font-size="13" class="chart-tick" text-anchor="start" font-family="-apple-system,sans-serif">' + escSvg(disp) + '</text>');
    } else {
      svgParts.push('<text x="' + cx + '" y="' + (innerH + 20) + '" font-size="13" class="chart-tick" text-anchor="middle" font-family="-apple-system,sans-serif">' + escSvg(disp) + '</text>');
    }
  });

  // Y axis labels — only when avg panel absent (avg panel hosts the Y axis otherwise)
  if (!showAvg) {
    gridValues.forEach(function(gval) {
      var gy = yScale(gval);
      svgParts.push('<text x="-8" y="' + (gy + 4) + '" font-size="12" class="chart-tick-y" text-anchor="end" font-family="-apple-system,sans-serif">' + gval.toFixed(1) + '</text>');
    });
    svgParts.push('<text transform="rotate(-90)" x="' + (-innerH / 2) + '" y="-46" font-size="13" class="chart-tick-y" text-anchor="middle" font-family="-apple-system,sans-serif">' + escSvg(metricLabel) + '</text>');
  }

  svgParts.push("</g></svg>");

  // ---- Avg panel SVG (fixed, not scrolled) ----
  var avgSvgParts = [];
  if (showAvg) {
    avgSvgParts.push('<svg xmlns="http://www.w3.org/2000/svg" width="' + avgPanelW + '" height="' + CHART.height + '" style="display:block;width:' + avgPanelW + 'px;height:' + CHART.height + 'px">');
    avgSvgParts.push(hatchDefs('avg-' + dataset.replace(/[^a-zA-Z0-9]/g, '_')));
    avgSvgParts.push('<g transform="translate(' + CHART.marginLeft + ',' + CHART.marginTop + ')">');

    // Background shading
    avgSvgParts.push('<rect x="0" y="0" width="' + avgInnerW + '" height="' + innerH + '" class="chart-avg-bg" rx="3"/>');

    // Grid lines + Y axis labels (Y axis lives here, fixed)
    gridValues.forEach(function(gval) {
      var gy = yScale(gval);
      avgSvgParts.push('<line x1="0" y1="' + gy + '" x2="' + avgInnerW + '" y2="' + gy + '" class="chart-avg-grid" stroke-width="0.75"/>');
      avgSvgParts.push('<text x="-8" y="' + (gy + 4) + '" font-size="12" class="chart-tick-y" text-anchor="end" font-family="-apple-system,sans-serif">' + gval.toFixed(1) + '</text>');
    });
    // Metric axis title (rotated)
    avgSvgParts.push('<text transform="rotate(-90)" x="' + (-innerH / 2) + '" y="-46" font-size="13" class="chart-tick-y" text-anchor="middle" font-family="-apple-system,sans-serif">' + escSvg(metricLabel) + '</text>');

    // Chance line
    if (yMin <= 0.5) {
      var avgCy = yScale(0.5);
      avgSvgParts.push('<line x1="0" y1="' + avgCy + '" x2="' + avgInnerW + '" y2="' + avgCy + '" class="chart-chance" stroke-width="1.5" stroke-dasharray="3,4"/>');
    }

    // Avg bars
    modelKeys.forEach(function(mkey, mi) {
      var d = data[mkey]["__avg__"];
      if (!d || d.mean == null) return;
      var fill = barFill(mkey, 'avg-' + dataset.replace(/[^a-zA-Z0-9]/g, '_'));
      var x = avgBarX(mi);
      var barH = Math.max(0, innerH - yScale(Math.max(d.mean, yMin)));
      var y = yScale(Math.max(d.mean, yMin));
      var mname = modelEntries[mi].model_name;
      avgSvgParts.push('<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + avgBarW + '" height="' + barH.toFixed(1) + '" fill="' + fill + '" opacity="1" rx="1" data-model="' + escSvg(mname) + '" data-dataset="' + escSvg(dataset) + '" data-task="__avg__" data-task-display="Average (this dataset)" data-mean="' + d.mean.toFixed(4) + '" data-se="' + (d.se || 0).toFixed(4) + '" data-n="' + d.n + '" style="cursor:pointer"/>');
      avgSvgParts.push(seBars(d, x, avgBarW, yScale, yMin, yMax));
    });

    // X axis line
    avgSvgParts.push('<line x1="0" y1="' + innerH + '" x2="' + avgInnerW + '" y2="' + innerH + '" class="chart-axis" stroke-width="1"/>');

    // "Average" label
    var lx = (avgInnerW / 2).toFixed(1);
    avgSvgParts.push('<text x="' + lx + '" y="' + (innerH + 20) + '" font-size="13" class="chart-label" font-weight="600" text-anchor="middle" font-family="-apple-system,sans-serif">Average</text>');

    // Divider line (right edge)
    avgSvgParts.push('<line x1="' + avgInnerW + '" y1="-' + CHART.marginTop + '" x2="' + avgInnerW + '" y2="' + innerH + '" class="chart-divider" stroke-width="1.5" stroke-dasharray="4,3"/>');

    avgSvgParts.push("</g></svg>");
  }

  // Legend
  var legendItems = modelKeys.map(function(mkey, ki) {
    var mname = modelEntries[ki].model_name;
    var color = modelColorMap[mname] || PALETTE[0];
    var isWav = modelTrackMap[mkey] === "WAV";
    var swatchStyle = isWav
      ? 'background:repeating-linear-gradient(45deg,' + color + ' 0,' + color + ' 3px,rgba(255,255,255,0.55) 3px,rgba(255,255,255,0.55) 5px)'
      : 'background:' + color;
    var trackBadge = trackBadgeHtml(modelTrackMap[mkey]);
    var lcovNote = getModelInfo(mname).coverage_note;
    var lcovIcon = lcovNote ? '<span class="coverage-warn">*</span>' : '';
    return '<div class="legend-item legend-clickable" data-model="' + escHtml(mname) + '" data-dataset="' + escHtml(dataset) + '" title="Click for details" style="cursor:pointer"><div class="legend-swatch" style="' + swatchStyle + '"></div><span>' + escHtml(getModelDisplay(mname)) + lcovIcon + '</span>' + trackBadge + '</div>';
  }).join("");

  var hasRooflineData = SHOW_ROOFLINE && state.metric === "roc_auc" && activeTasks.some(function(t) {
    return dsRoofline[t] && dsRoofline[t].mean_test_roc_auc != null;
  });
  var rooflineLegend = hasRooflineData
    ? '<div class="legend-item"><div class="legend-roofline"></div><span>STFT roofline</span></div>'
    : "";
  var chanceLegend = '<div class="legend-item"><div class="legend-chance"></div><span>Chance (0.5)</span></div>';

  section.innerHTML =
    '<div class="chart-section-title">' + escHtml(dsLabel) + '</div>' +
    '<div class="chart-section-subtitle">Mean test ' + metricLabel + ' per task \u00b7 bars = mean across folds/subject-sessions \u00b7 error bars = Standard Error \u00b7 click bar or legend for details</div>' +
    '<div class="chart-body">' +
      (showAvg ? '<div class="chart-avg-panel" data-dataset="' + escHtml(dataset) + '">' + avgSvgParts.join("") + '</div>' : '') +
      '<div class="chart-scroll" data-dataset="' + escHtml(dataset) + '">' + svgParts.join("") + '</div>' +
    '</div>' +
    '<div class="chart-legend">' + legendItems + rooflineLegend + chanceLegend + '</div>' +
    (function() {
      var fnotes = modelKeys.map(function(mkey, ki) {
        var mname = modelEntries[ki].model_name;
        var n = getModelInfo(mname).coverage_note;
        return n ? '<p class="coverage-footnote"><span class="coverage-warn">*</span> <strong>' + escHtml(getModelDisplay(mname)) + ':</strong> ' + escHtml(n) + '</p>' : '';
      }).join("");
      return fnotes;
    })();

  return section;
}

function renderSubjectCharts(filteredRecords, metadata) {
  const container = document.getElementById("subject-charts-container");
  if (!container) return;
  const metric = getMetricKey("test");
  const metricLabel = state.metric === "roc_auc" ? "ROC-AUC" : "Accuracy";
  const presentDatasets = orderDatasets(
    metadata.datasets.filter(ds => filteredRecords.some(r => r.dataset === ds))
  );
  if (!presentDatasets.length) {
    container.innerHTML = '<div class="empty-state"><p>No results match the current filters.</p></div>';
    return;
  }
  container.innerHTML = "";
  presentDatasets.forEach(function(ds) {
    const dsRecords = filteredRecords.filter(r => r.dataset === ds);
    const section = buildSubjectChartSection(ds, dsRecords, metadata, metric, metricLabel);
    container.appendChild(section);
  });
}

function buildSubjectChartSection(dataset, records, metadata, metric, metricLabel) {
  const section = document.createElement("div");
  section.className = "chart-section";
  const dsLabel = ((metadata.dataset_labels || {})[dataset]) || dataset;

  // Group by subject_id (combines all sessions for the same subject)
  const subjectIds = [...new Set(records.map(r => r.subject_id).filter(v => v != null))].sort(function(a, b) { return a - b; });
  const subjects = subjectIds; // numeric ids; display as "Subject X"
  function subjectLabel(id) { return "Subject " + id; }
  const showAvg = subjects.length > 1;

  const modelNameHasMultipleTracks = {};
  records.forEach(function(r) {
    if (!r.model_name) return;
    if (!modelNameHasMultipleTracks[r.model_name]) modelNameHasMultipleTracks[r.model_name] = new Set();
    if (r.preprocessing_track) modelNameHasMultipleTracks[r.model_name].add(r.preprocessing_track);
  });
  const modelKeysSeen = new Map();
  records.forEach(function(r) {
    if (!r.model_name) return;
    var multi = modelNameHasMultipleTracks[r.model_name] && modelNameHasMultipleTracks[r.model_name].size > 1;
    var key = multi ? (r.model_name + "|" + (r.preprocessing_track || "")) : r.model_name;
    if (!modelKeysSeen.has(key)) modelKeysSeen.set(key, { model_name: r.model_name, track: r.preprocessing_track || "STFT" });
  });
  const modelEntries = [...modelKeysSeen.values()].sort(function(a, b) {
    if (a.model_name < b.model_name) return -1;
    if (a.model_name > b.model_name) return 1;
    if (a.track === "STFT" && b.track !== "STFT") return -1;
    if (a.track !== "STFT" && b.track === "STFT") return 1;
    return 0;
  });
  const modelKeys = modelEntries.map(function(e) {
    return modelNameHasMultipleTracks[e.model_name] && modelNameHasMultipleTracks[e.model_name].size > 1
      ? e.model_name + "|" + e.track : e.model_name;
  });

  const nModels = modelKeys.length;
  const nGroups = subjects.length;

  const data = {};
  modelKeys.forEach(function(mkey, ki) {
    var mname = modelEntries[ki].model_name;
    var mtrack = modelEntries[ki].track;
    var multi = modelNameHasMultipleTracks[mname] && modelNameHasMultipleTracks[mname].size > 1;
    data[mkey] = {};
    subjects.forEach(function(sid) {
      const vals = records
        .filter(r => r.model_name === mname && r.subject_id === sid && (!multi || r.preprocessing_track === mtrack))
        .map(r => r[metric])
        .filter(v => v != null && !isNaN(v));
      data[mkey][sid] = { mean: mean(vals), se: stdErr(vals), n: vals.length };
    });
    if (showAvg) {
      const allVals = subjects.flatMap(function(sid) {
        return records
          .filter(function(r) { return r.model_name === mname && r.subject_id === sid && (!multi || r.preprocessing_track === mtrack); })
          .map(function(r) { return r[metric]; })
          .filter(function(v) { return v != null && !isNaN(v); });
      });
      data[mkey]["__avg__"] = { mean: mean(allVals), se: stdErr(allVals), n: allVals.length };
    }
  });

  const avgPanelW = showAvg ? Math.max(nModels * 22 + 28, CHART.minGroupW) + CHART.marginLeft : 0;
  const tasksMarginLeft = showAvg ? 0 : CHART.marginLeft;
  const containerEl = document.getElementById("subject-charts-container");
  const availWidth = containerEl ? Math.max(containerEl.clientWidth - 48 - avgPanelW, 700) : 800;
  const minPerGroup = Math.max(nModels * 22 + 28, CHART.minGroupW);
  const chartWidth = Math.max(availWidth, nGroups * minPerGroup + tasksMarginLeft + CHART.marginRight);
  const innerW = chartWidth - tasksMarginLeft - CHART.marginRight;
  const avgInnerW = avgPanelW - CHART.marginLeft;

  const yMin = state.metric === "roc_auc" ? 0.4 : 0.3;
  const yMax = 1.0;
  function yScale(v) { return innerH - ((v - yMin) / (yMax - yMin)) * innerH; }

  const groupW = innerW / Math.max(nGroups, 1);
  const avgGroupW = avgInnerW;
  const barW = Math.max(8, Math.min(28, (groupW * (1 - CHART.barGroupGap)) / Math.max(nModels, 1) - CHART.barInnerGap));
  const avgBarW = Math.max(8, Math.min(28, (avgGroupW * (1 - CHART.barGroupGap)) / Math.max(nModels, 1) - CHART.barInnerGap));
  const totalBarBlockW = nModels * barW + (nModels - 1) * CHART.barInnerGap;
  const totalAvgBarBlockW = nModels * avgBarW + (nModels - 1) * CHART.barInnerGap;
  const tiltLabels = groupW < CHART.labelTiltThreshold;
  const innerH = CHART.height - CHART.marginTop - (tiltLabels ? CHART.marginBottomTilt : CHART.marginBottomH);

  function barX(gi, mi) {
    return gi * groupW + (groupW - totalBarBlockW) / 2 + mi * (barW + CHART.barInnerGap);
  }
  function avgBarX(mi) {
    return (avgGroupW - totalAvgBarBlockW) / 2 + mi * (avgBarW + CHART.barInnerGap);
  }

  const modelTrackMap = {};
  modelKeys.forEach(function(mkey, ki) { modelTrackMap[mkey] = modelEntries[ki].track; });

  function hatchDefs(svgId) {
    var defs = '<defs>';
    modelKeys.forEach(function(mkey) {
      if (modelTrackMap[mkey] === "WAV") {
        var color = modelColorMap[modelEntries[modelKeys.indexOf(mkey)].model_name] || PALETTE[0];
        var pid = 'hatch-' + svgId + '-' + mkey.replace(/[^a-zA-Z0-9]/g, '_');
        defs += '<pattern id="' + pid + '" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">';
        defs += '<rect width="6" height="6" fill="' + color + '" opacity="0.85"/>';
        defs += '<line x1="0" y1="0" x2="0" y2="6" stroke="rgba(255,255,255,0.55)" stroke-width="2.5"/>';
        defs += '</pattern>';
      }
    });
    defs += '</defs>';
    return defs;
  }
  function barFill(mkey, svgId) {
    var ki = modelKeys.indexOf(mkey);
    var color = modelColorMap[modelEntries[ki].model_name] || PALETTE[0];
    if (modelTrackMap[mkey] === "WAV") return 'url(#hatch-' + svgId + '-' + mkey.replace(/[^a-zA-Z0-9]/g, '_') + ')';
    return color;
  }

  const svgId = 'subj-' + dataset.replace(/[^a-zA-Z0-9]/g, '_');
  let svgParts = [];
  svgParts.push('<svg xmlns="http://www.w3.org/2000/svg" width="' + chartWidth + '" height="' + CHART.height + '" style="display:block;width:' + chartWidth + 'px;height:' + CHART.height + 'px">');
  svgParts.push(hatchDefs(svgId));
  svgParts.push('<g transform="translate(' + tasksMarginLeft + ',' + CHART.marginTop + ')">');

  const gridValues = [];
  for (var gv = yMin; gv <= yMax + 1e-9; gv = Math.round((gv + 0.1) * 10) / 10) gridValues.push(gv);
  gridValues.forEach(function(gval) {
    var gy = yScale(gval);
    svgParts.push('<line x1="0" y1="' + gy + '" x2="' + innerW + '" y2="' + gy + '" class="chart-grid" stroke-width="0.75"/>');
  });
  if (yMin <= 0.5) {
    var cy = yScale(0.5);
    svgParts.push('<line x1="0" y1="' + cy + '" x2="' + innerW + '" y2="' + cy + '" class="chart-chance" stroke-width="1.5" stroke-dasharray="3,4"/>');
  }

  subjects.forEach(function(sid, si) {
    modelKeys.forEach(function(mkey, mi) {
      var d = data[mkey][sid];
      if (!d || d.mean == null) return;
      var fill = barFill(mkey, svgId);
      var x = barX(si, mi);
      var barH = Math.max(0, innerH - yScale(Math.max(d.mean, yMin)));
      var y = yScale(Math.max(d.mean, yMin));
      var mname = modelEntries[mi].model_name;
      var ssDisp = subjectLabel(sid);
      svgParts.push('<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + barW + '" height="' + barH.toFixed(1) + '" fill="' + fill + '" opacity="1" rx="1" data-model="' + escSvg(mname) + '" data-dataset="' + escSvg(dataset) + '" data-task="' + escSvg(String(sid)) + '" data-task-display="' + escSvg(ssDisp) + '" data-mean="' + d.mean.toFixed(4) + '" data-se="' + (d.se || 0).toFixed(4) + '" data-n="' + d.n + '" style="cursor:pointer"/>');
      svgParts.push(seBars(d, x, barW, yScale, yMin, yMax));
    });
  });

  svgParts.push('<line x1="0" y1="' + innerH + '" x2="' + innerW + '" y2="' + innerH + '" class="chart-axis" stroke-width="1"/>');
  subjects.forEach(function(sid, si) {
    var disp = subjectLabel(sid);
    var cx = (si * groupW + groupW / 2).toFixed(1);
    if (tiltLabels) {
      svgParts.push('<text transform="translate(' + cx + ',' + (innerH + 12) + ') rotate(40)" font-size="13" class="chart-tick" text-anchor="start" font-family="-apple-system,sans-serif">' + escSvg(disp) + '</text>');
    } else {
      svgParts.push('<text x="' + cx + '" y="' + (innerH + 20) + '" font-size="13" class="chart-tick" text-anchor="middle" font-family="-apple-system,sans-serif">' + escSvg(disp) + '</text>');
    }
  });
  if (!showAvg) {
    gridValues.forEach(function(gval) {
      var gy = yScale(gval);
      svgParts.push('<text x="-8" y="' + (gy + 4) + '" font-size="12" class="chart-tick-y" text-anchor="end" font-family="-apple-system,sans-serif">' + gval.toFixed(1) + '</text>');
    });
    svgParts.push('<text transform="rotate(-90)" x="' + (-innerH / 2) + '" y="-46" font-size="13" class="chart-tick-y" text-anchor="middle" font-family="-apple-system,sans-serif">' + escSvg(metricLabel) + '</text>');
  }
  svgParts.push("</g></svg>");

  var avgSvgParts = [];
  if (showAvg) {
    const avgSvgId = 'subjAvg-' + dataset.replace(/[^a-zA-Z0-9]/g, '_');
    avgSvgParts.push('<svg xmlns="http://www.w3.org/2000/svg" width="' + avgPanelW + '" height="' + CHART.height + '" style="display:block;width:' + avgPanelW + 'px;height:' + CHART.height + 'px">');
    avgSvgParts.push(hatchDefs(avgSvgId));
    avgSvgParts.push('<g transform="translate(' + CHART.marginLeft + ',' + CHART.marginTop + ')">');
    avgSvgParts.push('<rect x="0" y="0" width="' + avgInnerW + '" height="' + innerH + '" class="chart-avg-bg" rx="3"/>');
    gridValues.forEach(function(gval) {
      var gy = yScale(gval);
      avgSvgParts.push('<line x1="0" y1="' + gy + '" x2="' + avgInnerW + '" y2="' + gy + '" class="chart-avg-grid" stroke-width="0.75"/>');
      avgSvgParts.push('<text x="-8" y="' + (gy + 4) + '" font-size="12" class="chart-tick-y" text-anchor="end" font-family="-apple-system,sans-serif">' + gval.toFixed(1) + '</text>');
    });
    avgSvgParts.push('<text transform="rotate(-90)" x="' + (-innerH / 2) + '" y="-46" font-size="13" class="chart-tick-y" text-anchor="middle" font-family="-apple-system,sans-serif">' + escSvg(metricLabel) + '</text>');
    if (yMin <= 0.5) {
      var avgCy = yScale(0.5);
      avgSvgParts.push('<line x1="0" y1="' + avgCy + '" x2="' + avgInnerW + '" y2="' + avgCy + '" class="chart-chance" stroke-width="1.5" stroke-dasharray="3,4"/>');
    }
    modelKeys.forEach(function(mkey, mi) {
      var d = data[mkey]["__avg__"];
      if (!d || d.mean == null) return;
      var fill = barFill(mkey, avgSvgId);
      var x = avgBarX(mi);
      var barH = Math.max(0, innerH - yScale(Math.max(d.mean, yMin)));
      var y = yScale(Math.max(d.mean, yMin));
      var mname = modelEntries[mi].model_name;
      avgSvgParts.push('<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + avgBarW + '" height="' + barH.toFixed(1) + '" fill="' + fill + '" opacity="1" rx="1" data-model="' + escSvg(mname) + '" data-dataset="' + escSvg(dataset) + '" data-task="__avg__" data-task-display="Average (all subjects)" data-mean="' + d.mean.toFixed(4) + '" data-se="' + (d.se || 0).toFixed(4) + '" data-n="' + d.n + '" style="cursor:pointer"/>');
      avgSvgParts.push(seBars(d, x, avgBarW, yScale, yMin, yMax));
    });
    avgSvgParts.push('<line x1="0" y1="' + innerH + '" x2="' + avgInnerW + '" y2="' + innerH + '" class="chart-axis" stroke-width="1"/>');
    var lx = (avgInnerW / 2).toFixed(1);
    avgSvgParts.push('<text x="' + lx + '" y="' + (innerH + 20) + '" font-size="13" class="chart-label" font-weight="600" text-anchor="middle" font-family="-apple-system,sans-serif">Average</text>');
    avgSvgParts.push('<line x1="' + avgInnerW + '" y1="-' + CHART.marginTop + '" x2="' + avgInnerW + '" y2="' + innerH + '" class="chart-divider" stroke-width="1.5" stroke-dasharray="4,3"/>');
    avgSvgParts.push("</g></svg>");
  }

  var legendItems = modelKeys.map(function(mkey, ki) {
    var mname = modelEntries[ki].model_name;
    var color = modelColorMap[mname] || PALETTE[0];
    var isWav = modelTrackMap[mkey] === "WAV";
    var swatchStyle = isWav
      ? 'background:repeating-linear-gradient(45deg,' + color + ' 0,' + color + ' 3px,rgba(255,255,255,0.55) 3px,rgba(255,255,255,0.55) 5px)'
      : 'background:' + color;
    var trackBadge = trackBadgeHtml(modelTrackMap[mkey]);
    var lcovNote = getModelInfo(mname).coverage_note;
    var lcovIcon = lcovNote ? '<span class="coverage-warn">*</span>' : '';
    return '<div class="legend-item legend-clickable" data-model="' + escHtml(mname) + '" data-dataset="' + escHtml(dataset) + '" title="Click for details" style="cursor:pointer"><div class="legend-swatch" style="' + swatchStyle + '"></div><span>' + escHtml(getModelDisplay(mname)) + lcovIcon + '</span>' + trackBadge + '</div>';
  }).join("");

  var chanceLegend = '<div class="legend-item"><div class="legend-chance"></div><span>Chance (0.5)</span></div>';

  section.innerHTML =
    '<div class="chart-section-title">' + escHtml(dsLabel) + '</div>' +
    '<div class="chart-section-subtitle">Mean test ' + metricLabel + ' per subject \u00b7 bars = mean across tasks and folds \u00b7 error bars = Standard Error \u00b7 click bar or legend for details</div>' +
    '<div class="chart-body">' +
      (showAvg ? '<div class="chart-avg-panel" data-dataset="' + escHtml(dataset) + '">' + avgSvgParts.join("") + '</div>' : '') +
      '<div class="chart-scroll" data-dataset="' + escHtml(dataset) + '">' + svgParts.join("") + '</div>' +
    '</div>' +
    '<div class="chart-legend">' + legendItems + chanceLegend + '</div>' +
    (function() {
      var fnotes = modelKeys.map(function(mkey, ki) {
        var mname = modelEntries[ki].model_name;
        var n = getModelInfo(mname).coverage_note;
        return n ? '<p class="coverage-footnote"><span class="coverage-warn">*</span> <strong>' + escHtml(getModelDisplay(mname)) + ':</strong> ' + escHtml(n) + '</p>' : '';
      }).join("");
      return fnotes;
    })();

  return section;
}

function seBars(d, x, barW, yScale, yMin, yMax) {
  if (!d || d.se <= 0 || d.n < 2) return "";
  var seLo = yScale(Math.min(d.mean + d.se, yMax));
  var seHi = yScale(Math.max(d.mean - d.se, yMin));
  var cx = (x + barW / 2).toFixed(1);
  var xLo = (x + barW / 2 - 2.5).toFixed(1);
  var xHi = (x + barW / 2 + 2.5).toFixed(1);
  return '<line x1="' + cx + '" y1="' + seLo.toFixed(1) + '" x2="' + cx + '" y2="' + seHi.toFixed(1) + '" class="chart-se" stroke-width="1.5"/>' +
    '<line x1="' + xLo + '" y1="' + seLo.toFixed(1) + '" x2="' + xHi + '" y2="' + seLo.toFixed(1) + '" class="chart-se" stroke-width="1.5"/>' +
    '<line x1="' + xLo + '" y1="' + seHi.toFixed(1) + '" x2="' + xHi + '" y2="' + seHi.toFixed(1) + '" class="chart-se" stroke-width="1.5"/>';
}

function wireChartClicks(filteredRecords) {
  // Floating tooltip
  var tt = document.getElementById("chart-tooltip");
  if (!tt) {
    tt = document.createElement("div");
    tt.id = "chart-tooltip";
    tt.className = "chart-tooltip";
    document.body.appendChild(tt);
  }

  document.querySelectorAll(".chart-scroll, .chart-avg-panel").forEach(function(scrollEl) {
    var dataset = scrollEl.dataset.dataset;
    scrollEl.addEventListener("click", function(e) {
      var bar = e.target.closest ? e.target.closest("rect[data-model]") : null;
      if (!bar && e.target.tagName === "rect" && e.target.dataset.model) bar = e.target;
      if (bar) {
        showModelChartModal(bar.dataset.model, bar.dataset.dataset || dataset, filteredRecords);
      }
    });
    scrollEl.addEventListener("mouseover", function(e) {
      var bar = e.target.closest ? e.target.closest("rect[data-mean]") : null;
      if (!bar && e.target.tagName === "rect" && e.target.dataset.mean != null) bar = e.target;
      if (bar) {
        var modelDisp = getModelDisplay(bar.dataset.model);
        var taskDisp = bar.dataset.taskDisplay || bar.dataset.task || "";
        var meanVal = parseFloat(bar.dataset.mean);
        var seVal = parseFloat(bar.dataset.se);
        var nVal = bar.dataset.n;
        var covNote = getModelInfo(bar.dataset.model).coverage_note;
        var covLine = covNote ? "<div style='margin-top:5px;padding-top:5px;border-top:1px solid rgba(255,255,255,0.2);font-size:11px;opacity:0.85;white-space:normal;max-width:220px;line-height:1.4'>* " + escHtml(covNote) + "</div>" : "";
        tt.innerHTML = "<strong>" + escHtml(modelDisp) + "</strong><br>" +
          escHtml(taskDisp) + "<br>" +
          meanVal.toFixed(3) + (seVal > 0 ? " &plusmn;&thinsp;" + seVal.toFixed(3) : "") +
          " <span style='opacity:.7'>(n=" + nVal + ")</span>" + covLine;
        tt.style.display = "block";
      } else {
        tt.style.display = "none";
      }
    });
    scrollEl.addEventListener("mousemove", function(e) {
      if (tt.style.display !== "none") {
        tt.style.left = (e.clientX + 14) + "px";
        tt.style.top = (e.clientY - 52) + "px";
      }
    });
    scrollEl.addEventListener("mouseleave", function() {
      tt.style.display = "none";
    });
  });

  document.querySelectorAll(".legend-clickable").forEach(function(item) {
    item.addEventListener("click", function() {
      showModelChartModal(item.dataset.model, item.dataset.dataset, filteredRecords);
    });
  });
}

/* ============================================================
   6. SUMMARY CARDS
   ============================================================ */

function updateSummaryCards(filteredRecords) {
  var models = new Set(filteredRecords.map(r => r.model_name).filter(Boolean));
  var runs = new Set(filteredRecords.map(r => r.model_preprocess_key || r.run_dir).filter(Boolean));
  var tasks = new Set(filteredRecords.map(r => r.task).filter(Boolean));
  var subjects = new Set(filteredRecords.map(r => r.subject_session).filter(Boolean));

  var el;
  el = document.getElementById("summary-models"); if (el) el.textContent = models.size;
  el = document.getElementById("summary-runs"); if (el) el.textContent = runs.size;
  el = document.getElementById("summary-tasks"); if (el) el.textContent = tasks.size;
  el = document.getElementById("summary-subjects"); if (el) el.textContent = subjects.size;
}

/* ============================================================
   7. MULTI-SELECT DROPDOWNS
   ============================================================ */

function buildModelMultiSelect() {
  var btn    = document.getElementById("model-ms-btn");
  var panel  = document.getElementById("model-ms-panel");
  var list   = document.getElementById("model-ms-list");
  var allBox = document.getElementById("ms-all-models");
  if (!btn || !panel || !list || !allBox) return;

  function getAvailableModelKeys() {
    var ld = getData();
    if (!ld) return [];
    // Filter records by current track only (not model filter itself)
    var trackRecords = ld.records.filter(function(r) {
      return state.track === "all" || r.preprocessing_track === state.track;
    });
    var fromTrack = [...new Set(trackRecords.map(function(r) { return r.model_name; }).filter(Boolean))];
    var knownOrder = Object.keys(modelInfo);
    var ordered = knownOrder.filter(function(k) { return fromTrack.includes(k); });
    fromTrack.forEach(function(k) { if (!ordered.includes(k)) ordered.push(k); });
    return ordered;
  }

  function updateBtnLabel(availableKeys) {
    var active = state.models.filter(function(m) { return availableKeys.includes(m); });
    if (active.length === 0) {
      btn.textContent = "All models \u25be";
    } else if (active.length === 1) {
      btn.textContent = getModelDisplay(active[0]) + " \u25be";
    } else {
      btn.textContent = active.length + " models \u25be";
    }
  }

  // Rebuild the checkbox list to match current track
  function refreshList() {
    var availableKeys = getAvailableModelKeys();
    // Drop any state.models that are no longer available
    state.models = state.models.filter(function(m) { return availableKeys.includes(m); });
    // Rebuild DOM
    list.innerHTML = "";
    availableKeys.forEach(function(mkey) {
      var label = document.createElement("label");
      label.className = "ms-option";
      label.innerHTML = '<input type="checkbox" value="' + escHtml(mkey) + '"' + (state.models.length === 0 || state.models.includes(mkey) ? " checked" : "") + '> ' + escHtml(getModelDisplay(mkey));
      list.appendChild(label);
    });
    var allChecked = state.models.length === 0;
    allBox.checked = allChecked;
    allBox.indeterminate = !allChecked && state.models.length > 0;
    updateBtnLabel(availableKeys);
    return availableKeys;
  }

  // Expose so update() can call it
  buildModelMultiSelect._refresh = refreshList;

  btn.addEventListener("click", function(e) { e.stopPropagation(); panel.classList.toggle("hidden"); });
  document.addEventListener("click", function() { panel.classList.add("hidden"); });
  panel.addEventListener("click", function(e) { e.stopPropagation(); });

  allBox.addEventListener("change", function() {
    list.querySelectorAll("input[type=checkbox]").forEach(function(cb) { cb.checked = allBox.checked; });
    state.models = [];
    allBox.indeterminate = false;
    updateBtnLabel(getAvailableModelKeys());
    update();
  });

  list.addEventListener("change", function(e) {
    if (!e.target.matches("input[type=checkbox]")) return;
    var availableKeys = getAvailableModelKeys();
    var checked = [...list.querySelectorAll("input:checked")].map(function(cb) { return cb.value; });
    var allChecked = checked.length === availableKeys.length;
    allBox.checked = allChecked;
    allBox.indeterminate = !allChecked && checked.length > 0;
    state.models = allChecked ? [] : checked;
    updateBtnLabel(availableKeys);
    update();
  });

  document.addEventListener("keydown", function(e) {
    if (e.key === "Escape") panel.classList.add("hidden");
  });

  // Initial population
  refreshList();
}

function buildTaskMultiSelect(metadata) {
  var btn = document.getElementById("task-ms-btn");
  var panel = document.getElementById("task-ms-panel");
  var list = document.getElementById("task-ms-list");
  var allBox = document.getElementById("ms-all-tasks");

  if (!btn || !panel || !list || !allBox) return;

  var taskDisplayNames = metadata.task_display_names || {};
  var taskDisplayOrder = metadata.task_display_order || [];
  var tasks = metadata.tasks || [];

  // Sort tasks by canonical display order
  var orderIndex = {};
  taskDisplayOrder.forEach(function(disp, i) {
    var entry = Object.entries(taskDisplayNames).find(function(e) { return e[1] === disp; });
    if (entry) orderIndex[entry[0]] = i;
  });
  var orderedTasks = [...tasks].sort(function(a, b) {
    return (orderIndex[a] != null ? orderIndex[a] : 999) - (orderIndex[b] != null ? orderIndex[b] : 999);
  });

  // Populate checkboxes
  orderedTasks.forEach(function(task) {
    var disp = taskDisplayNames[task] || task;
    var label = document.createElement("label");
    label.className = "ms-option";
    label.innerHTML = '<input type="checkbox" value="' + escHtml(task) + '" checked> ' + escHtml(disp);
    list.appendChild(label);
  });

  function updateBtnLabel() {
    if (state.tasks.length === 0) {
      btn.textContent = "All tasks \u25be";
    } else if (state.tasks.length === 1) {
      btn.textContent = (taskDisplayNames[state.tasks[0]] || state.tasks[0]) + " \u25be";
    } else {
      btn.textContent = state.tasks.length + " tasks \u25be";
    }
  }

  btn.addEventListener("click", function(e) { e.stopPropagation(); panel.classList.toggle("hidden"); });
  document.addEventListener("click", function() { panel.classList.add("hidden"); });
  panel.addEventListener("click", function(e) { e.stopPropagation(); });

  allBox.addEventListener("change", function() {
    var checked = allBox.checked;
    list.querySelectorAll("input[type=checkbox]").forEach(function(cb) { cb.checked = checked; });
    state.tasks = [];
    allBox.indeterminate = false;
    updateBtnLabel();
    update();
  });

  list.addEventListener("change", function(e) {
    if (!e.target.matches("input[type=checkbox]")) return;
    var checked = [...list.querySelectorAll("input:checked")].map(function(cb) { return cb.value; });
    var allChecked = checked.length === orderedTasks.length;
    allBox.checked = allChecked;
    allBox.indeterminate = !allChecked && checked.length > 0;
    state.tasks = allChecked ? [] : checked;
    updateBtnLabel();
    update();
  });

  document.addEventListener("keydown", function(e) {
    if (e.key === "Escape") panel.classList.add("hidden");
  });
}

/* ============================================================
   8. FILTER UI WIRING
   ============================================================ */

function populateFilterOptions(metadata) {
  var labels = metadata.dataset_labels || {};
  var datasetSel = document.getElementById("filter-dataset");
  if (datasetSel) {
    orderDatasets(metadata.datasets).forEach(function(ds) {
      var opt = document.createElement("option");
      opt.value = ds;
      opt.textContent = labels[ds] || ds;
      datasetSel.appendChild(opt);
    });
  }
  buildModelMultiSelect();
  buildTaskMultiSelect(metadata);
}

function wireFilters() {
  var el;

  el = document.getElementById("filter-track");
  if (el) el.addEventListener("change", function(e) { state.track = e.target.value; update(); });

  el = document.getElementById("filter-dataset");
  if (el) el.addEventListener("change", function(e) { state.dataset = e.target.value; update(); });

  el = document.getElementById("filter-decodable");
  if (el) el.addEventListener("change", function(e) { state.decodable = e.target.value; update(); });

  document.querySelectorAll(".toggle-btn[data-metric]").forEach(function(btn) {
    btn.addEventListener("click", function() {
      document.querySelectorAll(".toggle-btn[data-metric]").forEach(function(b) { b.classList.remove("active"); });
      btn.classList.add("active");
      state.metric = btn.dataset.metric;
      update();
    });
  });

  document.querySelectorAll(".tab-btn[data-tab]").forEach(function(btn) {
    btn.addEventListener("click", function() {
      document.querySelectorAll(".tab-btn").forEach(function(b) { b.classList.remove("active"); b.setAttribute("aria-selected", "false"); });
      btn.classList.add("active");
      btn.setAttribute("aria-selected", "true");
      state.tab = btn.dataset.tab;
      document.querySelectorAll(".tab-panel").forEach(function(p) { p.classList.remove("active"); });
      var panel = document.getElementById("tab-" + state.tab);
      if (panel) panel.classList.add("active");
      update();
    });
  });

  el = document.getElementById("modal-close");
  if (el) el.addEventListener("click", hideModal);

  el = document.getElementById("modal-overlay");
  if (el) el.addEventListener("click", function(e) { if (e.target === e.currentTarget) hideModal(); });

  document.addEventListener("keydown", function(e) { if (e.key === "Escape") hideModal(); });

  var resetBtn = document.getElementById("reset-filters");
  if (resetBtn) resetBtn.addEventListener("click", function() {
    state.track     = "STFT";
    state.dataset   = "all";
    state.models    = [];
    state.tasks     = [];
    state.decodable = "resolved";
    state.metric    = "roc_auc";
    state.sortCol   = "mean_all";
    state.sortDir   = "desc";
    var ld2 = getData();
    applyStateToUI(ld2 ? ld2.metadata : null);
    update();
  });
}

/* ============================================================
   9. MAIN UPDATE LOOP
   ============================================================ */

/* ── URL state helpers ───────────────────────────────────────
   Encodes non-default state values as query params so the page
   can be refreshed/bookmarked without losing your view.
   Only non-default values are written to keep URLs short.
*/
function loadStateFromURL() {
  var p = new URLSearchParams(window.location.search);
  if (p.has("tab"))       state.tab       = p.get("tab");
  if (p.has("track"))     state.track     = p.get("track");
  if (p.has("dataset"))   state.dataset   = p.get("dataset");
  if (p.has("decodable")) state.decodable = p.get("decodable");
  if (p.has("metric"))    state.metric    = p.get("metric");
  if (p.has("sort")) {
    var parts = p.get("sort").split(":");
    if (parts[0]) state.sortCol = parts[0];
    if (parts[1]) state.sortDir = parts[1];
  }
  if (p.has("models")) {
    var m = p.get("models");
    state.models = m ? m.split(",") : [];
  }
  if (p.has("tasks")) {
    var t = p.get("tasks");
    state.tasks = t ? t.split(",") : [];
  }
}

function pushStateFromState() {
  var p = new URLSearchParams();
  if (state.tab       !== "leaderboard") p.set("tab",       state.tab);
  if (state.track     !== "STFT")        p.set("track",     state.track);
  if (state.dataset   !== "all")         p.set("dataset",   state.dataset);
  if (state.decodable !== "resolved")    p.set("decodable", state.decodable);
  if (state.metric    !== "roc_auc")     p.set("metric",    state.metric);
  if (state.sortCol !== "mean_all" || state.sortDir !== "desc")
    p.set("sort", state.sortCol + ":" + state.sortDir);
  if (state.models.length > 0)           p.set("models",    state.models.join(","));
  if (state.tasks.length > 0)            p.set("tasks",     state.tasks.join(","));
  var qs = p.toString();
  history.replaceState(null, "", qs ? "?" + qs : window.location.pathname);
}

function applyStateToUI(metadata) {
  // Tabs
  document.querySelectorAll(".tab-btn[data-tab]").forEach(function(b) {
    var active = b.dataset.tab === state.tab;
    b.classList.toggle("active", active);
    b.setAttribute("aria-selected", active ? "true" : "false");
  });
  document.querySelectorAll(".tab-panel").forEach(function(p) { p.classList.remove("active"); });
  var activePanel = document.getElementById("tab-" + state.tab);
  if (activePanel) activePanel.classList.add("active");

  // Dropdowns
  var el;
  el = document.getElementById("filter-track");     if (el) el.value = state.track;
  el = document.getElementById("filter-dataset");   if (el) el.value = state.dataset;
  el = document.getElementById("filter-decodable"); if (el) el.value = state.decodable;

  // Metric toggle buttons
  document.querySelectorAll(".toggle-btn[data-metric]").forEach(function(b) {
    b.classList.toggle("active", b.dataset.metric === state.metric);
  });

  // Model multiselect — list is rebuilt by update() via _refresh; just sync button label here
  var modelList   = document.getElementById("model-ms-list");
  var modelAllBox = document.getElementById("ms-all-models");
  var modelBtn    = document.getElementById("model-ms-btn");
  if (modelList && modelAllBox && modelBtn) {
    if (state.models.length === 0) {
      modelList.querySelectorAll("input[type=checkbox]").forEach(function(cb) { cb.checked = true; });
      modelAllBox.checked = true;
      modelAllBox.indeterminate = false;
      modelBtn.textContent = "All models \u25be";
    } else {
      modelList.querySelectorAll("input[type=checkbox]").forEach(function(cb) {
        cb.checked = state.models.includes(cb.value);
      });
      modelAllBox.checked = false;
      modelAllBox.indeterminate = true;
      modelBtn.textContent = state.models.length === 1
        ? getModelDisplay(state.models[0]) + " \u25be"
        : state.models.length + " models \u25be";
    }
  }

  // Task multiselect checkboxes
  var taskDisplayNames = (metadata && metadata.task_display_names) || {};
  var list    = document.getElementById("task-ms-list");
  var allBox  = document.getElementById("ms-all-tasks");
  var msBtn   = document.getElementById("task-ms-btn");
  if (list && allBox && msBtn) {
    if (state.tasks.length === 0) {
      list.querySelectorAll("input[type=checkbox]").forEach(function(cb) { cb.checked = true; });
      allBox.checked = true;
      allBox.indeterminate = false;
      msBtn.textContent = "All tasks \u25be";
    } else {
      list.querySelectorAll("input[type=checkbox]").forEach(function(cb) {
        cb.checked = state.tasks.includes(cb.value);
      });
      allBox.checked = false;
      allBox.indeterminate = true;
      msBtn.textContent = state.tasks.length === 1
        ? (taskDisplayNames[state.tasks[0]] || state.tasks[0]) + " \u25be"
        : state.tasks.length + " tasks \u25be";
    }
  }
}

function update() {
  var ld = getData();
  if (!ld) return;
  var records = ld.records;
  var decodable_filters = activeDecodableFilters(ld);
  var roofline = activeRoofline(ld);
  var metadata = ld.metadata;

  // Refresh model list to match current track, then filter
  if (buildModelMultiSelect._refresh) buildModelMultiSelect._refresh();

  var filtered = filterRecords(records, decodable_filters);

  updateSummaryCards(filtered);

  if (state.tab === "leaderboard") {
    renderTable(filtered, metadata);
  } else if (state.tab === "subjects") {
    renderSubjectCharts(filtered, metadata);
    wireChartClicks(filtered);
  } else {
    renderCharts(filtered, metadata, decodable_filters, roofline);
    wireChartClicks(filtered);
  }
  pushStateFromState();
}

/* ============================================================
   10. INIT
   ============================================================ */

function requireValue(condition, filename, message) {
  if (!condition) throw new Error(filename + ": " + message);
}

async function fetchJson(filename, url) {
  var bundledFiles = window.IMINDBENCH_DATA_FILES;
  if (bundledFiles) {
    if (!Object.prototype.hasOwnProperty.call(bundledFiles, url)) {
      throw new Error(filename + ": missing from data_bundle.js");
    }
    return bundledFiles[url];
  }
  var response;
  try {
    response = await fetch(url, { cache: "no-cache" });
  } catch (error) {
    throw new Error(filename + ": request failed (" + error.message + ")");
  }
  if (!response.ok) {
    throw new Error(filename + ": HTTP " + response.status + " " + response.statusText);
  }
  try {
    return await response.json();
  } catch (error) {
    throw new Error(filename + ": invalid JSON (" + error.message + ")");
  }
}

function cellKey(dataset, subset, evalMode, task, subjectSession) {
  return JSON.stringify([dataset, subset == null ? null : subset, evalMode, task, subjectSession]);
}

function expectedCellsByDataset(contract) {
  var result = {};
  Object.entries(contract.datasets).forEach(function(entry) {
    var dataset = entry[0];
    var spec = entry[1];
    var cells = new Set();
    spec.tasks.forEach(function(task) {
      spec.subject_sessions.forEach(function(subjectSession) {
        cells.add(cellKey(dataset, spec.subset, contract.evaluation_mode, task, subjectSession));
      });
    });
    result[dataset] = cells;
  });
  return result;
}

function computeCoverage(artifact, hydratedRecords, contract, filename) {
  var expectedByDataset = expectedCellsByDataset(contract);
  var expectedAll = new Set();
  Object.values(expectedByDataset).forEach(function(cells) {
    cells.forEach(function(cell) { expectedAll.add(cell); });
  });

  var logicalKeys = [...new Set(artifact.runs.map(function(run) { return run.model_preprocess_key; }))].sort();
  var byKey = {};
  var totalObserved = 0;
  var totalUnexpected = 0;

  logicalKeys.forEach(function(logicalKey) {
    var records = hydratedRecords.filter(function(record) {
      return record.model_preprocess_key === logicalKey;
    });
    var observed = new Set();
    var foldIdentities = new Set();
    var foldsByCell = new Map();

    records.forEach(function(record) {
      var cell = cellKey(record.dataset, record.subset, record.eval_mode, record.task, record.subject_session);
      var foldIdentity = cell + "|" + String(record.fold_idx);
      requireValue(!foldIdentities.has(foldIdentity), filename, "duplicate record identity for " + logicalKey);
      foldIdentities.add(foldIdentity);
      observed.add(cell);
      if (!foldsByCell.has(cell)) foldsByCell.set(cell, new Set());
      foldsByCell.get(cell).add(record.fold_idx);
    });

    foldsByCell.forEach(function(folds, cell) {
      contract.fold_indices.forEach(function(fold) {
        requireValue(folds.has(fold), filename, "missing fold " + fold + " for " + logicalKey + " cell " + cell);
      });
      requireValue(folds.size === contract.fold_indices.length, filename, "unexpected fold for " + logicalKey + " cell " + cell);
    });

    var unexpected = [...observed].filter(function(cell) { return !expectedAll.has(cell); });
    var missing = [...expectedAll].filter(function(cell) { return !observed.has(cell); });
    var missingByDataset = {};
    Object.entries(expectedByDataset).forEach(function(entry) {
      missingByDataset[entry[0]] = [...entry[1]].filter(function(cell) { return !observed.has(cell); }).length;
    });
    byKey[logicalKey] = {
      status: missing.length === 0 && unexpected.length === 0 ? "complete" : "partial",
      expected_result_cells: expectedAll.size,
      observed_result_cells: observed.size,
      missing_result_cells: missing.length,
      unexpected_result_cells: unexpected.length,
      missing_by_dataset: missingByDataset,
    };
    totalObserved += observed.size;
    totalUnexpected += unexpected.length;
  });

  var expectedTotal = expectedAll.size * logicalKeys.length;
  var missingTotal = Math.max(0, expectedTotal - totalObserved + totalUnexpected);
  return {
    status: missingTotal === 0 && totalUnexpected === 0 ? "complete" : "partial",
    expected_result_cells: expectedTotal,
    observed_result_cells: totalObserved,
    missing_result_cells: missingTotal,
    unexpected_result_cells: totalUnexpected,
    by_model_preprocess_key: byKey,
  };
}

function validateStoredCoverage(stored, computed, filename) {
  requireValue(stored && typeof stored === "object", filename, "coverage must be an object");
  ["status", "expected_result_cells", "observed_result_cells", "missing_result_cells", "unexpected_result_cells"].forEach(function(field) {
    requireValue(stored[field] === computed[field], filename, "coverage." + field + " does not match records");
  });
  requireValue(stored.by_model_preprocess_key && typeof stored.by_model_preprocess_key === "object", filename, "coverage.by_model_preprocess_key must be an object");
  var storedKeys = Object.keys(stored.by_model_preprocess_key).sort();
  var computedKeys = Object.keys(computed.by_model_preprocess_key).sort();
  requireValue(JSON.stringify(storedKeys) === JSON.stringify(computedKeys), filename, "coverage logical preprocessing keys do not match runs");
  computedKeys.forEach(function(key) {
    var actual = stored.by_model_preprocess_key[key];
    var expected = computed.by_model_preprocess_key[key];
    ["status", "expected_result_cells", "observed_result_cells", "missing_result_cells", "unexpected_result_cells"].forEach(function(field) {
      requireValue(actual[field] === expected[field], filename, "coverage for " + key + " has an incorrect " + field);
    });
  });
}

function hydrateArtifact(artifact, filename, contract) {
  requireValue(artifact && artifact.schema_version === 2, filename, "unsupported artifact schema_version");
  requireValue(artifact.model && typeof artifact.model.model_id === "string", filename, "missing model.model_id");
  requireValue(Array.isArray(artifact.runs), filename, "runs must be an array");
  requireValue(Array.isArray(artifact.records), filename, "records must be an array");

  var modelId = artifact.model.model_id;
  var runById = new Map();
  artifact.runs.forEach(function(run) {
    requireValue(run && typeof run.run_id === "string", filename, "run is missing run_id");
    requireValue(!runById.has(run.run_id), filename, "duplicate run_id " + run.run_id);
    runById.set(run.run_id, run);
  });

  var hydrated = artifact.records.map(function(record) {
    var run = runById.get(record.run_id);
    requireValue(run, filename, "record references unknown run_id " + record.run_id);
    return Object.assign({}, run, record, { model_name: modelId });
  });
  var referencedRuns = new Set(artifact.records.map(function(record) { return record.run_id; }));
  artifact.runs.forEach(function(run) {
    requireValue(referencedRuns.has(run.run_id), filename, "unreferenced run_id " + run.run_id);
  });

  var coverage = computeCoverage(artifact, hydrated, contract, filename);
  validateStoredCoverage(artifact.coverage, coverage, filename);
  var publicInfo = Object.assign({}, artifact.model, { coverage: coverage });
  if (coverage.status === "partial") {
    var generated = "Partial coverage — " + coverage.observed_result_cells + " of " + coverage.expected_result_cells +
      " expected result cells across the full benchmark grid (" + coverage.missing_result_cells +
      " missing). In every subject cohort this model's averages cover fewer subject-sessions than other models, so they may not be directly comparable.";
    if (artifact.model.coverage_note) generated += " " + artifact.model.coverage_note;
    publicInfo.coverage_note = generated;
  } else {
    publicInfo.coverage_note = null;
  }
  return { modelId: modelId, modelInfo: publicInfo, records: hydrated };
}

function deriveDecodableData(manifestsBySet) {
  var filters = {};
  var roofline = {};
  Object.entries(manifestsBySet).forEach(function(setEntry) {
    var setId = setEntry[0];
    var setDir = DECODABLE_MANIFEST_DIR;
    filters[setId] = {};
    roofline[setId] = {};
    Object.entries(setEntry[1]).forEach(function(entry) {
      var dataset = entry[0];
      var manifest = entry[1];
      var filename = setDir + dataset + ".json";
      requireValue(manifest && manifest.tasks && typeof manifest.tasks === "object", filename, "tasks must be an object");
      filters[setId][dataset] = {};
      roofline[setId][dataset] = {};
      Object.entries(manifest.tasks).forEach(function(taskEntry) {
        var task = taskEntry[0];
        var taskData = taskEntry[1];
        requireValue(Array.isArray(taskData.subject_sessions), filename, "subject_sessions for " + task + " must be an array");
        filters[setId][dataset][task] = taskData.subject_sessions;
        roofline[setId][dataset][task] = {
          mean_test_roc_auc: taskData.mean_test_roc_auc,
          max_test_roc_auc: taskData.max_test_roc_auc,
          n_subject_sessions: taskData.n_subject_sessions,
        };
      });
    });
  });
  return { filters: filters, roofline: roofline };
}

function deriveMetadata(records, modelIds) {
  var datasets = orderDatasets([...new Set(records.map(function(record) { return record.dataset; }))]);
  var taskOrder = Object.keys(TASK_DISPLAY_NAMES);
  var tasks = [...new Set(records.map(function(record) { return record.task; }))].sort(function(a, b) {
    var ai = taskOrder.indexOf(a);
    var bi = taskOrder.indexOf(b);
    return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi) || a.localeCompare(b);
  });
  return {
    datasets: datasets,
    dataset_order: DATASET_ORDER.slice(),
    dataset_labels: DATASET_LABELS,
    tasks: tasks,
    task_display_names: TASK_DISPLAY_NAMES,
    task_display_order: TASK_DISPLAY_ORDER,
    models: modelIds,
    preprocessing_tracks: [...new Set(records.map(function(record) { return record.preprocessing_track; }))].sort(),
    run_dirs: [...new Set(records.map(function(record) { return record.run_dir; }))].sort(),
  };
}

async function loadLeaderboardData() {
  var manifestFilename = "data/manifest.json";
  var contractFilename = "data/coverage_contract.json";
  var registryFiles = await Promise.all([
    fetchJson(manifestFilename, manifestFilename),
    fetchJson(contractFilename, contractFilename),
  ]);
  var manifest = registryFiles[0];
  var contract = registryFiles[1];
  requireValue(manifest && manifest.schema_version === 1 && Array.isArray(manifest.models), manifestFilename, "unsupported or malformed manifest");
  requireValue(contract && contract.schema_version === 1 && contract.datasets && Array.isArray(contract.fold_indices), contractFilename, "unsupported or malformed coverage contract");

  var seenPaths = new Set();
  manifest.models.forEach(function(path) {
    requireValue(typeof path === "string" && /^models\/[a-z0-9]+(?:_[a-z0-9]+)*\.json$/.test(path), manifestFilename, "unsafe model artifact path " + String(path));
    requireValue(!seenPaths.has(path), manifestFilename, "duplicate model artifact path " + path);
    seenPaths.add(path);
  });

  var datasetIds = Object.keys(contract.datasets);
  datasetIds.forEach(function(dataset) {
    requireValue(/^[a-z0-9]+$/.test(dataset), contractFilename, "unsafe dataset key " + dataset);
  });
  var artifactPromises = manifest.models.map(function(path) {
    return fetchJson("data/" + path, "data/" + path).then(function(artifact) {
      var expectedId = path.slice("models/".length, -".json".length);
      requireValue(artifact && artifact.model && artifact.model.model_id === expectedId, "data/" + path, "model_id does not match filename");
      return { artifact: artifact, filename: "data/" + path };
    });
  });
  var decodablePromise = Promise.all(datasetIds.map(function(dataset) {
    var filename = DECODABLE_MANIFEST_DIR + dataset + ".json";
    return fetchJson(filename, filename).then(function(data) { return [dataset, data]; });
  })).then(function(pairs) { return [DECODABLE_SET_ID, Object.fromEntries(pairs)]; });
  var loaded = await Promise.all([Promise.all(artifactPromises), decodablePromise]);

  var modelIds = [];
  var seenModelIds = new Set();
  var records = [];
  loaded[0].forEach(function(item) {
    var result = hydrateArtifact(item.artifact, item.filename, contract);
    requireValue(!seenModelIds.has(result.modelId), item.filename, "duplicate model_id " + result.modelId);
    seenModelIds.add(result.modelId);
    modelIds.push(result.modelId);
    modelInfo[result.modelId] = result.modelInfo;
    records.push.apply(records, result.records);
  });
  var decodable = deriveDecodableData(Object.fromEntries([loaded[1]]));
  return {
    schema_version: 2,
    records: records,
    decodable_filters: decodable.filters,
    roofline: decodable.roofline,
    metadata: deriveMetadata(records, modelIds),
    coverage_contract: contract,
  };
}

function showLoadError(error) {
  console.error(error);
  var message = error && error.message ? error.message : String(error);
  var html = '<div class="empty-state"><p><strong>Leaderboard data could not be loaded.</strong></p><p>' + escHtml(message) + '</p><p>Serve this directory over HTTP and verify the named JSON file.</p></div>';
  ["table-container", "charts-container", "subject-charts-container"].forEach(function(id) {
    var element = document.getElementById(id);
    if (element) element.innerHTML = html;
  });
}

async function init() {
  try {
    leaderboardData = await loadLeaderboardData();
    // Hydration owns the normalized records now; release the large raw bundle.
    window.IMINDBENCH_DATA_FILES = null;
  } catch (error) {
    showLoadError(error);
    return;
  }
  var ld = getData();

  function _run() {
    var metadata = ld.metadata;
    loadStateFromURL();

    // Assign colors to models — use named map first, fall back to palette index
    (metadata.models || []).forEach(function(model, i) {
      modelColorMap[model] = MODEL_COLORS[model] || PALETTE[i % PALETTE.length];
    });

    populateFilterOptions(metadata);
    applyStateToUI(metadata);
    wireFilters();
    update();
  }
  _run();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
