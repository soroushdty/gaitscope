/* Step detector core: file parsing, schema validation, step detection.
   Pure functions, no DOM. Runs in the browser and in Node for testing. */
(function (root) {
  'use strict';

  const MAX_BYTES = 50 * 1024 * 1024;
  const MAX_CHANNELS = 40;
  const MIN_ROWS = 20;

  class InputError extends Error {
    constructor(message, fix) { super(message); this.fix = fix || ''; }
  }

  /* ---------------------------------------------------------------- MAT v5 */
  const MI = { INT8: 1, UINT8: 2, INT16: 3, UINT16: 4, INT32: 5, UINT32: 6, SINGLE: 7,
    DOUBLE: 9, INT64: 12, UINT64: 13, MATRIX: 14, COMPRESSED: 15, UTF8: 16, UTF16: 17, UTF32: 18 };
  const CLASS = { 1: 'cell', 2: 'struct', 3: 'object', 4: 'char', 5: 'sparse', 6: 'double',
    7: 'single', 8: 'int8', 9: 'uint8', 10: 'int16', 11: 'uint16', 12: 'int32', 13: 'uint32',
    14: 'int64', 15: 'uint64', 16: 'function', 17: 'opaque' };
  const NUMERIC_CLASSES = new Set([6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
  const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 2, 5: 4, 6: 4, 7: 4, 9: 8, 12: 8, 13: 8, 16: 1, 17: 2, 18: 4 };

  function latin1(u8) {
    let s = '';
    for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    return s;
  }

  function looksLikeText(u8) {
    const n = Math.min(u8.length, 2048);
    if (n === 0) return false;
    let printable = 0;
    for (let i = 0; i < n; i++) {
      const c = u8[i];
      if (c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127)) printable++;
    }
    return printable / n > 0.97;
  }

  function isHDF5(u8) {
    const sig = [0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a];
    for (const off of [0, 512, 1024, 2048]) {
      if (u8.length < off + 8) break;
      let ok = true;
      for (let i = 0; i < 8; i++) if (u8[off + i] !== sig[i]) { ok = false; break; }
      if (ok) return true;
    }
    return false;
  }

  function looksLikeV4(dv) {
    if (dv.byteLength < 20) return false;
    for (const le of [true, false]) {
      const mopt = dv.getInt32(0, le), mrows = dv.getInt32(4, le), ncols = dv.getInt32(8, le);
      const imagf = dv.getInt32(12, le), namlen = dv.getInt32(16, le);
      if (mopt >= 0 && mopt <= 4052 && mrows >= 0 && ncols >= 0 && (imagf === 0 || imagf === 1) &&
          namlen > 0 && namlen < 64) return true;
    }
    return false;
  }

  function readTag(dv, off, end, le) {
    if (off + 8 > end) throw new InputError('The MAT-file is truncated or corrupted.', 'Re-save or re-download the file and try again.');
    const w0 = dv.getUint32(off, le);
    if ((w0 >>> 16) !== 0) {
      return { type: w0 & 0xffff, nbytes: w0 >>> 16, dataOff: off + 4, next: off + 8 };
    }
    const nbytes = dv.getUint32(off + 4, le);
    const pad = w0 === MI.COMPRESSED ? 0 : (8 - (nbytes % 8)) % 8;
    if (off + 8 + nbytes > end) throw new InputError('The MAT-file is truncated or corrupted.', 'Re-save or re-download the file and try again.');
    return { type: w0, nbytes, dataOff: off + 8, next: off + 8 + nbytes + pad };
  }

  function readNumeric(dv, type, off, nbytes, le) {
    const size = TYPE_SIZE[type];
    if (!size) throw new InputError('The MAT-file uses a data type this reader does not support (' + type + ').', "Re-save the variable as double: A = double(A); save('file.mat','A','-v7').");
    const n = Math.floor(nbytes / size);
    const out = new Float64Array(n);
    switch (type) {
      case MI.INT8: for (let i = 0; i < n; i++) out[i] = dv.getInt8(off + i); break;
      case MI.UINT8: case MI.UTF8: for (let i = 0; i < n; i++) out[i] = dv.getUint8(off + i); break;
      case MI.INT16: for (let i = 0; i < n; i++) out[i] = dv.getInt16(off + 2 * i, le); break;
      case MI.UINT16: case MI.UTF16: for (let i = 0; i < n; i++) out[i] = dv.getUint16(off + 2 * i, le); break;
      case MI.INT32: for (let i = 0; i < n; i++) out[i] = dv.getInt32(off + 4 * i, le); break;
      case MI.UINT32: case MI.UTF32: for (let i = 0; i < n; i++) out[i] = dv.getUint32(off + 4 * i, le); break;
      case MI.SINGLE: for (let i = 0; i < n; i++) out[i] = dv.getFloat32(off + 4 * i, le); break;
      case MI.DOUBLE: for (let i = 0; i < n; i++) out[i] = dv.getFloat64(off + 8 * i, le); break;
      case MI.INT64: for (let i = 0; i < n; i++) out[i] = Number(dv.getBigInt64(off + 8 * i, le)); break;
      case MI.UINT64: for (let i = 0; i < n; i++) out[i] = Number(dv.getBigUint64(off + 8 * i, le)); break;
    }
    return out;
  }

  function readString(dv, tag) {
    const u8 = new Uint8Array(dv.buffer, dv.byteOffset + tag.dataOff, tag.nbytes);
    return latin1(u8).replace(/\0+$/, '');
  }

  function parseMatrix(dv, start, nbytes, le, depth) {
    if (nbytes === 0) return null;
    const end = start + nbytes;
    let off = start;
    const flagsTag = readTag(dv, off, end, le);
    const flags = dv.getUint32(flagsTag.dataOff, le);
    const clsId = flags & 0xff;
    const v = { cls: CLASS[clsId] || ('class ' + clsId), clsId,
      complex: !!(flags & 0x0800), logical: !!(flags & 0x0200), name: '', dims: [] };
    off = flagsTag.next;

    if (clsId === 17) {
      // MATLAB objects (table, timetable, string, datetime): name, type system, class name.
      try {
        const nameTag = readTag(dv, off, end, le); v.name = readString(dv, nameTag); off = nameTag.next;
        const sysTag = readTag(dv, off, end, le); off = sysTag.next;
        const clsTag = readTag(dv, off, end, le); v.className = readString(dv, clsTag);
      } catch (e) { /* keep what we have */ }
      return v;
    }

    const dimsTag = readTag(dv, off, end, le);
    v.dims = Array.from(readNumeric(dv, dimsTag.type, dimsTag.dataOff, dimsTag.nbytes, le));
    off = dimsTag.next;
    const nameTag = readTag(dv, off, end, le);
    v.name = readString(dv, nameTag);
    off = nameTag.next;
    const numel = v.dims.reduce((a, b) => a * b, 1);

    if (NUMERIC_CLASSES.has(clsId) || clsId === 4) {
      const re = readTag(dv, off, end, le);
      v.data = readNumeric(dv, re.type, re.dataOff, re.nbytes, le);
      if (v.data.length !== numel && clsId !== 4) {
        throw new InputError('Variable "' + v.name + '" has inconsistent size information.', 'Re-save the file from MATLAB and try again.');
      }
      if (clsId === 4) v.text = String.fromCharCode.apply(null, Array.from(v.data.slice(0, 2000)));
    } else if (clsId === 2 && depth < 3) {
      const fnlTag = readTag(dv, off, end, le);
      const fnl = readNumeric(dv, fnlTag.type, fnlTag.dataOff, fnlTag.nbytes, le)[0];
      off = fnlTag.next;
      const fnTag = readTag(dv, off, end, le);
      const raw = new Uint8Array(dv.buffer, dv.byteOffset + fnTag.dataOff, fnTag.nbytes);
      const names = [];
      for (let i = 0; i + fnl <= raw.length; i += fnl) names.push(latin1(raw.subarray(i, i + fnl)).replace(/\0.*$/, ''));
      off = fnTag.next;
      v.fields = {};
      for (let e = 0; e < numel; e++) {
        for (const fname of names) {
          const t = readTag(dv, off, end, le);
          const child = t.type === MI.MATRIX ? parseMatrix(dv, t.dataOff, t.nbytes, le, depth + 1) : null;
          if (e === 0) v.fields[fname] = child;
          off = t.next;
        }
      }
      v.structCount = numel;
    }
    // cell, sparse, object, function: recorded by class only
    return v;
  }

  function parseElements(dv, off, end, le, out, inflate, depth) {
    while (off + 8 <= end) {
      const tag = readTag(dv, off, end, le);
      if (tag.type === MI.COMPRESSED) {
        if (!inflate) throw new InputError('This MAT-file is compressed and the decompressor did not load.', 'Check your internet connection and reload the page.');
        let raw;
        try {
          raw = inflate(new Uint8Array(dv.buffer, dv.byteOffset + tag.dataOff, tag.nbytes));
        } catch (e) {
          throw new InputError('A compressed block in the MAT-file could not be decompressed; the file is probably corrupted.', 'Re-save or re-download the file.');
        }
        const inner = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
        if (depth < 2) parseElements(inner, 0, raw.byteLength, le, out, inflate, depth + 1);
      } else if (tag.type === MI.MATRIX) {
        const v = parseMatrix(dv, tag.dataOff, tag.nbytes, le, 0);
        if (v) out.push(v);
      }
      off = tag.next;
    }
  }

  function parseMat(u8, inflate) {
    if (looksLikeText(u8)) {
      throw new InputError('This file is plain text, not a binary MATLAB file.', 'If it contains comma- or tab-separated numbers, rename it to .csv and upload again.');
    }
    if (u8.length < 128) {
      throw new InputError('The file is too small to be a MATLAB .mat file.', 'Check that you uploaded the right file.');
    }
    const head = latin1(u8.subarray(0, 116)).replace(/\0+$/, '');
    if (/MATLAB 7\.3/.test(head) || isHDF5(u8)) {
      throw new InputError('This is a MATLAB v7.3 file (HDF5 format), which a web page cannot read.',
        "In MATLAB, re-save it in the standard format: save('myfile.mat','-v7'). Or export the data as CSV.");
    }
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    if (!/^MATLAB 5\.0 MAT-file/.test(head)) {
      if (looksLikeText(u8)) {
        throw new InputError('This file is plain text, not a binary MATLAB file.', 'If it contains comma- or tab-separated numbers, rename it to .csv and upload again.');
      }
      if (looksLikeV4(dv)) {
        throw new InputError('This is an old MATLAB v4 MAT-file, which this page does not read.', "In MATLAB, load it and re-save with save('myfile.mat','-v7').");
      }
      throw new InputError('This does not look like a MATLAB .mat file.', 'Upload a .mat file saved from MATLAB or Octave, or a CSV export.');
    }
    const ei = String.fromCharCode(u8[126], u8[127]);
    if (ei !== 'IM' && ei !== 'MI') throw new InputError('The MAT-file header is damaged (unknown byte order).', 'Re-save or re-download the file.');
    const le = ei === 'IM';
    const vars = [];
    parseElements(dv, 128, u8.length, le, vars, inflate, 0);
    return { header: head.trim(), variables: vars.filter(v => v.name && !v.name.startsWith('__')) };
  }

  /* Walk parsed variables and list numeric matrices that could hold sensor data. */
  function matCandidates(vars) {
    const cands = [], notes = [];
    function visit(v, path) {
      if (!v) return;
      if (v.clsId === 17) {
        const cn = v.className || 'object';
        const fix = cn === 'table' ? 'A = table2array(' + v.name + ');' :
          cn === 'timetable' ? 'A = table2array(timetable2table(' + v.name + '));' : 'A = double(' + v.name + ');';
        notes.push({ path, reason: '"' + path + '" is a MATLAB ' + cn + ', which only MATLAB itself can read.',
          fix: "In MATLAB: " + fix + " save('myfile.mat','A','-v7')" });
        return;
      }
      if (v.clsId === 2) {
        if (v.structCount > 1) notes.push({ path, reason: '"' + path + '" is a struct array; only its first element was searched.' });
        for (const [k, child] of Object.entries(v.fields || {})) if (child) visit(child, path + '.' + k);
        return;
      }
      if (v.clsId === 1) { notes.push({ path, reason: '"' + path + '" is a cell array, which is not searched.', fix: 'In MATLAB: A = cell2mat(' + path + ');' }); return; }
      if (v.clsId === 5) { notes.push({ path, reason: '"' + path + '" is a sparse matrix.', fix: 'In MATLAB: A = full(' + path + ');' }); return; }
      if (v.clsId === 4 || v.clsId === 16 || v.clsId === 3) return;
      if (!NUMERIC_CLASSES.has(v.clsId)) return;
      const dims = v.dims;
      const c = { path, dims, cls: v.cls, var: v, ok: true, reason: '' };
      if (v.logical) { c.ok = false; c.reason = 'contains true/false values, not measurements'; }
      else if (v.complex) { c.ok = false; c.reason = 'contains complex numbers'; }
      else if (dims.length > 2 && dims.slice(2).some(d => d > 1)) { c.ok = false; c.reason = 'is ' + dims.length + '-dimensional; expected a 2-D matrix'; }
      else if (dims[0] * dims[1] === 0) { c.ok = false; c.reason = 'is empty'; }
      else if (Math.max(dims[0], dims[1]) < MIN_ROWS) { c.ok = false; c.reason = 'is too small (' + dims.join('×') + ')'; }
      else if (Math.min(dims[0], dims[1]) > MAX_CHANNELS) { c.ok = false; c.reason = 'is ' + dims.join('×') + ', which does not look like samples × a few channels'; }
      cands.push(c);
    }
    for (const v of vars) visit(v, v.name);
    return { cands, notes };
  }

  /* Turn a numeric MAT variable into columns (samples down the rows). */
  function matToColumns(cand) {
    let [r, c] = cand.dims;
    const d = cand.var.data;
    let transposed = false;
    if (c > r) transposed = true;
    const nSamp = transposed ? c : r, nCh = transposed ? r : c;
    const cols = [];
    for (let k = 0; k < nCh; k++) {
      const col = new Float64Array(nSamp);
      for (let i = 0; i < nSamp; i++) col[i] = transposed ? d[k + i * r] : d[i + k * r];
      cols.push(col);
    }
    return { cols, transposed, origDims: cand.dims };
  }

  /* ------------------------------------------------------------------ CSV */
  function parseNumberToken(tok, decimalComma) {
    let s = tok.trim().replace(/^"|"$/g, '');
    if (s === '') return NaN;
    const clock = s.match(/^(\d{1,2}):(\d{2}):(\d{2})(?:[:.](\d+))?$/);
    if (clock) {
      const frac = clock[4] ? Number(clock[4]) / Math.pow(10, clock[4].length) : 0;
      return { clock: Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3]) + frac };
    }
    if (decimalComma) s = s.replace(',', '.');
    if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) {
      if (/^[+-]?(inf|infinity)$/i.test(s)) return s[0] === '-' ? -Infinity : Infinity;
      if (/^nan$/i.test(s)) return NaN;
      return null; // not a number
    }
    return Number(s);
  }

  function parseCsv(text) {
    text = text.replace(/^\uFEFF/, '');
    // Physics Toolbox (newer versions) starts with '# key: value' metadata lines; skip them.
    const lines = text.split(/\r\n|\n|\r/).filter(l => l.trim() !== '' && !l.trimStart().startsWith('#'));
    if (lines.length < 2) throw new InputError('The CSV file has fewer than 2 lines of data.', 'Record for longer, or check that the export completed.');
    const sample = lines.slice(0, Math.min(lines.length, 12));
    // Prefer a delimiter that splits every sampled line (header included) into the same number of fields.
    let delim = null, bestFields = 1;
    for (const d of ['\t', ';', ',']) {
      const counts = sample.map(l => l.split(d).length);
      if (counts.every(c => c === counts[0]) && counts[0] > bestFields) { bestFields = counts[0]; delim = d; }
    }
    if (!delim) {
      let best = -1;
      for (const d of [',', ';', '\t']) {
        const min = Math.min(...sample.map(l => l.split(d).length - 1));
        if (min > best) { best = min; delim = d; }
      }
    }
    const decimalComma = delim === ';' && sample.slice(1).some(l => /\d,\d/.test(l));
    const isNumericLine = l => {
      const toks = l.split(delim);
      const nums = toks.filter(t => { const v = parseNumberToken(t, decimalComma); return v !== null; }).length;
      return nums / toks.length >= 0.6;
    };
    let headerIdx = -1;
    for (let i = 0; i < Math.min(lines.length - 1, 15); i++) {
      if (!isNumericLine(lines[i]) && isNumericLine(lines[i + 1])) { headerIdx = i; break; }
      if (isNumericLine(lines[i])) break;
    }
    const headers = headerIdx >= 0 ? lines[headerIdx].split(delim).map(h => h.trim().replace(/^"|"$/g, '')) : null;
    const body = lines.slice(headerIdx + 1);
    const nCol = Math.max(...body.slice(0, 50).map(l => l.split(delim).length), headers ? headers.length : 0);
    const cols = Array.from({ length: nCol }, () => new Float64Array(body.length));
    const bad = new Array(nCol).fill(0), clockCol = new Array(nCol).fill(0);
    body.forEach((l, i) => {
      const toks = l.split(delim);
      for (let k = 0; k < nCol; k++) {
        const v = k < toks.length ? parseNumberToken(toks[k], decimalComma) : NaN;
        if (v === null) { bad[k]++; cols[k][i] = NaN; }
        else if (typeof v === 'object') { clockCol[k]++; cols[k][i] = v.clock; }
        else cols[k][i] = v;
      }
    });
    const names = [], keep = [], dropped = [];
    for (let k = 0; k < nCol; k++) {
      const name = headers && headers[k] ? headers[k] : 'Column ' + (k + 1);
      if (bad[k] > body.length * 0.5) { dropped.push(name); continue; }
      if (headers && headers[k] === '' && cols[k].every(Number.isNaN)) continue;
      names.push(name); keep.push(cols[k]);
    }
    return { names, cols: keep, hasHeader: !!headers, delim, decimalComma, dropped,
      clockTime: clockCol.some(c => c > body.length * 0.5) };
  }

  /* -------------------------------------------------------- column roles */
  const RX = {
    time: /^(time|t|elapsed|timestamp|seconds|sec)\b/i,
    x: /^(gfx|ax|wx|bx|mx|x|acc_?x|accel_?x|acceleration_?x|lin_?acc_?x)\b/i,
    y: /^(gfy|ay|wy|by|my|y|acc_?y|accel_?y|acceleration_?y|lin_?acc_?y)\b/i,
    z: /^(gfz|az|wz|bz|mz|z|acc_?z|accel_?z|acceleration_?z|lin_?acc_?z)\b/i,
    mag: /^(tgf|at|wt|bt|total|magnitude|mag|norm|a_?total|resultant)\b/i,
  };

  function sensorFromName(name) {
    name = name.replace(/\s*\(.*\)\s*$/, ''); // 'ax (m/s^2)' -> 'ax'
    if (/^(gf[xyz]|tgf)$/i.test(name)) return { key: 'gforce', label: 'G-Force Meter', unit: 'g', gravity: true, accel: true };
    if (/^(a[xyzt])$/i.test(name)) return { key: 'linacc', label: 'Linear accelerometer', unit: 'm/s²', gravity: false, accel: true };
    if (/^(w[xyzt])$/i.test(name)) return { key: 'gyro', label: 'Gyroscope', unit: 'rad/s', gravity: false, accel: false };
    if (/^(b[xyzt]|m[xyz])$/i.test(name)) return { key: 'mag', label: 'Magnetometer', unit: 'µT', gravity: false, accel: false };
    return null;
  }

  function strictlyIncreasingShare(a) {
    let pos = 0, neg = 0, n = 0;
    for (let i = 1; i < a.length; i++) {
      if (Number.isNaN(a[i]) || Number.isNaN(a[i - 1])) continue;
      const d = a[i] - a[i - 1];
      n++; if (d > 0) pos++; else if (d < 0) neg++;
    }
    return { pos: n ? pos / n : 0, neg };
  }

  function median(arr) {
    const a = Array.from(arr).filter(v => !Number.isNaN(v)).sort((p, q) => p - q);
    if (!a.length) return NaN;
    const m = a.length >> 1;
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }
  function mean(a) { let s = 0, n = 0; for (const v of a) if (!Number.isNaN(v)) { s += v; n++; } return n ? s / n : NaN; }
  function std(a) { // N-1, like MATLAB
    const m = mean(a); let s = 0, n = 0;
    for (const v of a) if (!Number.isNaN(v)) { s += (v - m) ** 2; n++; }
    return n > 1 ? Math.sqrt(s / (n - 1)) : NaN;
  }

  /* Build a dataset: {columns:[{name,label,data,role,sensor}], time, info} and dataset-level checks. */
  function buildDataset(names, cols, source, opts) {
    opts = opts || {};
    const checks = [];
    const n = cols[0].length;
    const columns = cols.map((data, k) => ({
      index: k, name: names[k], matCol: source === 'mat' ? k + 1 : null, data, role: 'signal', sensor: sensorFromName(names[k]),
    }));

    // time column
    let timeCol = null, reordered = 0;
    const byName = source === 'csv' ? columns.find(c => RX.time.test(c.name)) : null;
    const candidate = byName || columns[0];
    if (columns.length > 1 || byName) {
      const inc = strictlyIncreasingShare(candidate.data);
      if (byName || (inc.pos > 0.95 && inc.neg === 0)) {
        if (inc.neg > 0 && byName) {
          const tc = candidate.data, dpos = [];
          let row = -1, maxBack = 0;
          for (let i = 1; i < n; i++) {
            const d = tc[i] - tc[i - 1];
            if (d > 0) dpos.push(d);
            if (d < 0 && -d > maxBack) { maxBack = -d; row = i; }
          }
          const md = median(dpos);
          if (maxBack > Math.max(1, 20 * md)) {
            throw new InputError('The time column jumps backwards by ' + maxBack.toFixed(2) + ' s at row ' + (row + 1) + '.',
              'This usually means two recordings were joined into one file. Split them and upload each separately.');
          }
          // Small reversals (interleaved sensors): sort rows by time.
          const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => (tc[a] - tc[b]) || (a - b));
          for (const c of columns) c.data = Float64Array.from(order, i => c.data[i]);
          reordered = inc.neg;
        }
        if (inc.pos > 0.5) { timeCol = candidate; candidate.role = 'time'; }
      }
    }

    let t = null, timeUnitNote = '';
    if (timeCol) {
      t = Float64Array.from(timeCol.data);
      const t0 = t.find(v => !Number.isNaN(v));
      for (let i = 0; i < n; i++) t[i] -= t0;
      const dts = [];
      for (let i = 1; i < n; i++) { const d = t[i] - t[i - 1]; if (d > 0) dts.push(d); }
      let md = median(dts);
      if (md >= 1 && 1000 / md >= 5 && 1000 / md <= 2000) {
        for (let i = 0; i < n; i++) t[i] /= 1000;
        timeUnitNote = 'Time values looked like milliseconds, so they were converted to seconds.';
      }
      checks.push({ level: 'pass', title: 'Time column found', detail: (source === 'mat' ? 'Column 1' : '"' + timeCol.name + '"') + ' increases steadily, so it is used as time.' + (timeUnitNote ? ' ' + timeUnitNote : '') });
      if (reordered) checks.push({ level: 'warn', title: 'Rows put back in time order', detail: reordered + ' rows were slightly out of time order (common when several sensors are recorded together) and were sorted by time.' });
    } else {
      checks.push({ level: 'info', title: 'No time column', detail: 'No column increases steadily, so time is computed from the sampling rate you set (default 100 Hz).' });
    }

    const chans = columns.filter(c => c.role !== 'time');
    if (!chans.length) throw new InputError('The file has a time column but no signal columns.', 'Export at least one sensor channel along with time.');

    // xyz + magnitude roles
    const named = r => chans.find(c => RX[r].test(c.name) && (!c.sensor || true));
    let x = null, y = null, z = null, mag = null;
    if (source === 'csv') {
      // group by sensor: pick the first sensor group with x/y/z
      for (const c of chans) {
        if (RX.x.test(c.name) && !x) x = c;
        else if (RX.y.test(c.name) && !y && (!x || sameSensor(x, c))) y = c;
        else if (RX.z.test(c.name) && !z && (!x || sameSensor(x, c))) z = c;
      }
      mag = chans.find(c => RX.mag.test(c.name) && (!x || sameSensor(x, c))) || null;
    } else if (chans.length >= 3) {
      [x, y, z] = chans;
      if (chans.length >= 4) {
        const cand = chans[3];
        let maxErr = 0, maxVal = 0, cnt = 0;
        for (let i = 0; i < n; i++) {
          const m = Math.hypot(x.data[i], y.data[i], z.data[i]);
          if (Number.isNaN(m) || Number.isNaN(cand.data[i])) continue;
          maxErr = Math.max(maxErr, Math.abs(m - cand.data[i])); maxVal = Math.max(maxVal, Math.abs(m)); cnt++;
        }
        if (cnt > 10 && maxErr <= 0.02 * maxVal + 0.011) mag = cand;
      }
    }
    if (x && y && z) { x.role = 'x'; y.role = 'y'; z.role = 'z'; }
    if (mag) mag.role = 'mag';

    for (const c of columns) c.label = labelFor(c, source);

    if (x && y && z) {
      checks.push({ level: 'pass', title: 'Axes identified', detail: [x, y, z].map(c => c.role + ' = ' + (source === 'mat' ? 'column ' + c.matCol : c.name)).join(', ') + '.' +
        (mag ? ' ' + (source === 'mat' ? 'Column ' + mag.matCol : '"' + mag.name + '"') + ' matches √(x²+y²+z²), so it is the total magnitude.' : '') });
    } else {
      checks.push({ level: 'info', title: 'Generic columns', detail: 'The column layout is not a recognised x/y/z recording, so columns keep generic names. Every column can still be analysed.' });
    }

    // units
    const units = inferUnits({ x, y, z, mag, t, n, fsGuess: 100 });
    if (units) checks.push(units);

    return { columns, t, x, y, z, mag, n, checks, source };

    function sameSensor(a, b) {
      const sa = a.sensor, sb = b.sensor;
      return !sa || !sb || sa.key === sb.key;
    }
  }

  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  function labelFor(c, source) {
    const role = { x: 'x', y: 'y', z: 'z', mag: 'magnitude', time: 'time' }[c.role];
    if (source === 'mat') return (role ? role + ' ' : '') + '(column ' + c.matCol + ')';
    if (c.role === 'time') return c.name;
    // drop a unit suffix ('ax (m/s^2)' -> 'ax') when the sensor is known; the plot axis adds the unit
    const name = c.sensor ? c.name.replace(/\s*\(.*\)\s*$/, '') : c.name;
    return role ? (name.toLowerCase() === role ? role : role + ' (' + name + ')') : name + (c.sensor ? ' (' + c.sensor.label.toLowerCase() + ')' : '');
  }

  /* Guess units from the quietest one-second stretch of the magnitude. */
  function inferUnits(ds) {
    const { x, y, z, mag, n } = ds;
    const sensor = (x && x.sensor) || (mag && mag.sensor);
    if (sensor) {
      const lvl = sensor.accel ? 'info' : 'warn';
      const extra = sensor.accel
        ? (sensor.gravity ? ' Includes gravity: an upright phone reads about 1 g on one axis, so the lab threshold h = 1 sits right at the resting level.' : ' Gravity is removed, so a still phone reads near 0.')
        : ' This sensor does not measure acceleration. Steps may still show up as peaks, but the lab threshold h = 1 has no physical meaning here.';
      return { level: lvl, title: 'Units: ' + sensor.unit, detail: sensor.label + ' data (from the column names).' + extra };
    }
    if (!(x && y && z)) return null;
    const m = new Float64Array(n);
    for (let i = 0; i < n; i++) m[i] = mag ? mag.data[i] : Math.hypot(x.data[i], y.data[i], z.data[i]);
    const win = Math.max(20, Math.min(100, Math.floor(n / 10)));
    let best = null;
    for (let s = 0; s + win <= n; s += Math.max(1, win >> 2)) {
      const seg = m.subarray(s, s + win);
      const sd = std(seg);
      if (!Number.isNaN(sd) && (!best || sd < best.sd)) best = { sd, mu: mean(seg) };
    }
    if (!best) return null;
    const ratio = best.mu / (best.sd || 1e-9);
    if (ratio > 8) {
      if (best.mu > 0.8 && best.mu < 1.25) return { level: 'info', title: 'Units: probably g (with gravity)', detail: 'At rest the magnitude is about ' + best.mu.toFixed(2) + ', which matches 1 g. The lab threshold h = 1 is at the resting level, so check detections carefully.' };
      if (best.mu > 8.5 && best.mu < 11) return { level: 'info', title: 'Units: probably m/s² (with gravity)', detail: 'At rest the magnitude is about ' + best.mu.toFixed(1) + ', which matches 9.8 m/s².' };
      return { level: 'warn', title: 'Units unclear', detail: 'The resting magnitude is ' + best.mu.toFixed(2) + ', which matches neither 1 g nor 9.8 m/s². Check how the data was recorded before trusting the threshold h.' };
    }
    return { level: 'info', title: 'Units: gravity removed', detail: 'The quietest stretch averages ' + best.mu.toFixed(2) + ' with noise of similar size, which is typical of linear acceleration (gravity subtracted), most likely in m/s².' };
  }

  /* Vertical and horizontal acceleration from x, y, z (#35). Gravity's direction is x, y, z
     low-passed at 0.3 Hz: slow enough to ignore the steps, fast enough to follow the phone
     tilting in a pocket. Each sample is projected onto that direction and the size of
     gravity subtracted, so standing still reads 0 whatever the tilt (vertical); what is left
     over, as a magnitude, is forward and sideways sway (horizontal). Needs gravity in the
     data: the sensor name decides when the file has one (G-Force yes, Linear Accelerometer
     no); otherwise gravity must be a steady vector, at least 2× the motion around it and
     varying by under 15%. Measured on the owner's recordings: G-Force 4.8× and 3%; every
     gravity-removed file under 0.6× and over 35%. Returns {ok, reason?, vertical,
     horizontal, gravity} (arrays over all rows, NaN where x, y, z or t is missing),
     cached on the dataset per sampling rate. */
  const GRAVITY_CUTOFF = 0.3, GRAVITY_RATIO = 2, GRAVITY_CV = 0.15;
  function datasetRate(ds, fsManual) {
    if (!ds.t) return fsManual || 100;
    const dts = [];
    for (let i = 1; i < ds.n; i++) { const d = ds.t[i] - ds.t[i - 1]; if (d > 0) dts.push(d); }
    return 1 / median(dts);
  }
  function gravitySplit(ds, fsManual) {
    const fs = datasetRate(ds, fsManual);
    if (ds._gravity && ds._gravity.fs === fs) return ds._gravity;
    const out = r => (ds._gravity = Object.assign({ fs }, r));
    const axes = [ds.x, ds.y, ds.z];
    if (!axes.every(Boolean)) return out({ ok: false, reason: 'needs x, y and z' });
    const sensor = ds.x.sensor;
    if (sensor && !sensor.accel) return out({ ok: false, reason: 'x, y, z are not acceleration (' + sensor.label + ')' });
    if (sensor && !sensor.gravity) return out({ ok: false, reason: 'gravity was removed in this recording (' + sensor.label + ')' });
    const rows = [];
    for (let i = 0; i < ds.n; i++) if (axes.every(c => Number.isFinite(c.data[i])) && (!ds.t || Number.isFinite(ds.t[i]))) rows.push(i);
    if (rows.length < MIN_ROWS) return out({ ok: false, reason: 'too few rows with x, y and z' });
    const a = axes.map(c => Float64Array.from(rows, i => c.data[i]));
    const g = a.map(v => lowpass(v, fs, GRAVITY_CUTOFF));
    const m = rows.length, gMag = new Float64Array(m), dyn = new Float64Array(m);
    for (let k = 0; k < m; k++) {
      gMag[k] = Math.hypot(g[0][k], g[1][k], g[2][k]);
      dyn[k] = Math.hypot(a[0][k] - g[0][k], a[1][k] - g[1][k], a[2][k] - g[2][k]);
    }
    const gravity = median(gMag), motion = Math.sqrt(mean(Array.from(dyn, v => v * v))), cv = std(gMag) / mean(gMag);
    if (!sensor && !(gravity >= GRAVITY_RATIO * motion && cv < GRAVITY_CV)) {
      return out({ ok: false, reason: 'no steady gravity in x, y, z (it looks removed)' });
    }
    const vertical = new Float64Array(ds.n).fill(NaN), horizontal = new Float64Array(ds.n).fill(NaN);
    rows.forEach((i, k) => {
      const ux = g[0][k] / gMag[k], uy = g[1][k] / gMag[k], uz = g[2][k] / gMag[k];
      const along = a[0][k] * ux + a[1][k] * uy + a[2][k] * uz;
      vertical[i] = along - gMag[k];
      horizontal[i] = Math.hypot(a[0][k] - along * ux, a[1][k] - along * uy, a[2][k] - along * uz);
    });
    return out({ ok: true, vertical, horizontal, gravity });
  }

  /* Channel-level validation + cleaning. Returns {A, t, fs, checks, fatal} */
  function prepareChannel(ds, colIndex, fsManual) {
    const checks = [];
    const col = typeof colIndex === 'string' ? null : ds.columns[colIndex];
    const n = ds.n;
    let raw;
    if (colIndex === 'computed') {
      raw = new Float64Array(n);
      for (let i = 0; i < n; i++) raw[i] = Math.hypot(ds.x.data[i], ds.y.data[i], ds.z.data[i]);
    } else if (colIndex === 'vertical' || colIndex === 'horizontal') {
      const gs = gravitySplit(ds, fsManual);
      if (!gs.ok) return { fatal: true, checks: [{ level: 'error', title: cap(colIndex) + ' acceleration not available', detail: 'It ' + gs.reason + '.', fix: 'Pick another signal, or record with the G-Force Meter, which keeps gravity.' }] };
      raw = gs[colIndex];
      checks.push(colIndex === 'vertical'
        ? { level: 'info', title: 'Vertical acceleration from the direction of gravity', detail: 'Gravity is x, y, z low-passed at ' + GRAVITY_CUTOFF + ' Hz (' + fmt(gs.gravity, 2) + ' on average). Each sample is projected onto it and gravity is subtracted, so standing still reads 0 whatever the phone\u2019s tilt. Coza and the lab code compare peaks with h, which then belongs a little above 0 (about 0.1 g or 1 m/s\u00b2), not at 1.' }
        : { level: 'info', title: 'Horizontal acceleration from the direction of gravity', detail: 'What is left after the vertical part (along gravity, x, y, z low-passed at ' + GRAVITY_CUTOFF + ' Hz) is removed, as a magnitude: forward and sideways sway.' });
    } else raw = col.data;

    let keep = [];
    let nBad = 0;
    for (let i = 0; i < n; i++) {
      const ok = Number.isFinite(raw[i]) && (!ds.t || Number.isFinite(ds.t[i]));
      if (ok) keep.push(i); else nBad++;
    }
    let A, t, fs;
    if (ds.t) {
      A = Float64Array.from(keep, i => raw[i]);
      t = Float64Array.from(keep, i => ds.t[i]);
      if (nBad) {
        const frac = nBad / n;
        checks.push({ level: frac > 0.2 ? 'info' : 'warn', title: nBad + ' empty or invalid rows skipped',
          detail: frac > 0.2 ? 'This channel is blank in ' + Math.round(frac * 100) + '% of rows, which is typical of multi-sensor recordings where sensors take turns. Only rows with data for this channel are used, and the timestamps keep the timing correct.'
            : 'Rows with missing or non-numeric values were dropped. The timestamps keep the timing correct.' });
      }
    } else {
      if (nBad / n > 0.01) {
        return { fatal: true, checks: [{ level: 'error', title: Math.round(nBad / n * 100) + '% of values are missing', detail: 'Without a time column, gaps cannot be skipped safely and more than 1% is too many to fill in.', fix: 'Clean the data or export it with a time column.' }] };
      }
      A = Float64Array.from(raw);
      if (nBad) {
        interpolateNaN(A);
        checks.push({ level: 'warn', title: nBad + ' missing values filled in', detail: 'Filled by straight-line interpolation between neighbours (under 1% of samples).' });
      }
      fs = fsManual || 100;
      t = Float64Array.from(A, (_, i) => i / fs);
    }
    if (A.length < MIN_ROWS) {
      return { fatal: true, checks: [{ level: 'error', title: 'Too few samples', detail: 'Only ' + A.length + ' usable samples in this channel.', fix: 'Record for at least a few seconds.' }] };
    }
    if (ds.t) {
      const dts = [];
      let dup = 0;
      for (let i = 1; i < t.length; i++) { const d = t[i] - t[i - 1]; if (d > 0) dts.push(d); else dup++; }
      const md = median(dts);
      fs = 1 / md;
      const jitter = std(dts) / md;
      let gaps = 0, maxGap = 0;
      for (const d of dts) if (d > 5 * md) { gaps++; maxGap = Math.max(maxGap, d); }
      checks.push({ level: fs < 10 ? 'warn' : 'pass', title: 'Sampling rate about ' + fmt(fs, fs >= 100 ? 0 : 1) + ' Hz',
        detail: 'Measured from the timestamps. Timing varies by ' + Math.round(jitter * 100) + '% between samples' + (jitter > 0.25 ? ', which is typical of phone apps.' : '.') +
          (fs < 10 ? ' This is too slow to resolve individual steps reliably.' : '') });
      if (Math.abs(fs - 100) / 100 > 0.05) {
        checks.push({ level: 'warn', lab: true, title: 'Lab code assumes 100 Hz', detail: 'The original code divides by 100 to get seconds, so its durations are off by ' + Math.round(Math.abs(100 / fs - 1) * 100) + '% for this file. Coza uses the real timestamps.' });
      }
      if (dup) checks.push({ level: 'warn', title: dup + ' repeated timestamps', detail: 'Some consecutive samples share a timestamp. Durations still come from the timestamps, but those samples add no timing information.' });
      if (gaps) checks.push({ level: 'warn', title: gaps + ' gap' + (gaps > 1 ? 's' : '') + ' in the recording', detail: 'The longest pause between samples is ' + fmt(maxGap, 2) + ' s. Steps inside a gap cannot be detected.' });
    } else {
      checks.push({ level: 'info', title: 'Sampling rate set to ' + fs + ' Hz', detail: 'Change it in Recording settings if your device recorded at a different rate.' });
    }
    if (col && col.sensor && !col.sensor.accel) {
      checks.push({ level: 'warn', title: 'Not an acceleration signal', detail: cap(col.sensor.label) + ' data (' + col.sensor.unit + '). Walking still creates peaks, but the lab threshold h = 1 has no physical meaning for it.' });
    }
    const sd = std(A);
    if (!(sd > 0)) return { fatal: true, checks: checks.concat([{ level: 'error', title: 'Flat signal', detail: 'Every sample in this channel has the same value, so there are no peaks to detect.', fix: 'Pick another channel.' }]) };
    // saturation: long runs at the extreme values
    let mx = -Infinity, mn = Infinity;
    for (const v of A) { if (v > mx) mx = v; if (v < mn) mn = v; }
    // A run counts if it lasts at least 3 samples and 20 ms: at high rates, values rounded
    // to 0.01 repeat for a few samples at any smooth peak without the sensor saturating.
    const minRun = Math.max(3, Math.ceil(0.02 * fs));
    let sat = false;
    for (let i = 0, run = 0; i < A.length && !sat; i++) {
      run = (A[i] === mx || A[i] === mn) && i > 0 && A[i] === A[i - 1] ? run + 1 : 1;
      if (run >= minRun) sat = true;
    }
    if (sat) checks.push({ level: 'warn', title: 'Possible sensor clipping', detail: 'The signal sits at its extreme value (' + fmt(mx, 2) + ' or ' + fmt(mn, 2) + ') for ' + minRun + ' or more samples in a row. Peaks there may be cut off.' });
    const dur = t[t.length - 1] - t[0];
    if (dur < 3) checks.push({ level: 'warn', title: 'Short recording', detail: 'Only ' + fmt(dur, 1) + ' s long; step metrics need several steps to be meaningful.' });
    return { A, t, fs, checks, fatal: false, min: mn, max: mx };
  }

  function interpolateNaN(A) {
    const n = A.length;
    let i = 0;
    while (i < n) {
      if (!Number.isNaN(A[i])) { i++; continue; }
      let j = i; while (j < n && Number.isNaN(A[j])) j++;
      const a = i > 0 ? A[i - 1] : A[j], b = j < n ? A[j] : A[i - 1];
      for (let k = i; k < j; k++) A[k] = a + (b - a) * (k - i + 1) / (j - i + 1);
      i = j;
    }
  }

  function fmt(v, d) { return Number.isFinite(v) ? v.toFixed(d) : '—'; }

  /* ----------------------------------------------------------- detection */
  // out[i] = max of A[i-before .. i+after], clipped to bounds (monotonic deque, O(n))
  function windowExtreme(A, before, after, isMax) {
    const n = A.length, out = new Float64Array(n), dq = new Int32Array(n);
    let head = 0, tail = 0, nextIn = 0;
    const better = isMax ? (a, b) => a >= b : (a, b) => a <= b;
    for (let i = 0; i < n; i++) {
      const hi = Math.min(n - 1, i + after), lo = i - before;
      while (nextIn <= hi) {
        while (tail > head && better(A[nextIn], A[dq[tail - 1]])) tail--;
        dq[tail++] = nextIn++;
      }
      while (head < tail && dq[head] < lo) head++;
      out[i] = head < tail ? A[dq[head]] : (isMax ? -Infinity : Infinity);
    }
    return out;
  }

  /* ------------------------------------------------- IIR filter design */
  // Butterworth, Chebyshev I and Chebyshev II as cascaded second-order sections, designed the
  // way scipy's iirfilter(..., output='sos', fs=fs) does: analog prototype poles and zeros,
  // frequency transform with pre-warping, bilinear transform. Only the pairing of poles and
  // zeros into sections differs from scipy; the overall filter (and sosfiltfilt's output) is
  // the same. Checked against scipy in tests/fixtures/filters.json.
  const cx = (re, im = 0) => ({ re, im });
  const cAdd = (a, b) => cx(a.re + b.re, a.im + b.im);
  const cSub = (a, b) => cx(a.re - b.re, a.im - b.im);
  const cMul = (a, b) => cx(a.re * b.re - a.im * b.im, a.re * b.im + a.im * b.re);
  const cDiv = (a, b) => { const d = b.re * b.re + b.im * b.im; return cx((a.re * b.re + a.im * b.im) / d, (a.im * b.re - a.re * b.im) / d); };
  const cScale = (a, s) => cx(a.re * s, a.im * s);
  const cAbs = a => Math.hypot(a.re, a.im);
  const cSqrt = a => { // principal branch, like numpy
    const r = cAbs(a), re = Math.sqrt((r + a.re) / 2), im = Math.sqrt((r - a.re) / 2);
    return cx(re, a.im < 0 ? -im : im);
  };
  const cProd = arr => arr.reduce(cMul, cx(1));

  // analog low-pass prototypes with cut-off 1 rad/s: {z, p, k} (scipy buttap, cheb1ap, cheb2ap)
  function prototype(type, N, rp, rs) {
    const m = Array.from({ length: N }, (_, i) => -N + 1 + 2 * i);
    if (type === 'butter') return { z: [], p: m.map(v => cx(-Math.cos(Math.PI * v / (2 * N)), -Math.sin(Math.PI * v / (2 * N)))), k: 1 };
    if (type === 'bessel') return { z: [], p: besselPoles(N), k: 1 };
    if (type === 'ellip') return ellipPrototype(N, rp, rs);
    if (type === 'cheby1') {
      const eps = Math.sqrt(Math.pow(10, 0.1 * rp) - 1), mu = Math.asinh(1 / eps) / N;
      const p = m.map(v => { const th = Math.PI * v / (2 * N); return cx(-Math.sinh(mu) * Math.cos(th), -Math.cosh(mu) * Math.sin(th)); });
      let k = cProd(p.map(v => cScale(v, -1))).re;
      if (N % 2 === 0) k /= Math.sqrt(1 + eps * eps);
      return { z: [], p, k };
    }
    // cheby2
    const de = 1 / Math.sqrt(Math.pow(10, 0.1 * rs) - 1), mu = Math.asinh(1 / de) / N;
    const mz = N % 2 ? m.filter(v => v !== 0) : m;
    const z = mz.map(v => cx(0, 1 / Math.sin(v * Math.PI / (2 * N))));
    const p = m.map(v => { const th = Math.PI * v / (2 * N); return cDiv(cx(1), cx(-Math.sinh(mu) * Math.cos(th), -Math.cosh(mu) * Math.sin(th))); });
    const k = cDiv(cProd(p.map(v => cScale(v, -1))), cProd(z.map(v => cScale(v, -1)))).re;
    return { z, p, k };
  }

  // Roots of a polynomial with real coefficients c[0] + c[1] s + ... + c[N] s^N (c[N] = 1),
  // by Aberth–Ehrlich iteration from points on a circle of the roots' geometric-mean size.
  function polyRoots(c) {
    const N = c.length - 1, R = Math.pow(Math.abs(c[0]), 1 / N);
    let z = Array.from({ length: N }, (_, i) => cx(R * Math.cos(2 * Math.PI * (i + 0.25) / N), R * Math.sin(2 * Math.PI * (i + 0.25) / N)));
    for (let iter = 0; iter < 500; iter++) {
      let moved = 0;
      z = z.map((zi, i) => {
        let P = cx(c[N]), dP = cx(0);
        for (let k = N - 1; k >= 0; k--) { dP = cAdd(cMul(dP, zi), P); P = cAdd(cMul(P, zi), cx(c[k])); }
        const ratio = cDiv(P, dP);
        let sum = cx(0);
        z.forEach((zj, j) => { if (j !== i) sum = cAdd(sum, cDiv(cx(1), cSub(zi, zj))); });
        const w = cDiv(ratio, cSub(cx(1), cMul(ratio, sum)));
        moved = Math.max(moved, cAbs(w) / Math.max(1, cAbs(zi)));
        return cSub(zi, w);
      });
      if (moved < 1e-16) break;
    }
    return z;
  }
  // Bessel prototype normalised for phase, like scipy's besselap(N, norm='phase'): the roots of
  // the reverse Bessel polynomial θ_N(s) = Σ (2N−k)! / (2^(N−k) k! (N−k)!) s^k, scaled by
  // θ_N(0)^(−1/N) so the response has the same asymptotes as a Butterworth.
  function besselPoles(N) {
    const c = new Array(N + 1);
    c[N] = 1;
    for (let k = N; k >= 1; k--) c[k - 1] = c[k] * (2 * N - k + 1) * k / (2 * (N - k + 1));
    const scale = Math.pow(c[0], -1 / N);
    return polyRoots(c).map(r => cScale(r, scale));
  }

  // Elliptic integrals and functions for the elliptic prototype, parameter m = k² as in scipy.
  function agm(a, b) {
    for (let i = 0; i < 60 && Math.abs(a - b) > 1e-16 * a; i++) [a, b] = [(a + b) / 2, Math.sqrt(a * b)];
    return (a + b) / 2;
  }
  const ellipK = m => Math.PI / (2 * agm(1, Math.sqrt(1 - m)));   // K(m)
  const ellipKm1 = m1 => Math.PI / (2 * agm(1, Math.sqrt(m1)));   // K(1 − m1), exact for tiny m1
  function carlsonRF(x, y, z) {
    let ave, dx, dy, dz;
    do {
      const sx = Math.sqrt(x), sy = Math.sqrt(y), sz = Math.sqrt(z), lam = sx * (sy + sz) + sy * sz;
      x = (x + lam) / 4; y = (y + lam) / 4; z = (z + lam) / 4;
      ave = (x + y + z) / 3; dx = (ave - x) / ave; dy = (ave - y) / ave; dz = (ave - z) / ave;
    } while (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) > 0.0008);
    const e2 = dx * dy - dz * dz, e3 = dx * dy * dz;
    return (1 + (e2 / 24 - 0.1 - 3 * e3 / 44) * e2 + e3 / 14) / Math.sqrt(ave);
  }
  // Jacobi sn, cn, dn by the descending Landen (AGM) method, as cephes ellpj (used by scipy).
  function ellipj(u, m) {
    if (m < 1e-9) {
      const t = Math.sin(u), b = Math.cos(u), ai = 0.25 * m * (u - t * b);
      return { sn: t - ai * b, cn: b + ai * t, dn: 1 - 0.5 * m * t * t };
    }
    if (m >= 0.9999999999) {
      let ai = 0.25 * (1 - m);
      const b = Math.cosh(u), t = Math.tanh(u), phi = 1 / b, twon = b * Math.sinh(u);
      const sn = t + ai * (twon - u) / (b * b);
      ai *= t * phi;
      return { sn, cn: phi - ai * (twon - u), dn: phi + ai * (twon + u) };
    }
    const a = [1], c = [Math.sqrt(m)];
    let b = Math.sqrt(1 - m), twon = 1, i = 0;
    while (Math.abs(c[i] / a[i]) > 1.11022302462515654042e-16 && i <= 7) {
      const ai = a[i]; i++;
      c[i] = (ai - b) / 2; const t = Math.sqrt(ai * b); a[i] = (ai + b) / 2; b = t; twon *= 2;
    }
    let phi = twon * a[i] * u, prev = phi;
    do { const t = c[i] * Math.sin(phi) / a[i]; prev = phi; phi = (Math.asin(t) + phi) / 2; } while (--i);
    const sn = Math.sin(phi), cn = Math.cos(phi);
    return { sn, cn, dn: cn / Math.cos(phi - prev) };
  }
  // Inverse of sc(u | 1 − m1) at w: F(atan w | 1 − m1) (scipy's _arc_jac_sc1)
  function arcJacSc1(w, m1) {
    const ph = Math.atan(w), sn = Math.sin(ph), cs = Math.cos(ph);
    return sn * carlsonRF(cs * cs, cs * cs + m1 * sn * sn, 1);
  }
  // Degree equation by nomes (scipy's _ellipdeg): the m of an order-n filter with ripple ratio m1
  function ellipdeg(n, m1) {
    const q = Math.pow(Math.exp(-Math.PI * ellipKm1(m1) / ellipK(m1)), 1 / n);
    let num = 0, den = 0;
    for (let k = 0; k <= 7; k++) num += Math.pow(q, k * (k + 1));
    for (let k = 1; k <= 8; k++) den += Math.pow(q, k * k);
    return 16 * q * Math.pow(num / (1 + 2 * den), 4);
  }
  // Elliptic (Cauer) prototype, as scipy's ellipap(N, rp, rs).
  function ellipPrototype(N, rp, rs) {
    const epsSq = Math.pow(10, 0.1 * rp) - 1;
    if (N === 1) { const p = -Math.sqrt(1 / epsSq); return { z: [], p: [cx(p)], k: -p }; }
    const ck1 = epsSq / (Math.pow(10, 0.1 * rs) - 1);
    const m = ellipdeg(N, ck1), capk = ellipK(m), EPS = 2e-16;
    const js = []; for (let j = 1 - N % 2; j < N; j += 2) js.push(j);
    const f = js.map(j => ellipj(j * capk / N, m));
    const zs = f.filter(v => Math.abs(v.sn) > EPS).map(v => cx(0, 1 / (Math.sqrt(m) * v.sn)));
    const z = zs.concat(zs.map(v => cx(v.re, -v.im)));
    const v0 = capk * arcJacSc1(1 / Math.sqrt(epsSq), ck1) / (N * ellipK(ck1));
    const { sn: sv, cn: cv, dn: dv } = ellipj(v0, 1 - m);
    let p = f.map(({ sn, cn, dn }) => { const den = 1 - (dn * sv) * (dn * sv); return cx(-(cn * dn * sv * cv) / den, -(sn * dv) / den); });
    const size = Math.sqrt(p.reduce((acc, v) => acc + v.re * v.re + v.im * v.im, 0));
    p = p.concat((N % 2 ? p.filter(v => Math.abs(v.im) > EPS * size) : p).map(v => cx(v.re, -v.im)));
    let k = cDiv(cProd(p.map(v => cScale(v, -1))), cProd(z.map(v => cScale(v, -1)))).re;
    if (N % 2 === 0) k /= Math.sqrt(1 + epsSq);
    return { z, p, k };
  }

  /* Digital filter as second-order sections [b0, b1, b2, 1, a1, a2].
     spec: {type: 'butter'|'bessel'|'cheby1'|'cheby2'|'ellip', order, fs, lowpass (Hz), highpass (Hz, 0 = none),
     rp (dB passband ripple, cheby1), rs (dB stopband attenuation, cheby2)}. With a high-pass
     cut-off it is a band-pass of twice the order, as in scipy. For Chebyshev I the cut-off is where
     the ripple band ends; for Chebyshev II it is where the stopband starts. Throws a
     RangeError saying what to change when the spec can't be built. */
  function designFilter(spec) {
    const { type, order: N, fs } = spec, lp = spec.lowpass || 0, hp = spec.highpass || 0;
    const nyq = fs / 2;
    if (!(N >= 1 && N <= 10 && Number.isInteger(N))) throw new RangeError('The filter order must be a whole number from 1 to 10.');
    if (!(lp > 0)) throw new RangeError('The low-pass cut-off must be above 0 Hz.');
    if (hp < 0) throw new RangeError('The high-pass cut-off must be 0 (off) or above.');
    if (lp >= nyq) throw new RangeError('The low-pass cut-off must be below half the sampling rate: under ' + fmt(nyq, 1) + ' Hz for this recording.');
    if (hp > 0 && hp >= lp) throw new RangeError('The high-pass cut-off must be below the low-pass cut-off.');
    if ((type === 'cheby1' || type === 'ellip') && !(spec.rp > 0)) throw new RangeError('The passband ripple must be above 0 dB.');
    if ((type === 'cheby2' || type === 'ellip') && !(spec.rs > 0)) throw new RangeError('The stopband attenuation must be above 0 dB.');
    if (type === 'ellip' && !(spec.rs > spec.rp)) throw new RangeError('The stopband attenuation must be larger than the passband ripple.');
    let { z, p, k } = prototype(type, N, spec.rp, spec.rs);
    const warp = f => 4 * Math.tan(Math.PI * f / fs); // pre-warped, bilinear transform with fs = 2
    const degree = p.length - z.length;
    if (hp > 0) { // lp2bp_zpk
      const w1 = warp(hp), w2 = warp(lp), wo = Math.sqrt(w1 * w2), bw = w2 - w1, wo2 = cx(wo * wo);
      const split = r => { const h = cScale(r, bw / 2), s = cSqrt(cSub(cMul(h, h), wo2)); return [cAdd(h, s), cSub(h, s)]; };
      const zs = z.map(split), ps = p.map(split);
      z = zs.map(v => v[0]).concat(zs.map(v => v[1]), Array.from({ length: degree }, () => cx(0)));
      p = ps.map(v => v[0]).concat(ps.map(v => v[1]));
      k *= Math.pow(bw, degree);
    } else { // lp2lp_zpk
      const wo = warp(lp);
      z = z.map(v => cScale(v, wo)); p = p.map(v => cScale(v, wo));
      k *= Math.pow(wo, degree);
    }
    // bilinear_zpk with fs = 2
    const four = cx(4), deg2 = p.length - z.length;
    k *= cDiv(cProd(z.map(v => cSub(four, v))), cProd(p.map(v => cSub(four, v)))).re;
    z = z.map(v => cDiv(cAdd(four, v), cSub(four, v))).concat(Array.from({ length: deg2 }, () => cx(-1)));
    p = p.map(v => cDiv(cAdd(four, v), cSub(four, v)));
    return { sos: zpkToSos(z, p, k), z, p, k };
  }

  // Group roots into first- and second-order factors: conjugate pairs together, real roots two
  // at a time (a last odd one alone). Each unit: {r: a root to measure distance by, c: [1, c1, c2]}.
  function rootUnits(roots) {
    const tol = 1e-10, units = [], real = [];
    for (const r of roots) {
      if (Math.abs(r.im) <= tol * Math.max(1, cAbs(r))) real.push(r.re);
      else if (r.im > 0) units.push({ r, c: [1, -2 * r.re, r.re * r.re + r.im * r.im] });
    }
    real.sort((a, b) => a - b);
    for (let i = 0; i + 1 < real.length; i += 2) units.push({ r: cx(real[i]), c: [1, -(real[i] + real[i + 1]), real[i] * real[i + 1]] });
    if (real.length % 2) units.push({ r: cx(real[real.length - 1]), c: [1, -real[real.length - 1], 0], single: true });
    return units;
  }

  // Pole units ordered from farthest to closest to the unit circle (scipy puts the "worst" last),
  // each paired with the nearest unused zero unit; a lone real pole takes a lone real zero.
  function zpkToSos(z, p, k) {
    const pu = rootUnits(p), zu = rootUnits(z);
    pu.sort((a, b) => Math.abs(1 - cAbs(b.r)) - Math.abs(1 - cAbs(a.r)));
    const sos = pu.map((P, i) => {
      let j = P.single ? zu.findIndex(Z => Z.single) : -1;
      if (j < 0) { j = 0; zu.forEach((Z, q) => { if (!Z.single && cAbs(cSub(Z.r, P.r)) < cAbs(cSub(zu[j].r, P.r))) j = q; }); }
      const b = j >= 0 && zu.length ? zu.splice(j, 1)[0].c : [1, 0, 0];
      const g = i === 0 ? k : 1;
      return [g * b[0], g * b[1], g * b[2], 1, P.c[1], P.c[2]];
    });
    return sos;
  }

  /* Zero-phase filtering with second-order sections, like scipy's sosfiltfilt: odd extension
     of padlen samples at each end (default 3 × the filter length, as in scipy), each pass
     starting from the steady state for its first sample (sosfilt_zi). */
  function sosfiltfilt(sos, A, padlen) {
    const n = A.length;
    const ntaps = 2 * sos.length + 1 - Math.min(sos.filter(s => s[2] === 0).length, sos.filter(s => s[5] === 0).length);
    const edge = Math.max(0, Math.min(padlen === undefined ? 3 * ntaps : padlen, n - 1));
    const N = n + 2 * edge, x = new Float64Array(N);
    for (let i = 0; i < edge; i++) { x[i] = 2 * A[0] - A[edge - i]; x[N - 1 - i] = 2 * A[n - 1] - A[n - 1 - edge + i]; }
    x.set(A, edge);
    // steady state of each section for a unit step (scipy sosfilt_zi)
    let scale = 1;
    const zi = sos.map(([b0, b1, b2, , a1, a2]) => {
      const B0 = b1 - a1 * b0, B1 = b2 - a2 * b0, z0 = (B0 + B1) / (1 + a1 + a2), z1 = B1 - a2 * z0;
      const out = [scale * z0, scale * z1];
      scale *= (b0 + b1 + b2) / (1 + a1 + a2);
      return out;
    });
    const pass = (from, to, dir) => { // transposed direct form II, in place
      const x0 = x[from], st = zi.map(([a, b]) => [a * x0, b * x0]);
      for (let i = from; i !== to; i += dir) {
        let v = x[i];
        for (let s = 0; s < sos.length; s++) {
          const [b0, b1, b2, , a1, a2] = sos[s], z = st[s];
          const y = b0 * v + z[0];
          z[0] = b1 * v - a1 * y + z[1]; z[1] = b2 * v - a2 * y;
          v = y;
        }
        x[i] = v;
      }
    };
    pass(0, N, 1); pass(N - 1, -1, -1);
    return x.slice(edge, edge + n);
  }

  /* Low-pass filter used inside the step detection algorithms: 2nd-order Butterworth run
     forwards and then backwards (like MATLAB's filtfilt), so peaks stay at the same time; the
     gain at the cut-off is 1/2. Both ends are padded with a point reflection of 3·fs/fc
     samples, longer than sosfiltfilt's default, so slow cut-offs start settled. fs is the
     median rate; phone jitter is small next to a few-Hz cut-off. A cut-off at or above fs/2
     returns an unfiltered copy. */
  function lowpass(A, fs, fc) {
    if (!(fc > 0) || !(fc < fs / 2) || A.length < 3) return Float64Array.from(A);
    return sosfiltfilt(designFilter({ type: 'butter', order: 2, fs, lowpass: fc }).sos, A, Math.round(3 * fs / fc));
  }

  // Half of a centred window of the given length in seconds, in samples (at least 1).
  function halfWindow(seconds, fs) { return Math.max(1, Math.round(seconds * fs / 2)); }

  // Sliding max and min over A[i-half .. i+half] and their midpoint, the dynamic threshold
  // of peak-to-valley step counters (Zhao 2010). Also the envelope a plot can draw (#13).
  function dynamicThreshold(A, half) {
    const upper = windowExtreme(A, half, half, true), lower = windowExtreme(A, half, half, false);
    const mid = new Float64Array(A.length);
    for (let i = 0; i < A.length; i++) mid[i] = (upper[i] + lower[i]) / 2;
    return { upper, lower, mid };
  }

  // Exact port of LabStepDet_2025.m. Returns 0-based indices.
  function detectOriginal(A, w, h) {
    const M = windowExtreme(A, w, w, true), idx = [];
    for (let i = w; i < A.length - w; i++) if (A[i] === M[i] && M[i] > h) idx.push(i);
    return idx;
  }

  function originalMetrics(idx, w) {
    const d = [];
    for (let k = 1; k < idx.length; k++) d.push(idx[k] - idx[k - 1]);
    const even = d.filter((_, k) => k % 2 === 1), odd = d.filter((_, k) => k % 2 === 0);
    const avg = d.length ? mean(d) / 100 : NaN;
    return {
      steps: idx.length,
      avgStepDuration: avg,
      pace: avg * 60,
      variabilitySamples: d.length > 1 ? std(d) : NaN,
      asymmetry: even.length && odd.length ? mean(even) / mean(odd) : NaN,
      intervals: d,
      // Two detections closer than w samples can only happen when both share the window's max value.
      tiedPairs: w ? d.filter(v => v <= w).length : d.filter(v => v === 1).length,
    };
  }

  // A weak peak rises less than this fraction as far above h as the median peak. 40% keeps
  // the real first step in Walking.mat (0.83) and drops the stop bump (0.13), with a wide
  // margin on both sides, so it is fixed rather than a setting.
  const WEAK_RATIO = 0.4;

  // Coza: the lab detector with its bugs fixed. opts: {ties, weak, weakRatio}
  function detectCoza(A, w, h, opts) {
    const M = windowExtreme(A, w, w, true);
    const L = opts.ties ? windowExtreme(A, w, -1, true) : null; // max of A[i-w .. i-1]
    let idx = [];
    for (let i = w; i < A.length - w; i++) {
      if (A[i] !== M[i] || !(M[i] > h)) continue;
      if (opts.ties && !(A[i] > L[i])) continue;
      idx.push(i);
    }
    // Peak strength = height above the threshold, relative to the typical (median) peak.
    const amp = idx.map(i => A[i] - h);
    const medAmp = median(amp);
    const weakDropped = [];
    if (opts.weak && idx.length >= 3) {
      const kept = [];
      idx.forEach((i, k) => { if (amp[k] >= opts.weakRatio * medAmp) kept.push(i); else weakDropped.push(i); });
      idx = kept;
    }
    return { idx, weakDropped, medAmp };
  }

  // Timing metrics from step times, shared by every algorithm so their results compare.
  function timingMetrics(idx, t, opts) {
    const d = [];
    for (let k = 1; k < idx.length; k++) d.push(t[idx[k]] - t[idx[k - 1]]);
    const perPeak = opts.stride ? 2 : 1;
    const peakInterval = d.length ? mean(d) : NaN;
    const stepInterval = peakInterval / perPeak;
    const even = d.filter((_, k) => k % 2 === 1), odd = d.filter((_, k) => k % 2 === 0);
    const span = idx.length > 1 ? t[idx[idx.length - 1]] - t[idx[0]] : NaN;
    return {
      peaks: idx.length,
      steps: idx.length * perPeak,
      stepInterval,
      cadence: 60 / stepInterval,
      variabilityMs: d.length > 1 ? std(d) * 1000 : NaN,
      cv: d.length > 1 ? std(d) / peakInterval * 100 : NaN,
      asymmetry: opts.stride ? NaN : (even.length && odd.length ? mean(even) / mean(odd) : NaN),
      span,
      intervals: d,
    };
  }

  /* Threshold peaks: the textbook peak detector, with the parts Coza lacks. The signal is
     low-pass filtered, the threshold comes from the signal (mean + k·SD of the smoothed
     signal) instead of a fixed h, and of two peaks closer than minInterval seconds only the
     taller is kept (tallest first, like scipy's find_peaks distance). opts: {cutoff, k, minInterval} */
  function detectThresholdPeaks(A, t, fs, opts) {
    const s = lowpass(A, fs, opts.cutoff);
    const threshold = mean(s) + opts.k * std(s);
    const cand = [];
    for (let i = 1; i < s.length - 1; i++) if (s[i] > threshold && s[i] > s[i - 1] && s[i] >= s[i + 1]) cand.push(i);
    const order = cand.map((_, k) => k).sort((a, b) => (s[cand[b]] - s[cand[a]]) || (a - b));
    const out = new Uint8Array(cand.length), keep = new Uint8Array(cand.length);
    for (const k of order) {
      if (out[k]) continue;
      keep[k] = 1;
      for (let j = k - 1; j >= 0 && t[cand[k]] - t[cand[j]] < opts.minInterval; j--) out[j] = 1;
      for (let j = k + 1; j < cand.length && t[cand[j]] - t[cand[k]] < opts.minInterval; j++) out[j] = 1;
    }
    return { idx: cand.filter((_, k) => keep[k]), smooth: s, threshold };
  }

  /* Peak-to-valley (min-max) detection, after Zhao (2010, Analog Devices pedometer note).
     The threshold follows the signal: the midpoint of the sliding max and min over a
     window (default 1 s, centred). The smoothed signal alternates between runs above and
     below it; each run above followed by a run below is one candidate step, marked at
     its peak. The swing (peak minus the valley after it) must reach minSwing × the median
     swing, which drops the small wiggles of standing still. Of two steps closer than
     minInterval seconds, the larger swing is kept. opts: {window, minSwing, minInterval} */
  const PV_CUTOFF = 5; // light smoothing (Hz): enough to stop noise splitting a run in two
  function detectPeakToValley(A, t, fs, opts) {
    const s = lowpass(A, fs, PV_CUTOFF), n = s.length;
    const threshold = dynamicThreshold(s, halfWindow(opts.window, fs)).mid;
    const runs = [];
    for (let i = 0, start = 0; i < n; i++) {
      const above = s[i] >= threshold[i];
      if (i === n - 1 || (s[i + 1] >= threshold[i + 1]) !== above) { runs.push({ above, start, end: i }); start = i + 1; }
    }
    const cycles = [];
    for (let r = 0; r + 1 < runs.length; r++) {
      if (!runs[r].above) continue;
      let pk = runs[r].start, vl = runs[r + 1].start;
      for (let i = runs[r].start; i <= runs[r].end; i++) if (s[i] > s[pk]) pk = i;
      for (let i = runs[r + 1].start; i <= runs[r + 1].end; i++) if (s[i] < s[vl]) vl = i;
      cycles.push({ pk, swing: s[pk] - s[vl] });
    }
    const medSwing = median(cycles.map(c => c.swing));
    const kept = [];
    for (const c of cycles) {
      if (c.swing < opts.minSwing * medSwing) continue;
      const last = kept[kept.length - 1];
      if (last && t[c.pk] - t[last.pk] < opts.minInterval) { if (c.swing > last.swing) kept[kept.length - 1] = c; continue; }
      kept.push(c);
    }
    return { idx: kept.map(c => c.pk), smooth: s, threshold, medSwing, candidates: cycles.length };
  }

  /* Zero-crossing detection: timing, not height. The smoothed signal minus a slow baseline
     (the signal low-passed at 0.3 Hz, which removes gravity and follows slow drift, such as
     the phone tilting) crosses zero upwards once per step. A hysteresis band of ±0.3 SD of that difference stops noise
     near zero from adding crossings: after a crossing has counted, the signal must drop
     below −band before the next one can, and a crossing counts only once the signal goes
     on to rise above +band. Crossings closer than minInterval seconds to the last step are
     ignored. opts: {cutoff, minInterval} */
  const ZC_BASELINE = 0.3, ZC_BAND = 0.3; // baseline cut-off (Hz), hysteresis (× SD)
  function detectZeroCrossing(A, t, fs, opts) {
    const s = lowpass(A, fs, opts.cutoff), n = s.length;
    const baseline = lowpass(s, fs, ZC_BASELINE);
    const d = new Float64Array(n);
    for (let i = 0; i < n; i++) d[i] = s[i] - baseline[i];
    const band = ZC_BAND * std(d);
    const idx = [];
    let armed = true, cross = -1, last = -Infinity;
    for (let i = 1; i < n; i++) {
      if (d[i] < -band) { armed = true; cross = -1; }
      if (armed && d[i - 1] < 0 && d[i] >= 0) cross = i;
      if (armed && cross >= 0 && d[i] > band) {
        if (t[cross] - last >= opts.minInterval) { idx.push(cross); last = t[cross]; }
        armed = false; cross = -1;
      }
    }
    return { idx, smooth: s, baseline, band };
  }

  // A window given in seconds, as a whole number of samples at fs (at least 1, and short
  // enough that the detection loop still visits some samples).
  function windowSamples(seconds, fs, n) {
    return Math.max(1, Math.min(Math.round(seconds * fs), Math.floor((n - 1) / 2) - 1));
  }

  /* Step detection algorithms offered in the dashboard. The lab code (detectOriginal /
     originalMetrics) is the MATLAB reference, always shown for comparison, and is not listed.
     Each entry:
       tagline   one line under the dropdown
       summary   shown in "How detection works"
       usesH     whether the threshold h applies (it always applies to the lab code)
       detect(A, t, p) -> {idx, weakDropped?, w?, markY?, guides?}
                 idx: 0-based step samples. markY: values the markers sit on (default A).
                 guides: up to two lines drawn with the signal, [{name, y, dash?}], where y is
                 an array (one value per sample) or a single number (a level line).
       settings(p, fx) -> [[name, value], ...] for the metrics export
     Metrics come from timingMetrics for every algorithm. p holds h, the sampling rate fs,
     the lab code's w (samples), the phone position and every algorithm's own options. */
  const ALGORITHMS = [
    {
      id: 'coza',
      name: 'Coza',
      tagline: 'The lab detector with its bugs fixed.',
      summary: 'Coza fixes the lab code\u2019s bugs: tied peaks are counted once, weak start and stop bumps are dropped, the window is in seconds, timing comes from the real timestamps, and cadence is in steps/min.',
      usesH: true,
      // Window in seconds, so it means the same at any sampling rate (the lab's w is samples).
      // Tied peaks are always counted once: showing the double count is the lab code's job.
      detect: (A, t, p) => {
        const w = windowSamples(p.cozaWindow, p.fs, A.length);
        return Object.assign(detectCoza(A, w, p.h, { ties: true, weak: p.weak, weakRatio: WEAK_RATIO }), { w });
      },
      settings: (p, fx) => [['coza_window_s', p.cozaWindow], ['coza_window_samples', fx.w],
        ['fix_weak_peaks', p.weak ? 'on, ' + Math.round(WEAK_RATIO * 100) + '%' : 'off']],
    },
    {
      id: 'threshold',
      name: 'Threshold peaks',
      tagline: 'Peaks of the smoothed signal above mean + k\u00b7SD.',
      summary: 'Threshold peaks is the textbook peak detector, with what Coza lacks: the signal is low-pass filtered first, the threshold is set from the signal itself (mean + k \u00d7 SD of the smoothed signal) instead of h, and of two peaks closer than the minimum interval only the taller one counts. Markers sit on the smoothed signal.',
      usesH: false,
      detect: (A, t, p) => {
        const r = detectThresholdPeaks(A, t, p.fs, { cutoff: p.tpCutoff, k: p.tpK, minInterval: p.tpMinInterval });
        return { idx: r.idx, markY: r.smooth, threshold: r.threshold,
          guides: [{ name: 'Smoothed (' + p.tpCutoff + ' Hz)', y: r.smooth }, { name: 'Mean + k\u00b7SD = ' + fmt(r.threshold, 2), y: r.threshold, dash: true }] };
      },
      settings: (p, fx) => [['lowpass_cutoff_hz', p.tpCutoff], ['threshold_k', p.tpK], ['threshold_value', +fx.threshold.toFixed(6)], ['min_interval_s', p.tpMinInterval]],
    },
    {
      id: 'peakvalley',
      name: 'Peak-to-valley',
      tagline: 'A peak followed by a valley, around a threshold that follows the signal.',
      summary: 'Peak-to-valley (min-max) uses a threshold that moves with the signal: the midpoint of the highest and lowest smoothed values within a sliding window. Each rise above it followed by a fall below it is a step, marked at its peak, when the peak-to-valley swing is at least a set share of the typical (median) swing. Steps closer than the minimum interval keep the larger swing. It does not use h.',
      usesH: false,
      detect: (A, t, p) => {
        const r = detectPeakToValley(A, t, p.fs, { window: p.pvWindow, minSwing: p.pvSwing / 100, minInterval: p.pvMinInterval });
        return { idx: r.idx, markY: r.smooth, medSwing: r.medSwing,
          guides: [{ name: 'Smoothed (' + PV_CUTOFF + ' Hz)', y: r.smooth }, { name: 'Dynamic threshold', y: r.threshold, dash: true }] };
      },
      settings: (p, fx) => [['lowpass_cutoff_hz', PV_CUTOFF], ['window_s', p.pvWindow], ['min_swing_pct_of_median', p.pvSwing],
        ['median_swing', Number.isFinite(fx.medSwing) ? +fx.medSwing.toFixed(6) : ''], ['min_interval_s', p.pvMinInterval]],
    },
    {
      id: 'zerocross',
      name: 'Zero-crossing',
      tagline: 'Upward crossings of the smoothed signal through its baseline.',
      summary: 'Zero-crossing uses timing, not peak height. The signal is low-pass filtered and a slow baseline (the signal low-passed at 0.3 Hz) is subtracted, which also removes gravity; each upward crossing of zero is a step. A hysteresis band (\u00b10.3 SD) stops noise near zero from adding crossings, and crossings closer than the minimum interval are ignored. Markers sit where the smoothed signal crosses its baseline, not on a peak. It does not use h.',
      usesH: false,
      detect: (A, t, p) => {
        const r = detectZeroCrossing(A, t, p.fs, { cutoff: p.zcCutoff, minInterval: p.zcMinInterval });
        return { idx: r.idx, markY: r.smooth, band: r.band,
          guides: [{ name: 'Smoothed (' + p.zcCutoff + ' Hz)', y: r.smooth }, { name: 'Baseline (' + ZC_BASELINE + ' Hz)', y: r.baseline, dash: true }] };
      },
      settings: (p, fx) => [['lowpass_cutoff_hz', p.zcCutoff], ['baseline_cutoff_hz', ZC_BASELINE], ['hysteresis_sd', ZC_BAND],
        ['hysteresis_value', +fx.band.toFixed(6)], ['min_interval_s', p.zcMinInterval]],
    },
  ];

  /* Signal filters offered in the dashboard. A filter changes the signal the selected
     algorithm runs on; the lab code always runs on the recorded signal so it stays exact.
     Each entry: tagline (one line under the dropdown), apply(A, fs, p) -> filtered copy of
     evenly spaced samples (throws a RangeError saying what to change when the settings
     can't be used), label(p) for the export. Its settings are the rows under Advanced whose
     data-only lists its id. p: {filter, fOrder, fLow (Hz), fHigh (Hz, 0 = off), fRipple (dB),
     fAtten (dB)} */
  const ORDINAL = n => n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th');
  // IIR filters from designFilter, run forwards and backwards
  const iirEntry = (id, name, tagline, extra) => ({
    id, name, tagline, iir: true,
    apply: (A, fs, p) => sosfiltfilt(designFilter({ type: id, order: p.fOrder, fs, lowpass: p.fLow, highpass: p.fHigh, rp: p.fRipple, rs: p.fAtten }).sos, A),
    label: p => name + ', ' + ORDINAL(p.fOrder) + ' order, ' + (p.fHigh > 0 ? fmt(p.fHigh, 1) + '\u2013' + fmt(p.fLow, 1) + ' Hz band-pass' : fmt(p.fLow, 1) + ' Hz low-pass') + (extra ? extra(p) : ''),
  });
  const FILTERS = [
    { id: 'none', name: 'None', tagline: 'Detection runs on the recorded signal.' },
    iirEntry('butter', 'Butterworth', 'Flat passband and the gentlest roll-off: the least change to the shape of each step.'),
    iirEntry('bessel', 'Bessel', 'The most even delay across frequencies: steps keep their shape best, with the gentlest roll-off. The cut-off is where the phase is half delayed, not the -3 dB point.'),
    iirEntry('cheby1', 'Chebyshev I', 'A steeper roll-off, paid for with ripple in the passband that slightly reshapes peaks.', p => ', ' + fmt(p.fRipple, 1) + ' dB ripple'),
    iirEntry('cheby2', 'Chebyshev II', 'A steep roll-off with a flat passband; the ripple is in the stopband. The cut-off is where the stopband starts.', p => ', ' + fmt(p.fAtten, 0) + ' dB stopband'),
    iirEntry('ellip', 'Elliptic', 'The steepest roll-off for its order, with ripple in both passband and stopband. The cut-off is where the passband ripple ends.',
      p => ', ' + fmt(p.fRipple, 1) + ' dB ripple, ' + fmt(p.fAtten, 0) + ' dB stopband'),
  ];
  function filterLabel(p) {
    const f = FILTERS.find(x => x.id === p.filter);
    return !f || !f.apply ? 'none' : f.label(p);
  }

  // Values of y (sampled at increasing times ts, repeats allowed) at the times td, by straight
  // lines between neighbours; held flat beyond either end.
  function interpAt(ts, y, td) {
    const out = new Float64Array(td.length);
    let j = 0;
    for (let i = 0; i < td.length; i++) {
      const v = td[i];
      while (j + 1 < ts.length && ts[j + 1] <= v) j++;
      if (v <= ts[0]) out[i] = y[0];
      else if (j + 1 >= ts.length) out[i] = y[ts.length - 1];
      else { const d = ts[j + 1] - ts[j]; out[i] = d > 0 ? y[j] + (y[j + 1] - y[j]) * (v - ts[j]) / d : y[j]; }
    }
    return out;
  }

  const RESAMPLE_JITTER = 0.01; // timing variation above which a filter runs on an even grid

  /* Filter a prepared channel. IIR filters assume evenly spaced samples, and phone exports
     aren't, so when the timestamps vary by more than 1% the signal is interpolated onto an
     even grid at the median rate, filtered there and read back at the original timestamps:
     the algorithm still sees one value per recorded sample. Smoothing windows (moving
     average, median, Savitzky–Golay) need even spacing just the same. Returns {A, applied, resampled,
     checks}; settings that can't be built leave the signal unfiltered with a check saying
     what to change. */
  function applyFilter(A, t, fs, p) {
    const none = { A, applied: false, resampled: false, checks: [] };
    const f = FILTERS.find(x => x.id === p.filter);
    if (!f || !f.apply) return none;
    try {
      return filterEvenly(A, t, fs, x => f.apply(x, fs, p));
    } catch (e) {
      if (!(e instanceof RangeError)) throw e;
      return Object.assign(none, { checks: [{ level: 'warn', title: 'Filter not applied', detail: e.message + ' Detection runs on the recorded signal.', fix: 'Change the filter settings under Advanced.' }] });
    }
  }
  function filterEvenly(A, t, fs, run) {
    const n = A.length, dts = [];
    for (let i = 1; i < n; i++) { const d = t[i] - t[i - 1]; if (d > 0) dts.push(d); }
    const md = median(dts), jitter = std(dts) / md;
    if (!(jitter > RESAMPLE_JITTER)) return { A: run(A), applied: true, resampled: false, checks: [] };
    const m = Math.floor((t[n - 1] - t[0]) / md) + 1;
    if (m > 4 * n) {
      return { A: run(A), applied: true, resampled: false, checks: [{ level: 'warn', title: 'Filtered as if evenly sampled',
        detail: 'The recording has long gaps, so an even grid would be over 4 times its length. The filter treats the samples as evenly spaced, which blurs its cut-off.',
        fix: 'Trim the gaps or split the recording.' }] };
    }
    const tg = Float64Array.from({ length: m }, (_, k) => t[0] + k * md);
    const yg = run(interpAt(t, A, tg));
    return { A: interpAt(tg, yg, t), applied: true, resampled: true, checks: [{ level: 'info', title: 'Resampled for filtering',
      detail: 'Timing varies by ' + Math.round(jitter * 100) + '% between samples and the filter needs even spacing, so the signal was interpolated onto an even ' + fmt(1 / md, 1) + ' Hz grid, filtered, and read back at the original timestamps.' }] };
  }


  /* Envelopes: curves drawn around the signal the algorithm sees, to show how the size of
     each swing changes. A view only: they never change the detected steps or metrics.
     compute(A, t, p) -> {upper?, lower?, mid?}, arrays with one value per sample.
     p: {fs, envWindow (s, sliding and dynamic), envPeakWindow (s, peak-trough)} */
  // Samples that are the highest (isMax) or lowest within ±half samples, a run of equal values
  // counted once at its first sample (Coza's tie rule); the first and last samples are skipped.
  function localExtrema(A, half, isMax) {
    const M = windowExtreme(A, half, half, isMax), L = windowExtreme(A, half, -1, isMax), out = [];
    for (let i = 1; i < A.length - 1; i++) if (A[i] === M[i] && (isMax ? A[i] > L[i] : A[i] < L[i])) out.push(i);
    return out;
  }
  // Straight lines through the given samples, held flat before the first and after the last.
  function joinPoints(idx, A, t) {
    if (!idx.length) return null;
    return interpAt(Float64Array.from(idx, i => t[i]), Float64Array.from(idx, i => A[i]), t);
  }
  const ENVELOPES = [
    { id: 'none', name: 'None' },
    {
      id: 'sliding', name: 'Sliding window',
      tagline: 'The highest and lowest value within a window around each moment.',
      compute: (A, t, p) => {
        const h = halfWindow(p.envWindow, p.fs);
        return { upper: windowExtreme(A, h, h, true), lower: windowExtreme(A, h, h, false) };
      },
      label: p => 'Envelope, sliding ' + fmt(p.envWindow, 1) + ' s',
    },
    {
      id: 'peaktrough', name: 'Peak-trough',
      tagline: 'Straight lines joining successive peaks, and successive troughs.',
      compute: (A, t, p) => {
        const h = halfWindow(p.envPeakWindow, p.fs);
        return { upper: joinPoints(localExtrema(A, h, true), A, t), lower: joinPoints(localExtrema(A, h, false), A, t) };
      },
      label: p => 'Envelope, peak-trough',
    },
    {
      id: 'dynamic', name: 'Dynamic threshold',
      tagline: 'The midpoint of the sliding max and min: where an adaptive threshold would sit.',
      // the same dynamicThreshold that Peak-to-valley counts steps with
      compute: (A, t, p) => dynamicThreshold(A, halfWindow(p.envWindow, p.fs)),
      label: p => 'Envelope, sliding ' + fmt(p.envWindow, 1) + ' s',
    },
  ];

  /* Synthetic demo walk: 5 columns like the lab file (t, x, y, z, |a|). */
  function demoWalk() {
    const fs = 100, dur = 22, n = fs * dur;
    let seed = 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
    const t = new Float64Array(n), x = new Float64Array(n), y = new Float64Array(n), z = new Float64Array(n), m = new Float64Array(n);
    let tt = 0, phase = 0;
    for (let i = 0; i < n; i++) {
      tt += (1 + 0.3 * rnd()) / fs; t[i] = tt;
      const env = Math.min(1, Math.max(0, (tt - 2) / 1.2)) * Math.min(1, Math.max(0, (20 - tt) / 1.2));
      const f = 0.92 + 0.04 * Math.sin(tt / 3);
      phase += 2 * Math.PI * f / fs;
      const r = n => Math.round(n * 100) / 100;
      x[i] = r(env * (9 * Math.sin(phase) + 2.5 * Math.sin(2 * phase + 0.6)) + 0.35 * rnd());
      y[i] = r(env * (-4 + 5 * Math.pow(Math.max(0, Math.sin(phase - 0.4)), 3) * 2 - 2 * Math.cos(phase)) + 0.35 * rnd());
      z[i] = r(env * (1.8 * Math.sin(4 * phase) + 1.1 * Math.sin(2 * phase)) + 0.5 * rnd());
      m[i] = r(Math.hypot(x[i], y[i], z[i]));
    }
    return { names: ['time', 'x', 'y', 'z', 'magnitude'], cols: [t, x, y, z, m] };
  }

  const api = { InputError, MAX_BYTES, parseMat, matCandidates, matToColumns, parseCsv, buildDataset,
    prepareChannel, detectOriginal, originalMetrics, detectCoza, timingMetrics, ALGORITHMS, WEAK_RATIO, windowExtreme, windowSamples,
    lowpass, designFilter, sosfiltfilt, dynamicThreshold, detectThresholdPeaks, detectPeakToValley, detectZeroCrossing,
    FILTERS, filterLabel, applyFilter, interpAt, gravitySplit, datasetRate, ENVELOPES, localExtrema, halfWindow,
    median, mean, std, fmt, demoWalk, looksLikeText };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.StepCore = api;
})(typeof self !== 'undefined' ? self : this);
