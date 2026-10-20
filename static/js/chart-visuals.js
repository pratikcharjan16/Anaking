/* Dynamic Visual Charts & Interactive Visualizations for Survey Research Analysis.
   Self-contained, pure standard SVG/HTML rendering without external dependencies. */
(function (global) {
  'use strict';

  var PALETTE = ['#12789e', '#f59e0b', '#10b981', '#6366f1', '#ec4899', '#8b5cf6', '#14b8a6', '#f97316', '#0284c7', '#84cc16'];
  var activeViews = {};

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
    });
  }

  function getAvailableViews(q) {
    var t = q.type;
    if (t === 'single_select' || t === 'multi_select' || t === 'rank') {
      return [
        { id: 'bar', label: '📊 Bar' },
        { id: 'column', label: '❚❚ Column' },
        { id: 'donut', label: '🍩 Donut' },
        { id: 'table', label: '📋 Table' }
      ];
    }
    if ((t === 'rating_scale' || t === 'rating_grid' || t === 'semantic_diff' || t === 'emoji_grid' || t === 'numeric_matrix') || (t === 'gauge_meter' && q.rows)) {
      return [
        { id: 'bar', label: '📊 Spectrum' },
        { id: 'radar', label: '🕸 Radar' },
        { id: 'likert', label: '▦ Stacked Likert' },
        { id: 'scorecard', label: '🏆 Scorecard' }
      ];
    }
    if (t === 'gauge_meter' && !q.rows) {
      return [
        { id: 'dial', label: '🧭 Dial' },
        { id: 'bullet', label: '🎯 Bullet' },
        { id: 'donut', label: '🍩 Zones' }
      ];
    }
    if (t === 'sum_to_100') {
      return [
        { id: 'bar', label: '📊 Allocation' },
        { id: 'donut', label: '🍩 Share Donut' }
      ];
    }
    if (t === 'open_text') {
      return [
        { id: 'cloud', label: '☁ Theme Cloud' },
        { id: 'verbatims', label: '💬 Verbatims' }
      ];
    }
    if (t === 'heatmap') {
      return [
        { id: 'matrix', label: '▦ Heatmap Grid' },
        { id: 'bar', label: '📊 Row Ranking' }
      ];
    }
    if (t === 'numeric' || t === 'slider' || t === 'delta') {
      return [
        { id: 'box', label: '📋 Summary Stats' }
      ];
    }
    return [{ id: 'default', label: 'Default' }];
  }

  // --------------------------------------------------------------------------
  // SVG Donut Generator
  // --------------------------------------------------------------------------
  function renderSvgDonut(items, totalBase, title) {
    if (!items || !items.length) return '<p style="color:#64748b;padding:12px">No response data for donut chart.</p>';
    var cx = 110, cy = 110, rOut = 85, rIn = 48;
    var tot = items.reduce(function (sum, item) { return sum + (Number(item.count || item.pct || 0)); }, 0) || 1;
    var curAngle = -Math.PI / 2;

    var paths = items.map(function (item, idx) {
      var val = Number(item.count || item.pct || 0);
      var span = (val / tot) * 2 * Math.PI;
      if (span <= 0.001) return '';
      if (span >= 2 * Math.PI - 0.001) span = 2 * Math.PI - 0.001; // Avoid exact 360 artifact
      var startA = curAngle;
      var endA = curAngle + span;
      curAngle = endA;

      var x1 = cx + rOut * Math.cos(startA), y1 = cy + rOut * Math.sin(startA);
      var x2 = cx + rOut * Math.cos(endA), y2 = cy + rOut * Math.sin(endA);
      var x3 = cx + rIn * Math.cos(endA), y3 = cy + rIn * Math.sin(endA);
      var x4 = cx + rIn * Math.cos(startA), y4 = cy + rIn * Math.sin(startA);
      var large = span > Math.PI ? 1 : 0;
      var d = 'M ' + x1.toFixed(1) + ' ' + y1.toFixed(1) +
              ' A ' + rOut + ' ' + rOut + ' 0 ' + large + ' 1 ' + x2.toFixed(1) + ' ' + y2.toFixed(1) +
              ' L ' + x3.toFixed(1) + ' ' + y3.toFixed(1) +
              ' A ' + rIn + ' ' + rIn + ' 0 ' + large + ' 0 ' + x4.toFixed(1) + ' ' + y4.toFixed(1) + ' Z';
      var color = item.color || PALETTE[idx % PALETTE.length];
      var tip = esc(item.label) + ': ' + (item.pct != null ? item.pct + '%' : '') + (item.count != null ? ' (n=' + item.count + ')' : '');
      return '<path class="donut-slice" d="' + d + '" fill="' + color + '"><title>' + tip + '</title></path>';
    }).join('');

    var legendHtml = '<div class="donut-legend">' + items.map(function (item, idx) {
      var color = item.color || PALETTE[idx % PALETTE.length];
      var p = item.pct != null ? item.pct + '%' : '';
      var cnt = item.count != null ? ' <span style="color:#64748b">(n=' + item.count + ')</span>' : '';
      return '<div class="donut-legend-row">' +
        '<span class="donut-legend-swatch" style="background:' + color + '"></span>' +
        '<span style="flex:1" title="' + esc(item.label) + '">' + esc(item.label) + '</span>' +
        '<b>' + p + '</b>' + cnt +
      '</div>';
    }).join('') + '</div>';

    return '<div class="donut-layout">' +
      '<div class="donut-svg-box">' +
        '<svg viewBox="0 0 220 220" width="100%" height="100%">' +
          paths +
          '<circle cx="' + cx + '" cy="' + cy + '" r="' + (rIn - 2) + '" fill="#ffffff"/>' +
          '<text x="' + cx + '" y="' + (cy - 4) + '" text-anchor="middle" font-size="11" font-weight="700" fill="#64748b">TOTAL BASE</text>' +
          '<text x="' + cx + '" y="' + (cy + 14) + '" text-anchor="middle" font-size="14" font-weight="800" fill="#0f172a">n=' + (totalBase || tot) + '</text>' +
        '</svg>' +
      '</div>' +
      legendHtml +
    '</div>';
  }

  // --------------------------------------------------------------------------
  // SVG Vertical Column Chart Generator
  // --------------------------------------------------------------------------
  function renderSvgColumn(items, isCut, cut) {
    if (!items || !items.length) return '<p style="color:#64748b;padding:12px">No response data for column chart.</p>';
    var w = 560, h = 230;
    var padL = 48, padR = 20, padT = 24, padB = 46;
    var plotW = w - padL - padR;
    var plotH = h - padT - padB;

    // Grid lines for 0%, 25%, 50%, 75%, 100%
    var gridLines = [0, 25, 50, 75, 100].map(function (pct) {
      var y = padT + plotH - (pct / 100) * plotH;
      return '<line x1="' + padL + '" y1="' + y + '" x2="' + (w - padR) + '" y2="' + y + '" stroke="#e2e8f0" stroke-width="1" stroke-dasharray="3,3"/>' +
        '<text x="' + (padL - 6) + '" y="' + (y + 3) + '" text-anchor="end" font-size="10" fill="#94a3b8">' + pct + '%</text>';
    }).join('');

    var nItems = items.length;
    var colWidth = Math.max(16, Math.min(50, Math.floor(plotW / (nItems * (isCut ? 2.5 : 1.4)))));
    var gap = plotW / nItems;

    var colsHtml = items.map(function (item, idx) {
      var centerX = padL + idx * gap + gap / 2;
      var label = esc(item.label || item.code || '');
      var shortLabel = label.length > 14 ? label.slice(0, 12) + '…' : label;

      if (isCut) {
        var pA = item.segA_pct || 0, pB = item.segB_pct || 0;
        var hA = Math.max(2, (pA / 100) * plotH);
        var hB = Math.max(2, (pB / 100) * plotH);
        var yA = padT + plotH - hA;
        var yB = padT + plotH - hB;
        var xA = centerX - colWidth - 2;
        var xB = centerX + 2;
        var sigStar = (item.sig_test && item.sig_test.significant) ? '<text x="' + centerX + '" y="' + (Math.min(yA, yB) - 8) + '" text-anchor="middle" font-size="12" fill="#d97706" font-weight="bold">★</text>' : '';

        return '<g>' +
          '<rect x="' + xA + '" y="' + yA + '" width="' + colWidth + '" height="' + hA + '" rx="3" fill="#12789e">' +
            '<title>' + label + ' - ' + esc(cut.segA_label) + ': ' + pA + '%</title>' +
          '</rect>' +
          '<text x="' + (xA + colWidth / 2) + '" y="' + (yA - 4) + '" text-anchor="middle" font-size="10" font-weight="700" fill="#12789e">' + pA + '%</text>' +
          '<rect x="' + xB + '" y="' + yB + '" width="' + colWidth + '" height="' + hB + '" rx="3" fill="#f59e0b">' +
            '<title>' + label + ' - ' + esc(cut.segB_label) + ': ' + pB + '%</title>' +
          '</rect>' +
          '<text x="' + (xB + colWidth / 2) + '" y="' + (yB - 4) + '" text-anchor="middle" font-size="10" font-weight="700" fill="#b45309">' + pB + '%</text>' +
          sigStar +
          '<text x="' + centerX + '" y="' + (padT + plotH + 16) + '" text-anchor="middle" font-size="11" fill="#334155" title="' + label + '">' + shortLabel + '</text>' +
        '</g>';
      } else {
        var pct = item.pct || 0;
        var colH = Math.max(2, (pct / 100) * plotH);
        var y = padT + plotH - colH;
        var x = centerX - colWidth / 2;
        var tip = label + ': ' + pct + '%' + (item.count != null ? ' (n=' + item.count + ')' : '');

        return '<g>' +
          '<rect x="' + x + '" y="' + y + '" width="' + colWidth + '" height="' + colH + '" rx="4" fill="#12789e">' +
            '<title>' + tip + '</title>' +
          '</rect>' +
          '<text x="' + centerX + '" y="' + (y - 5) + '" text-anchor="middle" font-size="11" font-weight="700" fill="#0f172a">' + pct + '%</text>' +
          '<text x="' + centerX + '" y="' + (padT + plotH + 16) + '" text-anchor="middle" font-size="11" fill="#334155" title="' + label + '">' + shortLabel + '</text>' +
          (item.count != null ? '<text x="' + centerX + '" y="' + (padT + plotH + 30) + '" text-anchor="middle" font-size="10" fill="#94a3b8">n=' + item.count + '</text>' : '') +
        '</g>';
      }
    }).join('');

    return '<div class="svg-chart-wrap">' +
      '<svg viewBox="0 0 ' + w + ' ' + h + '" width="100%" height="auto">' +
        gridLines +
        colsHtml +
      '</svg>' +
    '</div>';
  }

  // --------------------------------------------------------------------------
  // SVG Spider / Radar Chart Generator
  // --------------------------------------------------------------------------
  function renderSvgRadar(rows, sMin, sMax) {
    if (!rows || rows.length < 3) return renderRatingBars(rows, sMin, sMax);
    var w = 420, h = 320;
    var cx = 210, cy = 160, maxR = 100;
    var n = rows.length;
    var sRange = (sMax - sMin) || 1;

    // Rings at 25%, 50%, 75%, 100%
    var rings = [0.25, 0.5, 0.75, 1.0].map(function (frac) {
      var r = maxR * frac;
      var pts = [];
      for (var i = 0; i < n; i++) {
        var a = -Math.PI / 2 + (2 * Math.PI * i) / n;
        pts.push((cx + r * Math.cos(a)).toFixed(1) + ',' + (cy + r * Math.sin(a)).toFixed(1));
      }
      var valAtRing = (sMin + frac * sRange).toFixed(1);
      return '<polygon points="' + pts.join(' ') + '" fill="none" stroke="#e2e8f0" stroke-width="1"/>' +
        '<text x="' + (cx + 4) + '" y="' + (cy - r + 3) + '" font-size="9" fill="#94a3b8">' + valAtRing + '</text>';
    }).join('');

    // Spokes and labels
    var spokes = rows.map(function (r, i) {
      var a = -Math.PI / 2 + (2 * Math.PI * i) / n;
      var x2 = cx + maxR * Math.cos(a);
      var y2 = cy + maxR * Math.sin(a);
      var labelR = maxR + 24;
      var lx = cx + labelR * Math.cos(a);
      var ly = cy + labelR * Math.sin(a);
      var anchor = Math.abs(Math.cos(a)) < 0.2 ? 'middle' : (Math.cos(a) > 0 ? 'start' : 'end');
      var label = esc(r.label || r.code || '');
      var shortLabel = label.length > 15 ? label.slice(0, 13) + '…' : label;

      return '<line x1="' + cx + '" y1="' + cy + '" x2="' + x2.toFixed(1) + '" y2="' + y2.toFixed(1) + '" stroke="#e2e8f0" stroke-width="1"/>' +
        '<text x="' + lx.toFixed(1) + '" y="' + (ly + 3).toFixed(1) + '" text-anchor="' + anchor + '" font-size="10.5" font-weight="600" fill="#334155" title="' + label + '">' + shortLabel + '</text>';
    }).join('');

    // Polygon for Mean scores
    var polyPts = rows.map(function (r, i) {
      var a = -Math.PI / 2 + (2 * Math.PI * i) / n;
      var m = r.mean != null ? r.mean : sMin;
      var frac = Math.max(0, Math.min(1, (m - sMin) / sRange));
      var rVal = maxR * frac;
      return (cx + rVal * Math.cos(a)).toFixed(1) + ',' + (cy + rVal * Math.sin(a)).toFixed(1);
    });

    // Vertex dots
    var dots = rows.map(function (r, i) {
      var a = -Math.PI / 2 + (2 * Math.PI * i) / n;
      var m = r.mean != null ? r.mean : sMin;
      var frac = Math.max(0, Math.min(1, (m - sMin) / sRange));
      var rVal = maxR * frac;
      var x = cx + rVal * Math.cos(a);
      var y = cy + rVal * Math.sin(a);
      var tip = esc(r.label) + ' - Mean: ' + (r.mean != null ? r.mean : '—');
      return '<circle class="radar-point" cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="4.5" fill="#12789e" stroke="#ffffff" stroke-width="1.5">' +
        '<title>' + tip + '</title>' +
      '</circle>';
    }).join('');

    return '<div class="radar-chart-box">' +
      '<svg class="radar-svg" viewBox="0 0 ' + w + ' ' + h + '">' +
        rings +
        spokes +
        '<polygon points="' + polyPts.join(' ') + '" fill="rgba(18, 120, 158, 0.25)" stroke="#12789e" stroke-width="2"/>' +
        dots +
      '</svg>' +
      '<div style="font-size:11.5px;color:#64748b;margin-top:4px">Spider web benchmark on scale ' + sMin + ' to ' + sMax + '</div>' +
    '</div>';
  }

  // --------------------------------------------------------------------------
  // Stacked Likert Bar Chart Generator
  // --------------------------------------------------------------------------
  function renderStackedLikert(rows, sMin, sMax) {
    if (!rows || !rows.length) return '<p style="color:#64748b;padding:12px">No response data for Likert chart.</p>';
    var colors = ['#ef4444', '#fca5a5', '#cbd5e1', '#86efac', '#10b981'];

    var legend = '<div class="likert-legend-bar">' +
      '<span class="likert-legend-item"><span class="donut-legend-swatch" style="background:#ef4444"></span>1 - Lowest</span>' +
      '<span class="likert-legend-item"><span class="donut-legend-swatch" style="background:#cbd5e1"></span>3 - Neutral</span>' +
      '<span class="likert-legend-item"><span class="donut-legend-swatch" style="background:#10b981"></span>5 - Highest</span>' +
      '<span style="margin-left:auto;font-weight:700;color:#047857">★ Top-2 Box (Positive)</span>' +
    '</div>';

    var rowsHtml = rows.map(function (r) {
      var dist = r.dist || {};
      var pts = [];
      for (var p = sMin; p <= sMax; p++) {
        var d = dist[String(p)] || { pct: 0, count: 0 };
        pts.push({ pt: p, pct: d.pct, count: d.count });
      }
      var top2 = r.top2_box != null ? r.top2_box : (pts.length >= 2 ? (pts[pts.length - 1].pct + pts[pts.length - 2].pct) : 0);

      var segsHtml = pts.map(function (ptItem, idx) {
        var c = colors[idx % colors.length];
        var pct = ptItem.pct || 0;
        if (pct <= 0) return '';
        var tip = 'Rating ' + ptItem.pt + ': ' + pct + '% (n=' + ptItem.count + ')';
        return '<div class="likert-seg" style="width:' + pct + '%;background:' + c + '" title="' + tip + '"></div>';
      }).join('');

      return '<tr>' +
        '<td style="width:28%;font-weight:600;color:#1e293b" title="' + esc(r.label) + '">' + esc(r.label) + '</td>' +
        '<td style="width:54%"><div class="likert-stack-track">' + segsHtml + '</div></td>' +
        '<td style="width:18%;text-align:right"><b>' + top2 + '%</b> <small style="color:#64748b">(mean ' + (r.mean != null ? r.mean : '—') + ')</small></td>' +
      '</tr>';
    }).join('');

    return '<div>' + legend + '<table class="likert-table"><tbody>' + rowsHtml + '</tbody></table></div>';
  }

  // --------------------------------------------------------------------------
  // Performance Scorecard Generator
  // --------------------------------------------------------------------------
  function renderScorecard(rows, sMin, sMax) {
    if (!rows || !rows.length) return '<p style="color:#64748b;padding:12px">No response data for scorecard.</p>';
    var sorted = rows.slice().sort(function (a, b) { return (b.mean || 0) - (a.mean || 0); });
    var overallMean = sorted.reduce(function (s, x) { return s + (x.mean || 0); }, 0) / (sorted.length || 1);

    var html = '<div style="margin:10px 0">';
    html += sorted.map(function (r, idx) {
      var m = r.mean != null ? r.mean : 0;
      var diff = m - overallMean;
      var badgeCls = diff >= 0.2 ? 'high' : (diff <= -0.2 ? 'low' : 'mid');
      var badgeText = diff >= 0.2 ? 'Top Performer' : (diff <= -0.2 ? 'Focus Area' : 'Benchmark');
      var diffText = (diff >= 0 ? '+' : '') + diff.toFixed(2);

      return '<div class="scorecard-item">' +
        '<div style="display:flex;align-items:center">' +
          '<span class="scorecard-rank ' + (idx === 0 ? 'top' : '') + '">#' + (idx + 1) + '</span>' +
          '<strong title="' + esc(r.label) + '">' + esc(r.label) + '</strong>' +
        '</div>' +
        '<div style="display:flex;align-items:center;gap:12px">' +
          '<span>Score: <b>' + (r.mean != null ? r.mean : '—') + '</b></span>' +
          '<span class="scorecard-badge ' + badgeCls + '">' + badgeText + ' (' + diffText + ')</span>' +
        '</div>' +
      '</div>';
    }).join('');
    html += '</div>';
    return html;
  }

  // --------------------------------------------------------------------------
  // Bullet Performance Graph Generator
  // --------------------------------------------------------------------------
  function renderBulletGraph(q) {
    var m = q.mean != null ? q.mean : (q.min || 0);
    var gMin = q.min != null ? q.min : 0;
    var gMax = q.max != null ? q.max : 100;
    var target = q.target != null ? q.target : (gMin + (gMax - gMin) * 0.75);
    var range = (gMax - gMin) || 1;

    var actualPct = Math.max(0, Math.min(100, ((m - gMin) / range) * 100));
    var targetPct = Math.max(0, Math.min(100, ((target - gMin) / range) * 100));

    return '<div class="bullet-graph-card">' +
      '<div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px">' +
        '<span>Actual: <b>' + m + esc(q.unit || '%') + '</b></span>' +
        '<span style="color:#dc2626">Target benchmark: <b>' + target + esc(q.unit || '%') + '</b></span>' +
      '</div>' +
      '<div class="bullet-track-wrap">' +
        '<div class="bullet-zone-low" style="width:40%" title="Low Zone"></div>' +
        '<div class="bullet-zone-mid" style="width:30%" title="Moderate Zone"></div>' +
        '<div class="bullet-zone-hi" style="width:30%" title="High Zone"></div>' +
        '<div class="bullet-actual-bar" style="width:' + actualPct + '%" title="Actual Performance: ' + m + '"></div>' +
        '<div class="bullet-target-marker" style="left:' + targetPct + '%" title="Target Benchmark: ' + target + '"></div>' +
      '</div>' +
      '<div style="display:flex;justify-content:space-between;font-size:11px;color:#64748b">' +
        '<span>' + esc(q.min_label || 'Low') + ' (' + gMin + ')</span>' +
        '<span>' + esc(q.mid_label || 'Moderate') + '</span>' +
        '<span>' + esc(q.max_label || 'High') + ' (' + gMax + ')</span>' +
      '</div>' +
    '</div>';
  }

  // --------------------------------------------------------------------------
  // Word Cloud & Verbatims Generator
  // --------------------------------------------------------------------------
  function renderWordCloud(q) {
    var cloud = q.word_cloud || [];
    if (!cloud.length) return '<p style="color:#64748b;padding:12px">No text answers recorded yet.</p>';
    var maxCnt = Math.max.apply(null, cloud.map(function (w) { return w.count; })) || 1;

    var tagsHtml = cloud.map(function (item) {
      var size = 11 + Math.round((item.count / maxCnt) * 12);
      return '<span class="theme-tag" style="font-size:' + size + 'px" title="' + item.count + ' occurrences">' +
        esc(item.word) +
        '<span class="theme-tag-count">' + item.count + '</span>' +
      '</span>';
    }).join('');

    return '<div class="word-cloud-container">' + tagsHtml + '</div>';
  }

  function renderVerbatimsList(q) {
    var samples = q.sample_verbatims || [];
    if (!samples.length) return '<p style="color:#64748b;padding:12px">No verbatim comments available.</p>';
    var items = samples.map(function (txt, i) {
      return '<div class="verbatim-quote-card">' +
        '“' + esc(txt) + '”' +
        '<div class="verbatim-quote-meta">Respondent #' + (i + 1) + ' · ' + txt.split(/\s+/).length + ' words</div>' +
      '</div>';
    }).join('');
    return '<div class="verbatim-list">' + items + '</div>';
  }

  // --------------------------------------------------------------------------
  // Standard Bar & Grid Renderers
  // --------------------------------------------------------------------------
  function renderCategoryBars(q, isCut, cut) {
    var html = '';
    if (isCut) {
      html += '<div class="chart-legend">' +
        '<span class="legend-item"><span class="legend-swatch" style="background:#12789e"></span><b>' + esc(cut.segA_label) + '</b> (n=' + cut.segA_n + ')</span>' +
        '<span class="legend-item"><span class="legend-swatch" style="background:#f59e0b"></span><b>' + esc(cut.segB_label) + '</b> (n=' + cut.segB_n + ')</span>' +
        '<span class="legend-item"><span class="sig-star">★</span> Significant (p &lt; ' + (cut.alpha || 0.05) + ')</span>' +
      '</div>';
      html += (q.options || []).map(function (o) {
        var sig = o.sig_test && o.sig_test.significant;
        var sigStar = sig ? '<span class="sig-star" title="Significant: p=' + o.sig_test.p_value + '">★</span><span class="sig-badge">Sig (p=' + o.sig_test.p_value + ')</span>' : '';
        var pA = o.segA_pct || 0, pB = o.segB_pct || 0;
        return '<div class="chart-bar-row">' +
          '<span class="chart-bar-label" title="' + esc(o.label) + '">' + esc(o.label) + '</span>' +
          '<div class="chart-bar-track-wrap">' +
            '<div class="chart-bar-track"><div class="chart-bar-fill" style="width:' + Math.max(0, Math.min(100, pA)) + '%"></div></div>' +
            '<div class="chart-bar-track"><div class="chart-bar-fill seg-b" style="width:' + Math.max(0, Math.min(100, pB)) + '%"></div></div>' +
          '</div>' +
          '<div class="chart-bar-val"><span><b>' + pA + '%</b> (' + (o.segA_count || 0) + ')</span> / <span style="color:#b45309"><b>' + pB + '%</b> (' + (o.segB_count || 0) + ')</span>' + sigStar + '</div>' +
        '</div>';
      }).join('');
    } else {
      html += '<div class="chart-legend"><span class="legend-item"><span class="legend-swatch" style="background:#12789e"></span>Share of total respondents (%)</span></div>';
      html += (q.options || []).map(function (o) {
        var pct = o.pct || 0;
        return '<div class="chart-bar-row">' +
          '<span class="chart-bar-label" title="' + esc(o.label) + '">' + esc(o.label) + '</span>' +
          '<div class="chart-bar-track"><div class="chart-bar-fill" style="width:' + Math.max(0, Math.min(100, pct)) + '%"></div></div>' +
          '<div class="chart-bar-val"><b>' + pct + '%</b> <small style="color:#64748b">(n=' + (o.count != null ? o.count : 0) + ')</small></div>' +
        '</div>';
      }).join('');
    }
    return html;
  }

  function renderRatingBars(rows, sMin, sMax, isCut, cut) {
    var sRange = (sMax - sMin) || 1;
    var html = '';
    if (isCut) {
      html += '<div class="chart-legend">' +
        '<span class="legend-item"><span class="legend-swatch" style="background:#12789e"></span><b>' + esc(cut.segA_label) + '</b> Mean</span>' +
        '<span class="legend-item"><span class="legend-swatch" style="background:#f59e0b"></span><b>' + esc(cut.segB_label) + '</b> Mean</span>' +
        '<span class="legend-item"><span class="sig-star">★</span> Welch’s t-test p &lt; ' + (cut.alpha || 0.05) + '</span>' +
      '</div>';
      html += rows.map(function (r) {
        var mA = r.segA_mean != null ? r.segA_mean : 0;
        var mB = r.segB_mean != null ? r.segB_mean : 0;
        var pctA = Math.max(0, Math.min(100, ((mA - sMin) / sRange) * 100));
        var pctB = Math.max(0, Math.min(100, ((mB - sMin) / sRange) * 100));
        var sig = r.sig_test && r.sig_test.significant;
        var sigStar = sig ? '<span class="sig-star">★</span><span class="sig-badge">Sig (p=' + r.sig_test.p_value + ')</span>' : '';
        return '<div class="chart-bar-row">' +
          '<span class="chart-bar-label" title="' + esc(r.label) + '">' + esc(r.label) + '</span>' +
          '<div class="chart-bar-track-wrap">' +
            '<div class="chart-bar-track"><div class="chart-bar-fill" style="width:' + pctA + '%"></div></div>' +
            '<div class="chart-bar-track"><div class="chart-bar-fill seg-b" style="width:' + pctB + '%"></div></div>' +
          '</div>' +
          '<div class="chart-bar-val"><span><b>' + (r.segA_mean != null ? r.segA_mean : '—') + '</b></span> / <span style="color:#b45309"><b>' + (r.segB_mean != null ? r.segB_mean : '—') + '</b></span>' + sigStar + '</div>' +
        '</div>';
      }).join('');
    } else {
      html += '<div class="chart-legend"><span class="legend-item"><span class="legend-swatch" style="background:#12789e"></span>Mean score on scale ' + sMin + ' - ' + sMax + '</span></div>';
      html += rows.map(function (r) {
        var m = r.mean != null ? r.mean : 0;
        var pct = Math.max(0, Math.min(100, ((m - sMin) / sRange) * 100));
        return '<div class="chart-bar-row">' +
          '<span class="chart-bar-label" title="' + esc(r.label) + '">' + esc(r.label) + '</span>' +
          '<div class="chart-bar-track"><div class="chart-bar-fill" style="width:' + pct + '%"></div></div>' +
          '<div class="chart-bar-val"><b>' + (r.mean != null ? r.mean : '—') + '</b> <small style="color:#64748b">(n=' + (r.base || 0) + ')</small></div>' +
        '</div>';
      }).join('');
    }
    return html;
  }

  function renderCategoryTable(q, isCut, cut) {
    var opts = q.options || [];
    var html = '<table class="st-tbl" style="width:100%;margin:10px 0;font-size:12px"><thead><tr>' +
      '<th>Option</th><th>Count</th><th>Share (%)</th>' +
      (isCut ? '<th>' + esc(cut.segA_label) + '</th><th>' + esc(cut.segB_label) + '</th><th>Sig</th>' : '') +
      '</tr></thead><tbody>';
    html += opts.map(function (o) {
      var sig = o.sig_test && o.sig_test.significant ? '★ (p=' + o.sig_test.p_value + ')' : '—';
      return '<tr>' +
        '<td>' + esc(o.label) + '</td>' +
        '<td>' + (o.count || 0) + '</td>' +
        '<td><b>' + (o.pct || 0) + '%</b></td>' +
        (isCut ? '<td>' + (o.segA_pct || 0) + '% (' + (o.segA_count || 0) + ')</td><td>' + (o.segB_pct || 0) + '% (' + (o.segB_count || 0) + ')</td><td>' + sig + '</td>' : '') +
      '</tr>';
    }).join('');
    html += '</tbody></table>';
    return html;
  }

  // --------------------------------------------------------------------------
  // Main Dispatcher: renderChartContent
  // --------------------------------------------------------------------------
  function renderChartContent(q, isCut, cut, viewType) {
    var t = q.type;
    var view = viewType || activeViews[q.id] || (getAvailableViews(q)[0] || {}).id;

    // 1. Single / Multi Select / Rank
    if (t === 'single_select' || t === 'multi_select' || t === 'rank') {
      if (view === 'column') return renderSvgColumn(q.options || [], isCut, cut);
      if (view === 'donut') return renderSvgDonut(q.options || [], q.base);
      if (view === 'table') return renderCategoryTable(q, isCut, cut);
      return renderCategoryBars(q, isCut, cut);
    }

    // 2. Rating Scale / Grids / Semantic Diff / Emoji Grid
    if ((t === 'rating_scale' || t === 'rating_grid' || t === 'semantic_diff' || t === 'emoji_grid' || t === 'numeric_matrix') || (t === 'gauge_meter' && q.rows)) {
      var sMin = q.scale_min != null ? q.scale_min : 1;
      var sMax = q.scale_max != null ? q.scale_max : 5;
      var rows = q.rows || [];
      if (view === 'radar') return renderSvgRadar(rows, sMin, sMax);
      if (view === 'likert') return renderStackedLikert(rows, sMin, sMax);
      if (view === 'scorecard') return renderScorecard(rows, sMin, sMax);
      return renderRatingBars(rows, sMin, sMax, isCut, cut);
    }

    // 3. Single Gauge Meter
    if (t === 'gauge_meter' && !q.rows) {
      if (view === 'bullet') return renderBulletGraph(q);
      if (view === 'donut') {
        var zones = (q.zones || []).map(function (z) {
          return { label: z.label, pct: z.pct, count: z.count, color: z.cls === 'low' ? '#ef4444' : (z.cls === 'mid' ? '#f59e0b' : '#10b981') };
        });
        return renderSvgDonut(zones, q.base);
      }
      // Default: Dial
      var m = q.mean != null ? q.mean : (q.min || 0);
      var gMin = q.min != null ? q.min : 0;
      var gMax = q.max != null ? q.max : 100;
      var frac = gMax === gMin ? 0.5 : Math.max(0, Math.min(1, (m - gMin) / (gMax - gMin)));
      var rot = (180 + frac * 180) - 90;
      var zList = q.zones || [];
      return '<div class="dashboard-gauge-card">' +
        '<svg class="dash-gauge-svg" viewBox="0 0 240 140">' +
          '<path d="M 25 120 A 95 95 0 0 1 215 120" fill="none" stroke="#e2e8f0" stroke-width="16" stroke-linecap="round"/>' +
          '<path d="M 27 120 A 95 95 0 0 1 103 36" fill="none" stroke="#ef4444" stroke-width="14" opacity="0.85"/>' +
          '<path d="M 106 34 A 95 95 0 0 1 154 39" fill="none" stroke="#f59e0b" stroke-width="14" opacity="0.85"/>' +
          '<path d="M 157 41 A 95 95 0 0 1 213 120" fill="none" stroke="#10b981" stroke-width="14" opacity="0.85"/>' +
          '<g style="transform-origin:120px 120px;transform:rotate(' + rot + 'deg);transition:transform 0.4s ease">' +
            '<polygon points="116,120 124,120 120,38" fill="#0f2b48"/>' +
            '<circle cx="120" cy="120" r="9" fill="#0f2b48"/>' +
            '<circle cx="120" cy="120" r="3" fill="#ffffff"/>' +
          '</g>' +
        '</svg>' +
        '<div class="dash-gauge-readout"><strong class="dash-gauge-val">' + (q.mean != null ? q.mean : '—') + '</strong><span class="dash-gauge-unit">' + esc(q.unit || '%') + '</span></div>' +
        (q.target != null ? '<div style="font-size:11.5px;color:#64748b;margin-top:2px">Target benchmark: <b>' + q.target + esc(q.unit || '%') + '</b></div>' : '') +
        '<div class="dash-zones-strip">' +
          zList.map(function(z) {
            return '<span class="dash-zone-tag ' + (z.cls || 'low') + '"><b>' + esc(z.label) + ':</b> ' + z.pct + '% (n=' + z.count + ')</span>';
          }).join('') +
        '</div>' +
      '</div>';
    }

    // 5. Sum to 100
    if (t === 'sum_to_100') {
      if (view === 'donut') return renderSvgDonut(q.rows || [], q.base);
      return renderRatingBars(q.rows || [], 0, 100, isCut, cut);
    }

    // 6. Open text
    if (t === 'open_text') {
      if (view === 'verbatims') return renderVerbatimsList(q);
      return renderWordCloud(q);
    }

    // 7. Heatmap
    if (t === 'heatmap' && q.heatmap) {
      if (view === 'bar') {
        var hRows = (q.heatmap.rows || []).map(function (r) {
          var cells = (q.heatmap.cells || []).filter(function (c) { return c.row_code === r.code; });
          var mean = cells.length ? (cells.reduce(function (s, c) { return s + (c.mean || 0); }, 0) / cells.length) : 0;
          return { label: r.label, mean: round(mean, 2), base: cells[0] ? cells[0].base : 0 };
        });
        return renderRatingBars(hRows, 0, 3, false, {});
      }
      // Matrix view
      var h = q.heatmap;
      return '<div class="table-scroll" tabindex="0" role="region" aria-label="Heatmap results"><table class="results-heatmap"><thead><tr><th scope="col">Row / column</th>' +
        h.cols.map(function (c) { return '<th scope="col">' + esc(c.label) + '</th>'; }).join('') + '</tr></thead><tbody>' +
        h.rows.map(function (r) {
          return '<tr><th scope="row">' + esc(r.label) + '</th>' +
            h.cols.map(function (c) {
              var cell = h.cells.find(function (x) { return x.row_code === r.code && x.col_code === c.code; }), m = cell ? cell.mean : null;
              var color = m == null ? '#f5f6f4' : m < 1.0 ? '#e8f4fa' : m < 2.0 ? '#bfe3f2' : '#7fc4e0';
              return '<td style="background:' + color + ';color:#153d4c"><strong>' + (m == null ? '—' : esc(m)) + '</strong><small>n = ' + (cell ? cell.base : 0) + '</small></td>';
            }).join('') + '</tr>';
        }).join('') + '</tbody></table></div>';
    }

    // 8. Numeric / Slider / Delta
    if (t === 'numeric' || t === 'slider' || t === 'delta') {
      return '<div style="display:flex;gap:20px;flex-wrap:wrap;font-size:13px;padding:8px 0">' +
        '<div class="metric" style="padding:10px 16px;background:#f8fafc;border-radius:8px"><b>' + (q.mean != null ? q.mean : '—') + '</b><small>Mean</small></div>' +
        '<div class="metric" style="padding:10px 16px;background:#f8fafc;border-radius:8px"><b>' + (q.median != null ? q.median : '—') + '</b><small>Median</small></div>' +
        (q.std_dev != null ? '<div class="metric" style="padding:10px 16px;background:#f8fafc;border-radius:8px"><b>' + q.std_dev + '</b><small>Std Dev</small></div>' : '') +
        (q.min_val != null && q.max_val != null ? '<div class="metric" style="padding:10px 16px;background:#f8fafc;border-radius:8px"><b>' + q.min_val + ' to ' + q.max_val + '</b><small>Range</small></div>' : '') +
      '</div>';
    }

    return '<p style="color:#64748b;padding:8px 0">Visual format: ' + esc(t) + '. Export to PowerPoint for detailed breakdowns.</p>';
  }

  function round(val, dec) {
    var p = Math.pow(10, dec || 2);
    return Math.round(val * p) / p;
  }

  function renderQuestionCard(q, isCut, cut) {
    var views = getAvailableViews(q);
    var curView = activeViews[q.id] || (views[0] || {}).id;

    var toolbarHtml = '';
    if (views.length > 1) {
      toolbarHtml = '<div class="chart-type-toolbar" data-qid="' + esc(q.id) + '">' +
        '<span class="chart-type-label">Chart view:</span>' +
        views.map(function (v) {
          var on = v.id === curView ? ' on' : '';
          return '<button type="button" class="chart-type-btn' + on + '" data-qid="' + esc(q.id) + '" data-view="' + esc(v.id) + '">' + v.label + '</button>';
        }).join('') +
      '</div>';
    }

    return '<section class="panel result-card" id="qcard-' + esc(q.id) + '">' +
      '<h2>' + esc(q.id + ' · ' + q.title) + '</h2>' +
      '<div class="result-meta">Answered base: ' + q.base + ' · Missing/not shown: ' + q.missing_or_not_shown + ' ' + (q.small_base ? '<span class="pill small-base">Small base — interpret cautiously</span>' : '') + '</div>' +
      '<div class="insight-banner"><span class="insight-badge">✦ KEY INSIGHT</span><p class="insight-text">' + esc(q.insight || ('Answered base: ' + q.base)) + '</p></div>' +
      '<div class="chart-box">' +
        toolbarHtml +
        '<div class="chart-render-target" id="chart-target-' + esc(q.id) + '">' +
          renderChartContent(q, isCut, cut, curView) +
        '</div>' +
      '</div>' +
      '<div class="card-footer-actions">' +
        '<span>Format: <b>' + esc((q.type || '').replace('_', ' ')) + '</b></span>' +
        '<button type="button" class="btn sm ghost btn-dl-single-ppt" data-qid="' + esc(q.id) + '">Download slide (PPT) ↓</button>' +
      '</div>' +
    '</section>';
  }

  // Global listeners for chart switching
  document.addEventListener('click', function (e) {
    var b = e.target.closest('.chart-type-btn');
    if (!b) return;
    var qid = b.getAttribute('data-qid');
    var view = b.getAttribute('data-view');
    if (!qid || !view) return;

    activeViews[qid] = view;
    var tb = b.closest('.chart-type-toolbar');
    if (tb) {
      tb.querySelectorAll('.chart-type-btn').forEach(function (btn) {
        btn.classList.toggle('on', btn.getAttribute('data-view') === view);
      });
    }

    var target = document.getElementById('chart-target-' + qid);
    var data = global.__currentAnalysisData;
    if (target && data && data.questions) {
      var q = data.questions.find(function (item) { return item.id === qid; });
      if (q) {
        var isCut = data.data_cut && data.data_cut.active;
        var cut = data.data_cut || {};
        target.innerHTML = renderChartContent(q, isCut, cut, view);
      }
    }
  });

  global.AnakingCharts = {
    getAvailableViews: getAvailableViews,
    renderChartContent: renderChartContent,
    renderQuestionCard: renderQuestionCard,
    setActiveView: function (qid, view) { activeViews[qid] = view; }
  };

})(window);
