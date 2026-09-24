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
    return role ? (c.name.toLowerCase() === role ? role : role + ' (' + c.name + ')') : c.name + (c.sensor ? ' (' + c.sensor.label.toLowerCase() + ')' : '');
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

  /* Channel-level validation + cleaning. Returns {A, t, fs, checks, fatal} */
  function prepareChannel(ds, colIndex, fsManual) {
    const checks = [];
    const col = colIndex === 'computed' ? null : ds.columns[colIndex];
    const n = ds.n;
    let raw;
    if (colIndex === 'computed') {
      raw = new Float64Array(n);
      for (let i = 0; i < n; i++) raw[i] = Math.hypot(ds.x.data[i], ds.y.data[i], ds.z.data[i]);
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
        checks.push({ level: 'warn', title: 'Lab code assumes 100 Hz', detail: 'The original code divides by 100 to get seconds, so its durations are off by ' + Math.round(Math.abs(100 / fs - 1) * 100) + '% for this file. The fixed version uses the real timestamps.' });
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
    let sat = 0;
    for (let i = 2; i < A.length; i++) if ((A[i] === mx || A[i] === mn) && A[i] === A[i - 1] && A[i] === A[i - 2]) sat++;
    if (sat) checks.push({ level: 'warn', title: 'Possible sensor clipping', detail: 'The signal sits at its extreme value (' + fmt(A[0] === mx ? mx : mx, 2) + ' or ' + fmt(mn, 2) + ') for several samples in a row. Peaks there may be cut off.' });
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

  // Fixed version. opts: {ties, weak, weakRatio}
  function detectFixed(A, w, h, opts) {
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

  function fixedMetrics(idx, t, opts) {
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
    prepareChannel, detectOriginal, originalMetrics, detectFixed, fixedMetrics, windowExtreme,
    median, mean, std, fmt, demoWalk, looksLikeText };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.StepCore = api;
})(typeof self !== 'undefined' ? self : this);
