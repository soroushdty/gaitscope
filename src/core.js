/* GaitScope core: file parsing, schema validation, step detection.
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

  /* ------------------------------------------------------- MAT v7.3 (HDF5) */
  // A v7.3 MAT-file is HDF5 behind a 512-byte MATLAB header. The page reads it with jsfive
  // (pure JavaScript, loaded only when such a file is opened), passed in as hdf5 so this file
  // stays DOM-free. It produces the same variable objects as the v5 reader, so matCandidates,
  // matToColumns and every check after them are unchanged.
  function isMat73(u8) {
    return /MATLAB 7\.3/.test(latin1(u8.subarray(0, 116))) || isHDF5(u8);
  }
  const HDF5_SIG = [0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a];
  const sigAt = (u8, off) => u8.length >= off + 8 && HDF5_SIG.every((b, i) => u8[off + i] === b);

  /* jsfive 0.4.2 can't read compact storage (small datasets kept inside their object header),
     and MATLAB stores every small array that way. Teach it, once: for a version 3/4 layout
     message of class 0, the data follows a 2-byte size, packed as the dataset's dtype. Only
     plain numbers are decoded; anything else keeps jsfive's own error. */
  function patchCompactStorage(dataset) {
    const proto = Object.getPrototypeOf(dataset._dataobjects);
    if (!proto || proto.__compactStorage || typeof proto.get_data !== 'function') return;
    const original = proto.get_data;
    proto.get_data = function () {
      const msg = this.find_msg_type(8)[0]; // DATA_STORAGE_MSG_TYPE
      const off = msg && msg.get('offset_to_message');
      const dv = new DataView(this.fh);
      if (off !== undefined && (dv.getUint8(off) === 3 || dv.getUint8(off) === 4) && dv.getUint8(off + 1) === 0) {
        const m = typeof this.dtype === 'string' && this.dtype.match(/^([<>|=!]?)([iuf])(\d)$/);
        if (!m) throw 'Compact storage of this data type is not supported';
        const le = m[1] !== '>' && m[1] !== '!', size = Number(m[3]), kind = m[2];
        const n = this.shape.reduce((a, b) => a * b, 1), start = off + 4, out = new Array(n);
        const get = { f4: 'getFloat32', f8: 'getFloat64', i1: 'getInt8', i2: 'getInt16', i4: 'getInt32', i8: 'getBigInt64',
          u1: 'getUint8', u2: 'getUint16', u4: 'getUint32', u8: 'getBigUint64' }[kind + size];
        if (!get) throw 'Compact storage of this data type is not supported';
        for (let i = 0; i < n; i++) { const v = dv[get](start + i * size, le); out[i] = typeof v === 'bigint' ? Number(v) : v; }
        return out;
      }
      return original.call(this);
    };
    proto.__compactStorage = true;
  }

  const MATLAB_CLASS_ID = { double: 6, single: 7, int8: 8, uint8: 9, int16: 10, uint16: 11, int32: 12, uint32: 13, int64: 14, uint64: 15,
    logical: 9, char: 4, cell: 1, struct: 2, function_handle: 16 };

  function parseMat73(u8, hdf5) {
    if (!hdf5 || !hdf5.File) throw new InputError('The reader for MATLAB v7.3 files did not load.',
      "Check your internet connection and reload the page. Or, in MATLAB, re-save it in the standard format: save('myfile.mat','-v7'), or export the data as CSV.");
    const header = latin1(u8.subarray(0, 116)).replace(/\0+$/, '').trim();
    const off = sigAt(u8, 512) ? 512 : sigAt(u8, 0) ? 0 : -1;
    if (off < 0) throw new InputError('This MATLAB v7.3 file has no HDF5 data after its header, so it is damaged or incomplete.', 'Re-save or re-download the file.');
    let file;
    try { file = new hdf5.File(u8.slice(off).buffer, 'file.mat'); }
    catch (e) { throw new InputError('This MATLAB v7.3 file could not be read (' + String(e && e.message || e) + ').', "In MATLAB, re-save it in the standard format: save('myfile.mat','-v7'). Or export the data as CSV."); }
    const vars = [];
    for (const name of file.keys) if (!name.startsWith('#')) vars.push(readMat73Node(file.get(name), name));
    return { header, variables: vars, v73: true };
  }

  function readMat73Node(node, name) {
    const attrs = node.attrs || {}, cls = String(attrs.MATLAB_class || '');
    if (node.keys !== undefined && typeof node.get === 'function') { // group: struct (or sparse, or object)
      if (attrs.MATLAB_sparse !== undefined) return { name, clsId: 5, cls: 'sparse', dims: [] };
      if (cls && cls !== 'struct') return { name, clsId: 17, cls: 'opaque', className: cls, dims: [] };
      const fields = {};
      for (const k of node.keys) fields[k] = readMat73Node(node.get(k), k);
      return { name, clsId: 2, cls: 'struct', fields, structCount: 1, dims: [1, 1] };
    }
    const shape = node.shape || [];
    if (attrs.MATLAB_object_decode !== undefined) return { name, clsId: 17, cls: 'opaque', className: cls, dims: [] };
    const clsId = MATLAB_CLASS_ID[cls];
    if (clsId === undefined) return { name, clsId: 17, cls: 'opaque', className: cls || 'object', dims: [] };
    if (clsId === 1 || clsId === 4 || clsId === 16) return { name, clsId, cls, dims: shape.slice().reverse() };
    if (attrs.MATLAB_empty !== undefined) return { name, clsId, cls, dims: [0, 0], data: new Float64Array(0), logical: cls === 'logical' };
    // MATLAB is column-major: HDF5 shape [c, r] holds an r×c matrix, already in MATLAB's order
    const dims = shape.slice().reverse();
    while (dims.length < 2) dims.push(1);
    // MATLAB stores complex numbers as a (real, imag) compound type; jsfive throws on reading one
    let complex = false;
    try { const dt = node.dtype; complex = Array.isArray(dt) && dt[0] === 'COMPOUND'; } catch (e) { complex = /compound/i.test(String(e && e.message || e)); if (!complex) throw e; }
    const v = { name, clsId, cls: cls === 'logical' ? 'logical' : cls, dims, logical: cls === 'logical', complex };
    if (complex) return Object.assign(v, { data: new Float64Array(0) });
    patchCompactStorage(node);
    try { v.data = Float64Array.from(node.value, Number); }
    catch (e) { return { name, clsId: 0, cls: cls || '?', dims: [], unreadable: 'could not be read (' + String(e && e.message || e) + ')' }; }
    return v;
  }

  /* Walk parsed variables and list numeric matrices that could hold sensor data. */
  function matCandidates(vars) {
    const cands = [], notes = [];
    function visit(v, path) {
      if (!v) return;
      if (v.unreadable) { notes.push({ path, reason: '"' + path + '" ' + v.unreadable + '.', fix: "In MATLAB, re-save it in the standard format: save('myfile.mat','-v7'), or export the data as CSV." }); return; }
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

  /* phyphox puts its metadata next to the data, in meta/time.csv and meta/device.csv. */
  function phyphoxMetaFile(headerLine) {
    const h = headerLine.split(/[,;\t]/).map(v => v.trim().replace(/^"|"$/g, '').toLowerCase()).join('|');
    if (h.startsWith('event|experiment time|system time')) return 'meta/time.csv, which holds only the times the recording started and paused';
    if (h === 'property|value') return 'meta/device.csv, which describes the phone and its sensors';
    return null;
  }

  function parseCsv(text) {
    text = text.replace(/^\uFEFF/, '');
    // Physics Toolbox (newer versions) and the dashboard's recorder start with '# key: value'
    // metadata lines: kept in meta, skipped as data.
    const all = text.split(/\r\n|\n|\r/), meta = {};
    for (const l of all) {
      const m = /^\s*#\s*([^:]+?)\s*:\s*(.*?)\s*$/.exec(l);
      if (m && !(m[1] in meta)) meta[m[1]] = m[2];
    }
    const lines = all.filter(l => l.trim() !== '' && !l.trimStart().startsWith('#'));
    if (lines.length < 2) throw new InputError('The CSV file has fewer than 2 lines of data.', 'Record for longer, or check that the export completed.');
    const metaFile = phyphoxMetaFile(lines[0]);
    if (metaFile) throw new InputError('This is phyphox\'s ' + metaFile + ', not the sensor data.', 'Upload the whole zip that phyphox exported, or the "Raw Data.csv" inside it.');
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
    // decimal commas come with ';' (Physics Toolbox) or tabs (phyphox "Tabulator, decimal comma")
    const decimalComma = (delim === ';' || delim === '\t') && sample.slice(1).some(l => /\d,\d/.test(l));
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
    return { names, cols: keep, meta, hasHeader: !!headers, delim, decimalComma, dropped,
      clockTime: clockCol.some(c => c > body.length * 0.5) };
  }

  /* ------------------------------------------------------------------ ZIP */
  function isZip(u8) { return u8.length >= 4 && u8[0] === 0x50 && u8[1] === 0x4b && u8[2] === 3 && u8[3] === 4; }

  /* Files in a zip archive, from its central directory: [{name, size, read()}]. read()
     returns the bytes, inflated with inflateRaw (pako's) when the entry is deflated. */
  function parseZip(u8, inflateRaw) {
    const damaged = () => new InputError('This zip file is incomplete or damaged.', 'Export it again, or unzip it and upload the CSV inside.');
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let eocd = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 22 - 65535); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw damaged();
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const entries = [];
    for (let k = 0; k < count; k++) {
      if (p + 46 > u8.length || dv.getUint32(p, true) !== 0x02014b50) throw damaged();
      const flags = dv.getUint16(p + 8, true), method = dv.getUint16(p + 10, true);
      const csize = dv.getUint32(p + 20, true), size = dv.getUint32(p + 24, true);
      const nlen = dv.getUint16(p + 28, true), skip = dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true);
      const local = dv.getUint32(p + 42, true);
      const name = new TextDecoder('utf-8').decode(u8.subarray(p + 46, p + 46 + nlen));
      p += 46 + nlen + skip;
      if (name.endsWith('/')) continue; // folder
      entries.push({ name, size, read() {
        if (flags & 1) throw new InputError('"' + name + '" in the zip is password-protected.', 'Unzip it yourself and upload the CSV inside.');
        if (csize === 0xffffffff || size === 0xffffffff) throw new InputError('The zip uses the ZIP64 format, which is not supported.', 'Unzip it and upload the CSV inside.');
        if (local + 30 > u8.length || dv.getUint32(local, true) !== 0x04034b50) throw damaged();
        const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
        if (start + csize > u8.length) throw damaged();
        const raw = u8.subarray(start, start + csize);
        let out;
        if (method === 0) out = raw;
        else if (method === 8) {
          if (!inflateRaw) throw new InputError('The zip is compressed and the decompressor did not load.', 'Check your internet connection and reload the page.');
          try { out = inflateRaw(raw); } catch (e) { throw damaged(); }
        } else throw new InputError('"' + name + '" in the zip uses a compression method this page cannot read (' + method + ').', 'Unzip it and upload the CSV inside.');
        if (!out || out.length !== size) throw damaged();
        return out;
      } });
    }
    return entries;
  }

  /* A phyphox export: a zip holding the data ("Raw Data.csv") and meta/device.csv and
     meta/time.csv. Returns {text, name, checks}: the data CSV's text and what the
     metadata says (phone, sensor chip, start time, length, pauses). */
  function readPhyphoxZip(u8, inflateRaw) {
    const entries = parseZip(u8, inflateRaw);
    const base = e => e.name.split('/').pop();
    const isMeta = e => /(^|\/)meta\//.test(e.name);
    const csvs = entries.filter(e => /\.(csv|txt|tsv)$/i.test(e.name) && !isMeta(e) && !/(^|\/)__MACOSX\//.test(e.name));
    if (!csvs.length) {
      const xls = entries.some(e => /\.xlsx?$/i.test(e.name));
      throw new InputError(xls ? 'This zip holds an Excel export, not a CSV.' : 'This zip holds no CSV file' + (entries.length ? ' (it has ' + entries.slice(0, 4).map(base).join(', ') + (entries.length > 4 ? ', …' : '') + ').' : '.'),
        'In phyphox, choose Export data → CSV (comma, decimal point) and upload that zip, or upload the CSV itself.');
    }
    const data = csvs.find(e => base(e) === 'Raw Data.csv') || csvs.reduce((a, b) => (b.size > a.size ? b : a));
    const text = new TextDecoder('utf-8').decode(data.read());
    const checks = [];
    const others = csvs.filter(e => e !== data).map(base);
    const metaFile = name => entries.find(e => isMeta(e) && base(e) === name);
    const rows = e => { try { return metaRows(new TextDecoder('utf-8').decode(e.read())); } catch (err) { return null; } };
    const dev = metaFile('device.csv') && rows(metaFile('device.csv'));
    const time = metaFile('time.csv') && rows(metaFile('time.csv'));
    const props = new Map((dev || []).slice(1).map(r => [r[0], r[1]]));
    const prop = k => { const v = props.get(k); return v && v !== 'null' ? v : ''; };

    const parts = [];
    const model = prop('deviceModel'), brand = prop('deviceManufacturer') || prop('deviceBrand');
    if (model) parts.push('recorded on ' + (brand && !model.toLowerCase().startsWith(brand.toLowerCase()) ? brand + ' ' : '') + model + (prop('version') ? ' with phyphox ' + prop('version') : ''));
    const header = (text.split(/\r\n|\n|\r/)[0] || '').toLowerCase();
    const sensorKey = /linear acceleration/.test(header) ? 'linear_acceleration' : /acceleration [xyz]/.test(header) ? 'accelerometer'
      : /gyroscope/.test(header) ? 'gyroscope' : /magnetic/.test(header) ? 'magnetic_field' : null;
    if (sensorKey && prop(sensorKey + ' Name')) parts.push('sensor: ' + prop(sensorKey + ' Name') + (prop(sensorKey + ' Vendor') ? ' (' + prop(sensorKey + ' Vendor') + ')' : ''));
    // time.csv: one START and one PAUSE row per stretch of recording, in experiment time,
    // which leaves out the pauses (and system time, which does not)
    const events = (time || []).slice(1).map(r => ({ event: (r[0] || '').toUpperCase(), t: metaNumber(r[1]), text: r[3] || '' })).filter(e => Number.isFinite(e.t));
    const starts = events.filter(e => e.event === 'START');
    if (starts.length && starts[0].text) parts.push('started ' + starts[0].text);
    const last = events[events.length - 1];
    if (last && last.event === 'PAUSE') parts.push(fmt(last.t, 1) + ' s of recording');
    checks.push({ level: 'pass', title: 'phyphox export read', detail: '"' + data.name + '" from the zip' + (parts.length ? '; ' + parts.join(', ') : '') + '.' +
      (others.length ? ' Also in the zip, not used: ' + others.join(', ') + '.' : '') + (dev || time ? '' : ' No meta/ folder, so there are no recording details.') });
    if (starts.length > 1) {
      const joins = starts.slice(1).map(e => fmt(e.t, 1) + ' s');
      checks.push({ level: 'warn', title: 'Recording paused ' + (starts.length - 1) + ' time' + (starts.length > 2 ? 's' : ''),
        detail: 'phyphox’s time leaves out pauses, so the stretches are joined with no gap at ' + joins.join(', ') + '. A step across a join can be missed or counted twice, and the interval across it is wrong.' });
    }
    return { text, name: data.name, checks };
  }

  /* Rows of a small quoted CSV (phyphox meta files), in whichever delimiter it uses. */
  function metaRows(text) {
    const lines = text.replace(/^﻿/, '').split(/\r\n|\n|\r/).filter(l => l.trim() !== '');
    if (!lines.length) return [];
    const m = lines[0].match(/^"[^"]*"([,;\t])/), delim = m ? m[1] : ',';
    return lines.map(l => {
      const out = [];
      let cur = '', q = false;
      for (const ch of l) {
        if (ch === '"') q = !q;
        else if (ch === delim && !q) { out.push(cur); cur = ''; }
        else cur += ch;
      }
      out.push(cur);
      return out.map(v => v.trim());
    });
  }
  // decimal comma in the "decimal comma" exports
  function metaNumber(s) { return s === undefined || s === '' ? NaN : Number(String(s).replace(',', '.')); }

  /* ------------------------------------------------- browser recording (#51) */
  const STANDARD_GRAVITY = 9.80665; // m/s² in 1 g
  const PHONE_POSITIONS = { hand: 'hand', 'front pocket': 'front pocket', 'back pocket': 'back pocket', other: 'other' };

  /* A recording from the browser's devicemotion events as CSV text, in the layout both
     readers already take: '# key: value' metadata lines, then one row per event, every
     sample with its own timestamp (no resampling). samples: [{ts (ms, event.timeStamp),
     g: [x, y, z] (accelerationIncludingGravity, m/s²), a: [x, y, z] or null (acceleration,
     gravity removed), r: [alpha, beta, gamma] or null (rotationRate, °/s)}]. Columns:
     time (s from the first sample); gFx, gFy, gFz, TgF in g with gravity, like Physics
     Toolbox's G-Force Meter (so x, y, z are these); ax, ay, az, aT in m/s² without
     gravity, like its Linear Accelerometer; wx, wy, wz in rad/s, like its gyroscope. The
     last two groups only when the browser gave them. Numbers are written in full, so the
     file reads back to the same values. meta: {key: value} written as metadata lines. */
  function recordingCsv(samples, meta) {
    const has = k => samples.some(s => s[k] && s[k].every(Number.isFinite));
    const lin = has('a'), rot = has('r');
    const head = ['time', 'gFx (g)', 'gFy (g)', 'gFz (g)', 'TgF (g)'];
    if (lin) head.push('ax (m/s^2)', 'ay (m/s^2)', 'az (m/s^2)', 'aT (m/s^2)');
    if (rot) head.push('wx (rad/s)', 'wy (rad/s)', 'wz (rad/s)');
    const num = v => (Object.is(v, -0) ? '-0' : Number.isFinite(v) ? String(v) : '');
    const ts0 = samples.length ? samples[0].ts : 0, deg = Math.PI / 180;
    const rows = samples.map(s => {
      const g = s.g.map(v => v / STANDARD_GRAVITY), out = [(s.ts - ts0) / 1000, ...g, Math.hypot(...g)];
      if (lin) out.push(...(s.a ? [...s.a, Math.hypot(...s.a)] : [NaN, NaN, NaN, NaN]));
      // rotationRate: alpha about x, beta about y, gamma about z (W3C Device Orientation and
      // Motion §6.3.2; the owner's Android and iPad recordings agree, #93)
      if (rot) out.push(...(s.r ? [s.r[0] * deg, s.r[1] * deg, s.r[2] * deg] : [NaN, NaN, NaN]));
      return out.map(num).join(',');
    });
    const metaLines = Object.entries(meta || {}).filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => '# ' + k + ': ' + String(v).replace(/[\r\n]+/g, ' '));
    return metaLines.concat([head.join(',')], rows).join('\n') + '\n';
  }

  /* Checks for a finished recording, before it is loaded. {ok, checks}; ok false when it is
     too short to analyse. stopped: 'user' | 'hidden' (screen locked, app switched) | 'limit'. */
  function recordingChecks(samples, stopped) {
    const checks = [], n = samples.length;
    const dur = n > 1 ? (samples[n - 1].ts - samples[0].ts) / 1000 : 0;
    if (n < MIN_ROWS || dur < 3) {
      return { ok: false, checks: [{ level: 'error', title: 'Recording too short', detail: 'Only ' + n + ' sample' + (n === 1 ? '' : 's') + (n > 1 ? ' over ' + fmt(dur, 1) + ' s' : '') + ' were captured.' +
        (stopped === 'hidden' ? ' It stopped because the screen locked or the page went to the background.' : ''),
        fix: 'Record at least 10 s of walking, with the page open and the screen on.' }] };
    }
    if (stopped === 'hidden') checks.push({ level: 'warn', title: 'Recording stopped early', detail: 'The screen locked or the page went to the background after ' + fmt(dur, 1) + ' s, and the phone stops sending motion data then. What was captured up to that point is kept.', fix: 'Keep the page open with the screen on; the overlay keeps pocket touches from changing anything.' });
    if (stopped === 'limit') checks.push({ level: 'info', title: 'Recording stopped at the time limit', detail: 'Recordings stop after ' + fmt(dur / 60, 0) + ' minutes.' });
    return { ok: true, checks };
  }

  /* -------------------------------------------------------- column roles */
  const RX = {
    time: /^(time|t|elapsed|timestamp|seconds|sec)\b/i,
    x: /^(gfx|ax|wx|bx|mx|x|acc_?x|accel_?x|acceleration_?x|lin_?acc_?x|(linear )?acceleration x)\b/i,
    y: /^(gfy|ay|wy|by|my|y|acc_?y|accel_?y|acceleration_?y|lin_?acc_?y|(linear )?acceleration y)\b/i,
    z: /^(gfz|az|wz|bz|mz|z|acc_?z|accel_?z|acceleration_?z|lin_?acc_?z|(linear )?acceleration z)\b/i,
    mag: /^(tgf|at|wt|bt|total|magnitude|mag|norm|a_?total|resultant|absolute( linear)? acceleration)\b/i,
  };
  const LINACC = { key: 'linacc', label: 'Linear accelerometer', unit: 'm/s²', gravity: false, accel: true };

  function sensorFromName(name) {
    name = name.replace(/\s*\(.*\)\s*$/, ''); // 'ax (m/s^2)' -> 'ax'
    if (/^(gf[xyz]|tgf)$/i.test(name)) return { key: 'gforce', label: 'G-Force Meter', unit: 'g', gravity: true, accel: true };
    if (/^(a[xyzt])$/i.test(name)) return LINACC;
    // phyphox: 'Acceleration x' keeps gravity, 'Linear Acceleration x' doesn't. Both call the
    // magnitude 'Absolute acceleration', so that one takes its sensor from x in buildDataset.
    if (/^linear acceleration [xyz]$/i.test(name)) return LINACC;
    if (/^acceleration [xyz]$/i.test(name)) return { key: 'acc', label: 'Accelerometer', unit: 'm/s²', gravity: true, accel: true };
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
    if (mag && !mag.sensor && x && x.sensor) mag.sensor = x.sensor;

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
        ? (!sensor.gravity ? ' Gravity is removed, so a still phone reads near 0.'
          : sensor.unit === 'g' ? ' Includes gravity: an upright phone reads about 1 g on one axis, so Coza\u2019s threshold h = 1 sits right at the resting level.'
            : ' Includes gravity: a still phone reads about 9.8 m/s² in total, so Coza\u2019s threshold h = 1, chosen for data in g, sits far below the resting level of whichever axis points up. Dividing by 9.81 gives g.')
        : ' This sensor does not measure acceleration. Steps may still show up as peaks, but Coza\u2019s threshold h = 1 has no physical meaning here.';
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
      if (best.mu > 0.8 && best.mu < 1.25) return { level: 'info', title: 'Units: probably g (with gravity)', detail: 'At rest the magnitude is about ' + best.mu.toFixed(2) + ', which matches 1 g. Coza\u2019s threshold h = 1 is at the resting level, so check detections carefully.' };
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
    return gapRate(dts);
  }
  /* The sampling rate from the gaps between timestamps (all > 0): the mean of the gaps within
     half to 1.5 times the median. The median alone is off when the times are rounded: Firefox
     on Android gives whole milliseconds, so a 57.4 Hz recording has gaps of 16, 17 and 18 ms and
     its median says 58.8 Hz (the owner's Pixel 9a, 2026-10-07). A plain mean would count dropped
     samples and pauses (Physics Toolbox's Linear Accelerometer drops some: 50 instead of 57.4
     Hz). Summed in order, like sampling_rate in python/lab_step_det.py, so both give the same
     number. */
  function gapRate(dts) {
    const md = median(dts);
    let s = 0, n = 0;
    for (const d of dts) if (d >= 0.5 * md && d <= 1.5 * md) { s += d; n++; }
    return n / s;
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
        ? { level: 'info', title: 'Vertical acceleration from the direction of gravity', detail: 'Gravity is x, y, z low-passed at ' + GRAVITY_CUTOFF + ' Hz (' + fmt(gs.gravity, 2) + ' on average). Each sample is projected onto it and gravity is subtracted, so standing still reads 0 whatever the phone\u2019s tilt. Coza and Coza (modified) compare peaks with h, which then belongs a little above 0 (about 0.1 g or 1 m/s\u00b2), not at 1.' }
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
      fs = gapRate(dts);
      const jitter = std(dts) / md;
      let gaps = 0, maxGap = 0;
      for (const d of dts) if (d > 5 * md) { gaps++; maxGap = Math.max(maxGap, d); }
      checks.push({ level: fs < 10 ? 'warn' : 'pass', title: 'Sampling rate about ' + fmt(fs, fs >= 100 ? 0 : 1) + ' Hz',
        detail: 'Measured from the timestamps. Timing varies by ' + Math.round(jitter * 100) + '% between samples' + (jitter > 0.25 ? ', which is typical of phone apps.' : '.') +
          (fs < 10 ? ' This is too slow to resolve individual steps reliably.' : '') });
      const rate = cozaRateCheck(fs);
      if (rate) checks.push(rate);
      if (dup) checks.push({ level: 'warn', title: dup + ' repeated timestamps', detail: 'Some consecutive samples share a timestamp. Durations still come from the timestamps, but those samples add no timing information.' });
      if (gaps) checks.push({ level: 'warn', title: gaps + ' gap' + (gaps > 1 ? 's' : '') + ' in the recording', detail: 'The longest pause between samples is ' + fmt(maxGap, 2) + ' s. Steps inside a gap cannot be detected.' });
    } else {
      checks.push({ level: 'info', title: 'Sampling rate set to ' + fs + ' Hz', detail: 'Change it in Recording settings if your device recorded at a different rate.' });
    }
    if (col && col.sensor && !col.sensor.accel) {
      checks.push({ level: 'warn', title: 'Not an acceleration signal', detail: cap(col.sensor.label) + ' data (' + col.sensor.unit + '). Walking still creates peaks, but Coza\u2019s threshold h = 1 has no physical meaning for it.' });
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

  // Coza divides by 100 to get seconds and counts its window w in samples: warn when what it
  // receives is over 5% away from 100 Hz. Shown while a Coza is on the plot (needs).
  function cozaRateCheck(fs, resampled) {
    if (!(Math.abs(fs - 100) / 100 > 0.05)) return null;
    return { level: 'warn', needs: 'coza_original', id: 'cozaRate', title: 'Coza assumes 100 Hz', detail: 'Coza divides by 100 to get seconds and counts its window w in samples, so its durations are off by ' + Math.round(Math.abs(100 / fs - 1) * 100) + '% for ' +
      (resampled ? 'the ' + fmt(fs, fs >= 100 ? 0 : 1) + ' Hz it receives after resampling' : 'this file') + ', and w = 30 covers \u00b1' + fmt(30 / fs, 2) + ' s instead of \u00b10.3 s. The other detectors use the real timestamps.' +
      (resampled ? '' : ' Resample (under Detection) can set a rate for everything, Coza included.') };
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
     measured rate (gapRate); phone jitter is small next to a few-Hz cut-off. A cut-off at or above fs/2
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
  // ...and a weak peak is dropped only when it is also out of rhythm: a gap to a neighbouring
  // peak under this share of the median gap (#81). A faint first or last step that falls on
  // the rhythm is kept; a bump that comes early, like the stop bump in Walking.mat, is not.
  const RHYTHM_RATIO = 0.75;

  // Coza (modified): Coza's detector with its bugs fixed. opts: {ties, weak, weakRatio}
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
      // with opts.rhythmRatio, a weak peak on the rhythm stays (gaps from opts.t, else samples)
      const at = i => (opts.t ? opts.t[i] : i);
      const gaps = idx.slice(1).map((i, k) => at(i) - at(idx[k])), medGap = median(gaps);
      const offRhythm = k => [k > 0 ? gaps[k - 1] : Infinity, k < gaps.length ? gaps[k] : Infinity].some(g => g < opts.rhythmRatio * medGap);
      const kept = [];
      idx.forEach((i, k) => { if (amp[k] >= opts.weakRatio * medAmp || (opts.rhythmRatio && !offRhythm(k))) kept.push(i); else weakDropped.push(i); });
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

  /* Parameters of an algorithm or envelope, from which the page builds its controls (one set
     per instance on the plot). {key, label, abbr (short name in summaries), type: 'range'
     (default) | 'number' | 'bool', min, max, step, default, unit, dec (decimals shown),
     samples (show the window in samples too), signalRange (slider spans the signal, for h),
     hint}. */
  const P_H = { key: 'h', label: 'Threshold h', abbr: 'h', type: 'number', min: -1e6, max: 1e6, step: 0.1, default: 1, dec: 2, signalRange: true };
  const P_W = { key: 'w', label: 'Window w', abbr: 'w', type: 'range', min: 1, max: 300, step: 1, default: 30, unit: 'samples', dec: 0, seconds: true,
    hint: 'Samples on each side, as in the .m file: \u00b10.3 s only at 100 Hz.' };
  const defaultParams = def => Object.fromEntries((def.params || []).map(q => [q.key, q.default]));
  // "w 30 · h 1": the parameters in a line, for legends and lists
  function paramSummary(def, p) {
    return (def.params || []).map(q => {
      const v = p[q.key];
      if (q.type === 'bool') return v ? q.abbr || q.label : '';
      const u = q.unit === '%' ? '%' : q.unit && q.unit !== 'samples' ? ' ' + q.unit : '';
      return (q.abbr || q.key) + ' ' + (q.unit === 'ordinal' ? ORDINAL(v) : q.type === 'number' ? String(+Number(v).toFixed(4)) + u : fmt(v, q.dec || 0) + u);
    }).filter(Boolean).join(' \u00b7 ');
  }

  /* Credits (#63): who made each method, shown with its settings, in docs/algorithm.md and
     in the export's indicators table. A credit is a list of {text: 'Surname et al., Year' or
     a name, doi? or url?, note? (what it is credited for)}; an empty list means none is
     needed. Every DOI was checked against Crossref (title, first author, year) on
     2026-10-07, and Zhao 2010 and Brajdic & Harle 2013 were read for what they are credited
     for: don't add one that hasn't been. Names only, never email addresses. */
  const CREDIT = {
    brajdic: { text: 'Brajdic & Harle, 2013', doi: '10.1145/2493432.2493449' },
    zhao: { text: 'Zhao, 2010', url: 'https://www.analog.com/en/resources/analog-dialogue/articles/pedometer-design-3-axis-digital-acceler.html', note: 'Analog Dialogue 44-06' },
    zeroPhase: { text: 'Likhterov & Kopeika, 2003', doi: '10.1080/00207210310001612482', note: 'start-up of the forward-backward filter' },
  };
  // "Savitzky & Golay, 1964 (https://doi.org/…)": a credit as one line of text, for exports
  const creditText = list => (list || []).map(c => c.text + (c.note ? ' (' + c.note + ')' : '') +
    (c.doi ? ' https://doi.org/' + c.doi : c.url ? ' ' + c.url : '')).join('; ');

  /* Step detectors offered in the dashboard, to put on the plot like a chart's indicators
     (any number, in any mix). The first, Coza, is LabStepDet_2025.m's rule as written
     (detectOriginal; with originalMetrics for its own outputs), bit-exact with MATLAB. The
     page opens with Coza and Coza (modified).
     Each entry:
       tagline   one line under the dropdown
       summary   shown in "How detection works"
       params    its settings (see P_H): the page builds the controls from them
       credit    who made it (shown with it)
       detect(A, t, p) -> {idx, weakDropped?, w?, markY?, guides?}
                 idx: 0-based step samples. markY: values the markers sit on (default A).
                 guides: up to two lines drawn with the signal, [{name, y, dash?}], where y is
                 an array (one value per sample) or a single number (a level line).
       settings(p, fx) -> [[name, value], ...] for the metrics export
     Metrics come from timingMetrics for every algorithm. p holds h, the sampling rate fs,
     the phone position and the detector's own params. */
  const ALGORITHMS = [
    {
      // Coza's rule exactly as LabStepDet_2025.m has it, bugs included: detectOriginal with
      // its own w (samples) and h. Its metrics come from the timestamps, like every
      // detector's; the metrics rows marked "Coza's formula" are the .m file's outputs.
      id: 'coza_original',
      name: 'Coza',
      tagline: 'The peak detector from BME 598/494 (Dr. Aurel Coza), exactly as written, bugs included.',
      credit: [{ text: 'Dr. Aurel Coza', note: 'BME 598/494; LabStepDet_2025.m' }],
      summary: 'Coza is LabStepDet_2025.m\u2019s rule unchanged: a sample is a step when it is the highest within w samples on each side and above h. The window counts samples, so it means \u00b10.3 s only at 100 Hz; tied peaks count twice and the stop bump counts as a step. Its metrics come from the timestamps, like every detector\u2019s; the rows marked \u201cCoza\u2019s formula\u201d reproduce the .m file\u2019s own outputs.',
      params: [P_W, P_H],
      detect: (A, t, p) => ({ idx: detectOriginal(A, p.w, p.h), weakDropped: [] }),
      settings: () => [],
    },
    {
      id: 'coza',
      name: 'Coza (modified)',
      tagline: 'Coza\u2019s detector with its bugs fixed.',
      credit: [{ text: 'Coza\u2019s detector, modified by Dr. Soroush Dianaty', note: 'tied peaks counted once, weak start/stop peaks dropped, window in seconds, real timestamps, cadence in steps/min, strides with Phone position One leg' }],
      summary: 'Coza (modified) fixes Coza\u2019s bugs: tied peaks are counted once, weak bumps out of rhythm (such as the stop bump) are dropped, the window is in seconds, timing comes from the real timestamps, and cadence is in steps/min.',
      params: [P_H, { key: 'cozaWindow', label: 'Window', abbr: 'window', min: 0.05, max: 1.5, step: 0.01, default: 0.3, unit: 's', dec: 2, samples: true },
        { key: 'weak', label: 'Drop weak peaks', abbr: 'weak peaks dropped', type: 'bool', default: true, hint: 'Ignore peaks that rise less than 40% as far above h as a typical peak and come out of rhythm, such as the bump when you stop walking. A faint first or last step on the rhythm is kept.' }],
      // Window in seconds, so it means the same at any sampling rate (Coza's w is samples).
      // Tied peaks are always counted once: Coza, beside it, shows the double count.
      detect: (A, t, p) => {
        const w = windowSamples(p.cozaWindow, p.fs, A.length);
        return Object.assign(detectCoza(A, w, p.h, { ties: true, weak: p.weak, weakRatio: WEAK_RATIO, rhythmRatio: RHYTHM_RATIO, t }), { w });
      },
      settings: (p, fx) => [['coza_window_s', p.cozaWindow], ['coza_window_samples', fx.w],
        ['fix_weak_peaks', p.weak ? 'on, below ' + Math.round(WEAK_RATIO * 100) + '% and out of rhythm (a gap under ' + Math.round(RHYTHM_RATIO * 100) + '%)' : 'off']],
    },
    {
      id: 'threshold',
      name: 'Threshold peaks',
      credit: [Object.assign({ note: 'windowed peak detection' }, CREDIT.brajdic)],
      tagline: 'Peaks of the smoothed signal above mean + k\u00b7SD.',
      summary: 'Threshold peaks is the textbook peak detector, with what Coza lacks: the signal is low-pass filtered first, the threshold is set from the signal itself (mean + k \u00d7 SD of the smoothed signal) instead of h, and of two peaks closer than the minimum interval only the taller one counts. Markers sit on the smoothed signal.',
      params: [{ key: 'tpCutoff', label: 'Low-pass cut-off', abbr: 'cut-off', min: 1, max: 10, step: 0.5, default: 3, unit: 'Hz', dec: 1 },
        { key: 'tpK', label: 'Threshold: mean + k × SD, k', abbr: 'k', min: -1, max: 2, step: 0.05, default: 0.5, unit: 'SD', dec: 2 },
        { key: 'tpMinInterval', label: 'Minimum interval', abbr: 'min', min: 0.1, max: 1, step: 0.05, default: 0.25, unit: 's', dec: 2 }],
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
      credit: [CREDIT.zhao],
      tagline: 'A peak followed by a valley, around a threshold that follows the signal.',
      summary: 'Peak-to-valley (min-max) uses a threshold that moves with the signal: the midpoint of the highest and lowest smoothed values within a sliding window. Each rise above it followed by a fall below it is a step, marked at its peak, when the peak-to-valley swing is at least a set share of the typical (median) swing. Steps closer than the minimum interval keep the larger swing. It does not use h.',
      params: [{ key: 'pvWindow', label: 'Threshold window', abbr: 'window', min: 0.3, max: 3, step: 0.1, default: 1, unit: 's', dec: 1 },
        { key: 'pvSwing', label: 'Minimum swing, of the median', abbr: 'swing', min: 0, max: 100, step: 5, default: 40, unit: '%', dec: 0 },
        { key: 'pvMinInterval', label: 'Minimum interval', abbr: 'min', min: 0.1, max: 1, step: 0.05, default: 0.25, unit: 's', dec: 2 }],
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
      credit: [Object.assign({ note: 'mean crossing counts' }, CREDIT.brajdic)],
      tagline: 'Upward crossings of the smoothed signal through its baseline.',
      summary: 'Zero-crossing uses timing, not peak height. The signal is low-pass filtered and a slow baseline (the signal low-passed at 0.3 Hz) is subtracted, which also removes gravity; each upward crossing of zero is a step. A hysteresis band (\u00b10.3 SD) stops noise near zero from adding crossings, and crossings closer than the minimum interval are ignored. Markers sit where the smoothed signal crosses its baseline, not on a peak. It does not use h.',
      params: [{ key: 'zcCutoff', label: 'Low-pass cut-off', abbr: 'cut-off', min: 1, max: 10, step: 0.5, default: 3, unit: 'Hz', dec: 1 },
        { key: 'zcMinInterval', label: 'Minimum interval', abbr: 'min', min: 0.1, max: 1, step: 0.05, default: 0.25, unit: 's', dec: 2 }],
      detect: (A, t, p) => {
        const r = detectZeroCrossing(A, t, p.fs, { cutoff: p.zcCutoff, minInterval: p.zcMinInterval });
        return { idx: r.idx, markY: r.smooth, band: r.band,
          guides: [{ name: 'Smoothed (' + p.zcCutoff + ' Hz)', y: r.smooth }, { name: 'Baseline (' + ZC_BASELINE + ' Hz)', y: r.baseline, dash: true }] };
      },
      settings: (p, fx) => [['lowpass_cutoff_hz', p.zcCutoff], ['baseline_cutoff_hz', ZC_BASELINE], ['hysteresis_sd', ZC_BAND],
        ['hysteresis_value', +fx.band.toFixed(6)], ['min_interval_s', p.zcMinInterval]],
    },
  ];

  /* Smoothing windows (moving average, median, Savitzky–Golay). The window is set in seconds
     and becomes an odd number of samples, 2·round(seconds·fs/2) + 1, so it is centred and
     means the same at any sampling rate. */
  function oddWindow(seconds, fs, n, min) {
    const w = 2 * Math.round(seconds * fs / 2) + 1;
    if (w < min) throw new RangeError('The window is ' + w + ' sample' + (w > 1 ? 's' : '') + ' at this sampling rate; it needs at least ' + min + '. Lengthen it to ' + fmt(min / fs, 3) + ' s or more.');
    if (w > n) throw new RangeError('The window (' + w + ' samples) is longer than the recording (' + n + ' samples). Shorten it.');
    return w;
  }
  // Edges repeat the first and last sample, like scipy.ndimage's mode='nearest'.
  function padNearest(A, h) {
    const n = A.length, x = new Float64Array(n + 2 * h);
    x.fill(A[0], 0, h); x.set(A, h); x.fill(A[n - 1], n + h);
    return x;
  }
  // Moving average, as scipy.ndimage.uniform_filter1d(A, w, mode='nearest').
  function movingAverage(A, w) {
    const h = (w - 1) / 2, x = padNearest(A, h), out = new Float64Array(A.length);
    let sum = 0;
    for (let i = 0; i < w; i++) sum += x[i];
    for (let i = 0; i < A.length; i++) { out[i] = sum / w; sum += x[i + w] - x[i]; }
    return out;
  }

  // Sliding median, as scipy.ndimage.median_filter(A, w, mode='nearest'): a sorted copy of the
  // window is kept, one sample in and one out per step.
  function movingMedian(A, w) {
    const h = (w - 1) / 2, x = padNearest(A, h), out = new Float64Array(A.length);
    const win = Array.from(x.subarray(0, w)).sort((a, b) => a - b);
    const find = v => { let lo = 0, hi = win.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (win[mid] < v) lo = mid + 1; else hi = mid; } return lo; };
    for (let i = 0; i < A.length; i++) {
      out[i] = win[h];
      if (i + 1 < A.length) { win.splice(find(x[i]), 1); win.splice(find(x[i + w]), 0, x[i + w]); }
    }
    return out;
  }

  /* Savitzky–Golay, as scipy.signal.savgol_filter(A, w, order, mode='interp'): a polynomial of
     the given order is fitted by least squares to each window and its centre value kept; the
     first and last half-windows take the values of the polynomial fitted to the first and
     last full window. Positions are scaled to [−1, 1] so the fit stays well conditioned. */
  function savgolWeights(w, order) {
    const h = (w - 1) / 2, P = order + 1;
    const u = Array.from({ length: w }, (_, j) => (j - h) / h);
    // G = VᵀV, then W = G⁻¹Vᵀ by Gauss–Jordan on [G | Vᵀ]
    const M = Array.from({ length: P }, (_, r) => {
      const row = new Array(P + w);
      for (let c = 0; c < P; c++) { let sum = 0; for (let j = 0; j < w; j++) sum += Math.pow(u[j], r + c); row[c] = sum; }
      for (let j = 0; j < w; j++) row[P + j] = Math.pow(u[j], r);
      return row;
    });
    for (let c = 0; c < P; c++) {
      let piv = c;
      for (let r = c + 1; r < P; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
      [M[c], M[piv]] = [M[piv], M[c]];
      const d = M[c][c];
      for (let k = 0; k < P + w; k++) M[c][k] /= d;
      for (let r = 0; r < P; r++) if (r !== c) { const f = M[r][c]; if (f) for (let k = 0; k < P + w; k++) M[r][k] -= f * M[c][k]; }
    }
    // weights for the fitted value at window position q: Σ_k u_q^k W[k][·]
    return q => { const out = new Float64Array(w); for (let k = 0; k < P; k++) { const uk = Math.pow(u[q], k); for (let j = 0; j < w; j++) out[j] += uk * M[k][P + j]; } return out; };
  }
  function savgol(A, w, order) {
    const n = A.length, h = (w - 1) / 2, at = savgolWeights(w, order), mid = at(h), out = new Float64Array(n);
    const dot = (wt, start) => { let sum = 0; for (let j = 0; j < w; j++) sum += wt[j] * A[start + j]; return sum; };
    for (let i = h; i < n - h; i++) out[i] = dot(mid, i - h);
    for (let q = 0; q < h; q++) { out[q] = dot(at(q), 0); out[n - h + q] = dot(at(h + 1 + q), n - w); }
    return out;
  }

  // Notch: removes one narrow band around f0 (Hz), bandwidth f0/Q, as scipy's iirnotch(f0, Q, fs).
  function notchSos(f0, Q, fs) {
    if (!(f0 > 0 && f0 < fs / 2)) throw new RangeError('The notch frequency must be above 0 and below half the sampling rate: under ' + fmt(fs / 2, 1) + ' Hz for this recording.');
    if (!(Q > 0)) throw new RangeError('The notch quality factor Q must be above 0.');
    const w0 = 2 * Math.PI * f0 / fs, beta = Math.tan(w0 / Q / 2), gain = 1 / (1 + beta);
    return [[gain, -2 * gain * Math.cos(w0), gain, 1, -2 * gain * Math.cos(w0), 2 * gain - 1]];
  }

  /* Wavelet denoising with Daubechies-4, as PyWavelets: wavedec(A, 'db4', mode='symmetric',
     level), soft-threshold every detail level at the universal threshold σ·√(2 ln n) times
     scale (σ from the finest level: median |d| / 0.6745), waverec, cut to the input length.
     Noise spreads thinly over the detail coefficients and is removed; steps and heel strikes
     are a few large coefficients and stay, sharp edges included. */
  const DB4_DEC_LO = [-0.010597401785069032, 0.0328830116668852, 0.030841381835560764, -0.18703481171909309,
    -0.027983769416859854, 0.6308807679298589, 0.7148465705529157, 0.2303778133088965];
  const DB4 = (() => {
    const recLo = DB4_DEC_LO.slice().reverse(), decHi = recLo.map((v, k) => (k % 2 ? 1 : -1) * v);
    return { decLo: DB4_DEC_LO, decHi, recLo, recHi: decHi.slice().reverse() };
  })();
  // x at index k with half-sample symmetric extension (…cba|abc…cba|…), as PyWavelets 'symmetric'
  const symAt = (x, k) => { const n = x.length, m = ((k % (2 * n)) + 2 * n) % (2 * n); return m < n ? x[m] : x[2 * n - 1 - m]; };
  function dwt(x, w = DB4) {
    const n = x.length, F = w.decLo.length, len = Math.floor((n + F - 1) / 2), cA = new Float64Array(len), cD = new Float64Array(len);
    for (let o = 0; o < len; o++) {
      let a = 0, d = 0;
      for (let j = 0; j < F; j++) { const v = symAt(x, 2 * o + 1 - j); a += w.decLo[j] * v; d += w.decHi[j] * v; }
      cA[o] = a; cD[o] = d;
    }
    return { cA, cD };
  }
  // inverse: the coefficients upsampled by 2 and convolved with the reconstruction filters,
  // keeping the 2·len − F + 2 samples PyWavelets keeps
  function idwt(cA, cD, w = DB4) {
    const N = cA.length, F = w.recLo.length, out = new Float64Array(2 * N - F + 2);
    for (let m = 0; m < out.length; m++) {
      const nn = m + F - 2; let sum = 0;
      for (let j = nn % 2; j < F; j += 2) { const k = (nn - j) / 2; if (k >= 0 && k < N) sum += w.recLo[j] * cA[k] + w.recHi[j] * cD[k]; }
      out[m] = sum;
    }
    return out;
  }
  function waveletDenoise(A, level, scale) {
    const n = A.length, F = DB4.decLo.length, maxLevel = Math.floor(Math.log2(n / (F - 1)));
    if (!(level >= 1 && Number.isInteger(level))) throw new RangeError('The number of wavelet levels must be a whole number from 1.');
    if (level > maxLevel) throw new RangeError('This recording is too short for ' + level + ' wavelet levels: at most ' + Math.max(0, maxLevel) + '.');
    const ds = []; let a = A;
    for (let l = 0; l < level; l++) { const r = dwt(a); ds.unshift(r.cD); a = r.cA; }
    const sigma = median(Array.from(ds[ds.length - 1], Math.abs)) / 0.6745, T = scale * sigma * Math.sqrt(2 * Math.log(n));
    for (const d of ds) for (let k = 0; k < d.length; k++) d[k] = Math.sign(d[k]) * Math.max(Math.abs(d[k]) - T, 0);
    for (const d of ds) { if (a.length === d.length + 1) a = a.subarray(0, d.length); a = idwt(a, d); }
    return a.slice(0, n);
  }

  /* Signal filters offered in the dashboard. A filter changes the signal the selected
     indicators set to Filtered run on; one set to Unfiltered keeps the recorded signal.
     Each entry: tagline (one line under the dropdown), credit (see CREDIT), apply(A, fs, p) -> filtered copy of
     evenly spaced samples (throws a RangeError saying what to change when the settings
     can't be used), label(p) for the export. Its settings are the rows under Advanced whose
     data-only lists its id. p: {filter, fOrder, fLow (Hz), fHigh (Hz, 0 = off), fRipple (dB),
     fAtten (dB)} */
  const ORDINAL = n => n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th');
  // IIR filters from designFilter, run forwards and backwards
  const iirEntry = (id, name, tagline, credit, extra) => ({
    id, name, tagline, credit: credit.concat(CREDIT.zeroPhase), iir: true,
    apply: (A, fs, p) => sosfiltfilt(designFilter({ type: id, order: p.fOrder, fs, lowpass: p.fLow, highpass: p.fHigh, rp: p.fRipple, rs: p.fAtten }).sos, A),
    label: p => name + ', ' + ORDINAL(p.fOrder) + ' order, ' + (p.fHigh > 0 ? fmt(p.fHigh, 1) + '\u2013' + fmt(p.fLow, 1) + ' Hz band-pass' : fmt(p.fLow, 1) + ' Hz low-pass') + (extra ? extra(p) : ''),
  });
  const FILTERS = [
    { id: 'none', name: 'None', tagline: 'Detection runs on the recorded signal.', credit: [] },
    iirEntry('butter', 'Butterworth', 'Flat passband and the gentlest roll-off: the least change to the shape of each step.',
      [{ text: 'Butterworth, 1930', note: 'Wireless Engineer 7: 536\u2013541' }]),
    iirEntry('bessel', 'Bessel', 'The most even delay across frequencies: steps keep their shape best, with the gentlest roll-off. The cut-off is where the phase is half delayed, not the -3 dB point.',
      [{ text: 'Thomson, 1949', doi: '10.1049/pi-3.1949.0101' }]),
    iirEntry('cheby1', 'Chebyshev I', 'A steeper roll-off, paid for with ripple in the passband that slightly reshapes peaks.', [], p => ', ' + fmt(p.fRipple, 1) + ' dB ripple'),
    iirEntry('cheby2', 'Chebyshev II', 'A steep roll-off with a flat passband; the ripple is in the stopband. The cut-off is where the stopband starts.', [], p => ', ' + fmt(p.fAtten, 0) + ' dB stopband'),
    iirEntry('ellip', 'Elliptic', 'The steepest roll-off for its order, with ripple in both passband and stopband. The cut-off is where the passband ripple ends.',
      [{ text: 'Cauer, 1931', note: 'Siebschaltungen' }], p => ', ' + fmt(p.fRipple, 1) + ' dB ripple, ' + fmt(p.fAtten, 0) + ' dB stopband'),
    {
      id: 'movavg', name: 'Moving average',
      tagline: 'The mean over a sliding window: the simplest smoother. It also lowers peaks.',
      credit: [],
      apply: (A, fs, p) => movingAverage(A, oddWindow(p.maWindow, fs, A.length, 3)),
      label: p => 'Moving average, ' + fmt(p.maWindow, 2) + ' s window',
    },
    {
      id: 'median', name: 'Median',
      tagline: 'The median over a sliding window: removes short spikes (a tap or knock) without rounding off real peaks.',
      credit: [{ text: 'Tukey, 1977', note: 'Exploratory Data Analysis' }],
      apply: (A, fs, p) => movingMedian(A, oddWindow(p.medWindow, fs, A.length, 3)),
      label: p => 'Median, ' + fmt(p.medWindow, 2) + ' s window',
    },
    {
      id: 'savgol', name: 'Savitzky\u2013Golay',
      tagline: 'Fits a polynomial to a sliding window and keeps its centre: smooths noise while keeping peak heights and timing better than an average.',
      credit: [{ text: 'Savitzky & Golay, 1964', doi: '10.1021/ac60214a047' }],
      apply: (A, fs, p) => {
        const w = oddWindow(p.sgWindow, fs, A.length, p.sgOrder + 2);
        return savgol(A, w, p.sgOrder);
      },
      label: p => 'Savitzky\u2013Golay, ' + fmt(p.sgWindow, 2) + ' s window, order ' + p.sgOrder,
    },
    {
      id: 'wavelet', name: 'Wavelet (Daubechies-4)',
      tagline: 'Splits the signal into frequency bands over time and removes the small, noise-like detail. It keeps sharp heel strikes better than a low-pass that removes as much noise; a lower threshold keeps more.',
      credit: [{ text: 'Donoho & Johnstone, 1994', doi: '10.1093/biomet/81.3.425', note: 'universal threshold' },
        { text: 'Donoho, 1995', doi: '10.1109/18.382009', note: 'soft thresholding' },
        { text: 'Daubechies, 1988', doi: '10.1002/cpa.3160410705', note: 'db4 wavelet' }],
      apply: (A, fs, p) => waveletDenoise(A, p.wLevel, p.wScale),
      label: p => 'Wavelet db4, ' + p.wLevel + ' levels, soft threshold \u00d7 ' + fmt(p.wScale, 2),
    },
    {
      id: 'notch', name: 'Notch',
      tagline: 'Removes one narrow frequency, such as 50/60 Hz mains hum or a known vibration, and leaves the rest. Matters only at high sampling rates.',
      credit: [CREDIT.zeroPhase],
      apply: (A, fs, p) => sosfiltfilt(notchSos(p.notchFreq, p.notchQ, fs), A),
      label: p => 'Notch, ' + fmt(p.notchFreq, 1) + ' Hz, Q ' + p.notchQ,
    },
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
  /* ------------------------------------------------------- frequency domain (#36) */
  // Discrete Fourier transform of any length, as numpy.fft.fft: radix-2 for powers of two,
  // Bluestein's chirp-z (a power-of-two convolution) otherwise. Returns {re, im}.
  function fft(re, im) {
    const n = re.length;
    im = im || new Float64Array(n);
    if (n <= 1) return { re: Float64Array.from(re), im: Float64Array.from(im) };
    if ((n & (n - 1)) === 0) return fftPow2(Float64Array.from(re), Float64Array.from(im));
    // Bluestein: X_k = w_k Σ (x_j w_j) conj(w_{k−j}), w_k = exp(−iπk²/n); k² is taken mod 2n so
    // the angle stays exact for long signals
    let m = 1; while (m < 2 * n - 1) m *= 2;
    const wr = new Float64Array(n), wi = new Float64Array(n);
    for (let k = 0; k < n; k++) { const a = Math.PI * ((k * k) % (2 * n)) / n; wr[k] = Math.cos(a); wi[k] = -Math.sin(a); }
    const ar = new Float64Array(m), ai = new Float64Array(m), br = new Float64Array(m), bi = new Float64Array(m);
    for (let k = 0; k < n; k++) { ar[k] = re[k] * wr[k] - im[k] * wi[k]; ai[k] = re[k] * wi[k] + im[k] * wr[k]; }
    br[0] = wr[0]; bi[0] = -wi[0];
    for (let k = 1; k < n; k++) { br[k] = br[m - k] = wr[k]; bi[k] = bi[m - k] = -wi[k]; }
    const A = fftPow2(ar, ai), B = fftPow2(br, bi);
    for (let k = 0; k < m; k++) { const r = A.re[k] * B.re[k] - A.im[k] * B.im[k]; A.im[k] = A.re[k] * B.im[k] + A.im[k] * B.re[k]; A.re[k] = r; }
    const c = ifftPow2(A.re, A.im);
    const outR = new Float64Array(n), outI = new Float64Array(n);
    for (let k = 0; k < n; k++) { outR[k] = c.re[k] * wr[k] - c.im[k] * wi[k]; outI[k] = c.re[k] * wi[k] + c.im[k] * wr[k]; }
    return { re: outR, im: outI };
  }
  // inverse, as numpy.fft.ifft (divided by n)
  function ifft(re, im) {
    const n = re.length, f = fft(re, Float64Array.from(im, v => -v));
    for (let k = 0; k < n; k++) { f.re[k] /= n; f.im[k] = -f.im[k] / n; }
    return f;
  }
  function fftPow2(re, im) { // in place, iterative radix-2; twiddles from a table for accuracy
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
    }
    const cs = new Float64Array(n / 2), sn = new Float64Array(n / 2);
    for (let k = 0; k < n / 2; k++) { cs[k] = Math.cos(2 * Math.PI * k / n); sn[k] = -Math.sin(2 * Math.PI * k / n); }
    for (let len = 2; len <= n; len *= 2) {
      const half = len / 2, step = n / len;
      for (let i = 0; i < n; i += len) {
        for (let k = 0; k < half; k++) {
          const wr = cs[k * step], wi = sn[k * step], a = i + k, b = a + half;
          const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        }
      }
    }
    return { re, im };
  }
  function ifftPow2(re, im) {
    const n = re.length, f = fftPow2(Float64Array.from(re), Float64Array.from(im, v => -v));
    for (let k = 0; k < n; k++) { f.re[k] /= n; f.im[k] = -f.im[k] / n; }
    return f;
  }

  /* Short-time spectra, as scipy.signal.spectrogram(A, fs, window='hann', nperseg, noverlap,
     nfft, detrend='constant', scaling='density', mode='psd'): the signal is cut into segments
     overlapping by noverlap, each has its mean removed and is multiplied by a periodic Hann
     window, and its one-sided |FFT|² is scaled to a power density. A signal shorter than
     nperseg is one segment. Returns {f (Hz), t (segment centres, s from the start), S (one
     Float64Array per segment)}. */
  function spectrogram(A, fs, { nperseg, noverlap, nfft }) {
    const n = A.length;
    nperseg = Math.min(nperseg, n);
    noverlap = noverlap === undefined ? Math.floor(nperseg / 2) : Math.min(noverlap, nperseg - 1);
    nfft = Math.max(nfft || nperseg, nperseg);
    const w = Float64Array.from({ length: nperseg }, (_, k) => 0.5 - 0.5 * Math.cos(2 * Math.PI * k / nperseg));
    let w2 = 0; for (const v of w) w2 += v * v;
    const step = nperseg - noverlap, segs = Math.floor((n - noverlap) / step), bins = Math.floor(nfft / 2) + 1;
    const scale = 1 / (fs * w2), seg = new Float64Array(nfft), S = [], times = [];
    for (let s = 0; s < segs; s++) {
      const o = s * step;
      let m = 0; for (let k = 0; k < nperseg; k++) m += A[o + k];
      m /= nperseg;
      seg.fill(0);
      for (let k = 0; k < nperseg; k++) seg[k] = (A[o + k] - m) * w[k];
      const X = fft(seg), P = new Float64Array(bins);
      for (let k = 0; k < bins; k++) P[k] = (X.re[k] * X.re[k] + X.im[k] * X.im[k]) * scale * (k === 0 || (nfft % 2 === 0 && k === bins - 1) ? 1 : 2);
      S.push(P); times.push((o + nperseg / 2) / fs);
    }
    return { f: Float64Array.from({ length: bins }, (_, k) => k * fs / nfft), t: Float64Array.from(times), S };
  }
  /* Power spectral density by Welch's method, as scipy.signal.welch with the same arguments:
     the average of the spectrogram's segments. Returns {f (Hz), psd (units²/Hz)}. */
  function welch(A, fs, opts) {
    const sg = spectrogram(A, fs, opts), psd = new Float64Array(sg.f.length);
    for (const P of sg.S) for (let k = 0; k < P.length; k++) psd[k] += P[k];
    for (let k = 0; k < psd.length; k++) psd[k] /= sg.S.length;
    return { f: sg.f, psd };
  }

  /* Amplitude gain of the selected filter at the given frequencies, as applied (so zero-phase
     IIR filters give |H|², run once each way): what fraction of each frequency's swing the
     filter keeps. null for no filter, settings that can't be used, and the median and wavelet
     filters, which aren't linear and have no fixed response. */
  function filterGain(p, fs, freqs) {
    const f = FILTERS.find(x => x.id === p.filter);
    if (!f || !f.apply || f.id === 'median' || f.id === 'wavelet') return null; // not linear: no fixed response
    const sosGain = sos => freqs.map(fr => {
      const w = 2 * Math.PI * fr / fs; let g = 1;
      for (const [b0, b1, b2, , a1, a2] of sos) {
        const nr = b0 + b1 * Math.cos(w) + b2 * Math.cos(2 * w), ni = -b1 * Math.sin(w) - b2 * Math.sin(2 * w);
        const dr = 1 + a1 * Math.cos(w) + a2 * Math.cos(2 * w), di = -a1 * Math.sin(w) - a2 * Math.sin(2 * w);
        g *= (nr * nr + ni * ni) / (dr * dr + di * di);
      }
      return g; // |H|² = |H| forwards × |H| backwards
    });
    // a centred FIR with symmetric weights c[0..w-1] is real: Σ c_k cos(2πf(k−h)/fs)
    const firGain = c => { const h = (c.length - 1) / 2; return freqs.map(fr => { let g = 0; for (let k = 0; k < c.length; k++) g += c[k] * Math.cos(2 * Math.PI * fr * (k - h) / fs); return Math.abs(g); }); };
    try {
      if (f.iir) return sosGain(designFilter({ type: f.id, order: p.fOrder, fs, lowpass: p.fLow, highpass: p.fHigh, rp: p.fRipple, rs: p.fAtten }).sos);
      if (f.id === 'notch') return sosGain(notchSos(p.notchFreq, p.notchQ, fs));
      const n = 1e9; // window limits are about the recording, not the response
      if (f.id === 'movavg') { const w = oddWindow(p.maWindow, fs, n, 3); return firGain(new Float64Array(w).fill(1 / w)); }
      if (f.id === 'savgol') { const w = oddWindow(p.sgWindow, fs, n, p.sgOrder + 2); return firGain(savgolWeights(w, p.sgOrder)((w - 1) / 2)); }
    } catch (e) { if (e instanceof RangeError) return null; throw e; }
    return null;
  }

  /* Cadence over time: the dominant walking frequency in windows of p.specWin seconds (default
     4 s) every 0.5 s, on an even grid. Only the walking band (up to 3.5 Hz) matters here, so
     above 50 Hz the signal is low-passed at 8 Hz and kept every q-th sample (about 20 Hz),
     which makes a 10-minute 460 Hz recording about 20× quicker. Returns {t (window centres, in
     the recording's time), freq (Hz, NaN where a window has no clear walking peak), window (s),
     hop (s), f and S: the short-time spectra themselves (for spectrogramImage)}. */
  const SPEC_HOP = 0.5, RHYTHM_RATE = 20;
  function rhythmOverTime(A, t, p) {
    const g = evenGrid(A, t), q = Math.max(1, Math.floor(g.fs / RHYTHM_RATE));
    let x = g.A, fs = g.fs;
    if (q > 2) { const lp = lowpass(x, fs, 8); x = Float64Array.from({ length: Math.ceil(lp.length / q) }, (_, k) => lp[k * q]); fs /= q; }
    const nperseg = Math.round((p.specWin || 4) * fs);
    if (x.length < nperseg) return { t: new Float64Array(0), freq: new Float64Array(0), window: nperseg / fs, hop: SPEC_HOP, f: new Float64Array(0), S: [] };
    let nfft = 1; while (nfft < Math.max(nperseg, Math.ceil(fs / 0.01))) nfft *= 2;
    const sg = spectrogram(x, fs, { nperseg, noverlap: nperseg - Math.max(1, Math.round(SPEC_HOP * fs)), nfft });
    const freq = Float64Array.from(sg.S, P => { const pk = dominantFrequency(sg.f, P); return pk.clear ? pk.freq : NaN; });
    return { t: sg.t.map(v => v + g.t[0]), freq, window: nperseg / fs, hop: Math.max(1, Math.round(SPEC_HOP * fs)) / fs, f: sg.f, S: sg.S };
  }

  /* Time-frequency pictures (#98, #101) share one layout, a grid: {t (column centres, s), hop
     (s per column), df (Hz per row), rows (from 0 Hz up), P (one Float64Array of row power per
     column)}. stftGrid turns rhythmOverTime's short-time spectra into it: frequency up to fMax in
     rows of df Hz (the mean of the spectrum's bins in each row), at most maxCols columns
     (neighbours averaged beyond that). Returns null when there are no windows. */
  function stftGrid(r, opts) {
    opts = opts || {};
    const fMax = opts.fMax || 5, df = opts.df || 0.05, maxCols = opts.maxCols || 1200;
    if (!r.S.length) return null;
    const rows = Math.round(fMax / df), group = Math.ceil(r.S.length / maxCols), width = Math.ceil(r.S.length / group), P = [], t = new Float64Array(width);
    for (let c = 0; c < width; c++) {
      const sum = new Float64Array(rows), cnt = new Float64Array(rows), last = Math.min(r.S.length, (c + 1) * group);
      for (let s = c * group; s < last; s++) {
        for (let k = 0; k < r.f.length && r.f[k] < fMax; k++) { const row = Math.floor(r.f[k] / df); sum[row] += r.S[s][k]; cnt[row]++; }
      }
      P.push(sum.map((v, i) => (cnt[i] ? v / cnt[i] : 0)));
      t[c] = r.t[c * group] + (group - 1) * r.hop / 2;
    }
    return { t, hop: r.hop * group, df, rows, P };
  }
  /* A grid as an RGBA image, time across and frequency up (the top row is the highest). Each
     pixel is the given colour with an opacity that grows with the power in decibels, from
     `range` dB below the strongest power in the walking band (transparent) up to it (opaque),
     squared so faint power fades quickly; it reads on a light or a dark background. Returns
     {width, height, rgba, x0, x1 (s, the image's left and right edges), fMax}. */
  // 20 dB, with the opacity squared, keeps a steady walk's band clear of the rest; 30 dB and a
  // straight line washed the owner's pocket walk out (its heel strikes spread power widely)
  const SPECTRO_DB = 20, SPECTRO_GAMMA = 2;
  function gridImage(grid, color, opts) {
    opts = opts || {};
    const range = opts.range || SPECTRO_DB, gamma = opts.gamma || SPECTRO_GAMMA, { P, rows, df } = grid, width = P.length;
    let top = 0;
    for (const col of P) for (let i = 0; i < rows; i++) if ((i + 0.5) * df >= GAIT_BAND[0] && (i + 0.5) * df <= GAIT_BAND[1] && col[i] > top) top = col[i];
    const rgba = new Uint8Array(width * rows * 4);
    for (let c = 0; c < width; c++) for (let i = 0; i < rows; i++) {
      const db = top > 0 && P[c][i] > 0 ? 10 * Math.log10(P[c][i] / top) : -Infinity;
      const a = Math.pow(Math.max(0, Math.min(1, 1 + db / range)), gamma), o = ((rows - 1 - i) * width + c) * 4;
      rgba[o] = color[0]; rgba[o + 1] = color[1]; rgba[o + 2] = color[2]; rgba[o + 3] = Math.round(255 * a);
    }
    return { width, height: rows, rgba, x0: grid.t[0] - grid.hop / 2, x1: grid.t[0] - grid.hop / 2 + grid.hop * width, fMax: rows * df };
  }
  // the STFT picture in one call (#98)
  function spectrogramImage(r, color, opts) {
    const g = stftGrid(r, opts);
    return g && gridImage(g, color, opts);
  }

  /* An RGBA image as PNG bytes, uncompressed (zlib stored blocks), so no deflate library is
     needed: a filter byte 0 before each row, then IHDR, IDAT and IEND with their CRCs. */
  function pngBytes(width, height, rgba) {
    const raw = new Uint8Array(height * (width * 4 + 1));
    for (let y = 0; y < height; y++) { raw[y * (width * 4 + 1)] = 0; raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1); }
    const blocks = Math.max(1, Math.ceil(raw.length / 65535)), z = new Uint8Array(2 + raw.length + 5 * blocks + 4);
    z[0] = 0x78; z[1] = 0x01;
    let o = 2, a = 1, b = 0;
    for (let k = 0; k < blocks; k++) {
      const part = raw.subarray(k * 65535, Math.min(raw.length, (k + 1) * 65535)), n = part.length;
      z[o] = k === blocks - 1 ? 1 : 0; z[o + 1] = n & 255; z[o + 2] = n >> 8; z[o + 3] = ~n & 255; z[o + 4] = (~n >> 8) & 255;
      z.set(part, o + 5); o += 5 + n;
    }
    for (let i = 0; i < raw.length; i++) { a = (a + raw[i]) % 65521; b = (b + a) % 65521; } // Adler-32
    const adler = ((b << 16) | a) >>> 0;
    z[o] = adler >>> 24; z[o + 1] = (adler >>> 16) & 255; z[o + 2] = (adler >>> 8) & 255; z[o + 3] = adler & 255;
    const u32 = v => [v >>> 24, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
    const chunk = (type, data) => {
      const td = new Uint8Array(4 + data.length);
      for (let i = 0; i < 4; i++) td[i] = type.charCodeAt(i);
      td.set(data, 4);
      return [...u32(data.length), ...td, ...u32(crc32(td))];
    };
    const ihdr = new Uint8Array([...u32(width), ...u32(height), 8, 6, 0, 0, 0]);
    return Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, ...chunk('IHDR', ihdr), ...chunk('IDAT', z), ...chunk('IEND', new Uint8Array(0))]);
  }
  // bytes as base64, for a data: URL
  function base64(u8) {
    const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let s = '';
    for (let i = 0; i < u8.length; i += 3) {
      const n = (u8[i] << 16) | ((u8[i + 1] || 0) << 8) | (u8[i + 2] || 0);
      s += A[n >> 18] + A[(n >> 12) & 63] + (i + 1 < u8.length ? A[(n >> 6) & 63] : '=') + (i + 2 < u8.length ? A[n & 63] : '=');
    }
    return s;
  }

  /* A step count from the rhythm, without detecting any steps (#98): the local walking rhythm
     (rhythmOverTime's windows) added up over the walk, one cycle of it per step. The walk runs
     from the first to the last window with a clear, repeating rhythm (below); each end then
     moves, by at most half a window either way, to where the walking swing (the 1 s RMS of the
     signal band-passed to 0.5-3.5 Hz) first or last reaches half its median inside that
     stretch. On a phone a window only reads as clear once most of it is walking, so without
     that the first and last second or so go uncounted; on a very clean signal a window can read
     as clear before the walk starts. Between clear windows the rhythm is interpolated, and held
     beyond the first and last. On the owner's four counted walks (10, 24, 28 and 60 steps,
     2026-10-07) the total gives 10.1, 23.8, 26.2 and 60.2, the vertical 10.1, 23.9, 28.0 and
     59.8. Returns {steps, start, end (s), clear (windows)}, or null with fewer than two clear
     windows. rhythm: rhythmOverTime(A, t, p) when already computed. */
  const RHYTHM_REGULAR = 0.5;
  function spectralSteps(A, t, p, rhythm) {
    const r = rhythm || rhythmOverTime(A, t, p), kt = [], kf = [];
    const g = evenGrid(A, t), n = g.A.length, lo = lowpass(g.A, g.fs, GAIT_BAND[0]), hi = lowpass(g.A, g.fs, GAIT_BAND[1]);
    const x = Float64Array.from(hi, (v, i) => v - lo[i]); // the walking band, 0.5-3.5 Hz
    // A window's peak can stand out by chance: a still phone's noise passes the 5x test in about
    // half its windows. Walking also repeats: the window matches itself one cycle later (the
    // autocorrelation at that lag). The owner's walks give a median of 0.6-0.93 and noise at
    // most 0.44, so windows under 0.5 are left out.
    r.freq.forEach((f, k) => {
      if (!Number.isFinite(f)) return;
      const a = Math.max(0, Math.round((r.t[k] - r.window / 2 - g.t[0]) * g.fs)), b = Math.min(n, Math.round((r.t[k] + r.window / 2 - g.t[0]) * g.fs));
      const lag = Math.round(g.fs / f);
      let sxy = 0, sxx = 0, syy = 0;
      for (let i = a; i + lag < b; i++) { sxy += x[i] * x[i + lag]; sxx += x[i] * x[i]; syy += x[i + lag] * x[i + lag]; }
      if (sxy / Math.sqrt(sxx * syy) >= RHYTHM_REGULAR) { kt.push(r.t[k]); kf.push(f); }
    });
    if (kt.length < 2) return null;
    const cs = new Float64Array(n + 1); // running sum of squares of the band-passed signal
    for (let i = 0; i < n; i++) cs[i + 1] = cs[i] + x[i] * x[i];
    const h = Math.max(1, Math.round(0.5 * g.fs));
    const rms = i => { const a = Math.max(0, i - h), b = Math.min(n - 1, i + h); return Math.sqrt((cs[b + 1] - cs[a]) / (b - a + 1)); };
    const c1 = kt[0], cN = kt[kt.length - 1], half = r.window / 2, core = [];
    for (let i = 0; i < n; i++) if (g.t[i] >= c1 && g.t[i] <= cN) core.push(rms(i));
    const level = 0.5 * median(core);
    // each end is searched half a window either way: on a phone the first clear window comes a
    // little after the walk starts, on a very clean signal it can come before
    let start = c1, end = cN;
    for (let i = 0; i < n && g.t[i] <= c1 + half; i++) if (g.t[i] >= c1 - half && rms(i) >= level) { start = g.t[i]; break; }
    for (let i = n - 1; i >= 0 && g.t[i] >= cN - half; i--) if (g.t[i] <= cN + half && rms(i) >= level) { end = g.t[i]; break; }
    // ∫ rhythm dt from kt[0] to x: straight lines between clear windows, held beyond them
    const F = x => {
      if (x <= kt[0]) return kf[0] * (x - kt[0]);
      let sum = 0;
      for (let k = 1; k < kt.length; k++) {
        if (x <= kt[k]) { const fx = kf[k - 1] + (kf[k] - kf[k - 1]) * (x - kt[k - 1]) / (kt[k] - kt[k - 1]); return sum + (kf[k - 1] + fx) / 2 * (x - kt[k - 1]); }
        sum += (kf[k - 1] + kf[k]) / 2 * (kt[k] - kt[k - 1]);
      }
      return sum + kf[kf.length - 1] * (x - kt[kt.length - 1]);
    };
    return { steps: F(end) - F(start), start, end, clear: kt.length };
  }

  /* Harmonic ratio, a gait-symmetry measure (e.g. Menz et al. 2003): each stride (two steps,
     or one peak-to-peak when each peak is a stride) is one period; its Fourier amplitudes at
     harmonics 1–20 of the stride frequency are summed, even over odd. Identical left and right
     steps repeat twice per stride, so they make only even harmonics: the higher the ratio, the
     more alike the steps (for the vertical or forward direction; side to side, the ratio
     inverts). Harmonics at or above half the sampling rate are left out. Uses the given
     signal on an even grid and the step times idx. Returns {ratio (mean over strides), strides}. */
  const HR_HARMONICS = 20;
  function harmonicRatio(A, t, idx, perStride) {
    const g = evenGrid(A, t), dt = 1 / g.fs, ratios = [], stepBy = perStride ? 1 : 2;
    for (let k = 0; k + stepBy < idx.length; k += stepBy) {
      const ta = t[idx[k]], T = t[idx[k + stepBy]] - ta;
      if (!(T > 0)) continue;
      const first = Math.ceil((ta - g.t[0]) / dt - 1e-9), last = Math.ceil((ta + T - g.t[0]) / dt - 1e-9); // [ta, ta + T)
      if (first < 0 || last > g.A.length || last - first < 8) continue;
      let even = 0, odd = 0;
      for (let h = 1; h <= HR_HARMONICS && h / T < g.fs / 2; h++) {
        let re = 0, im = 0;
        for (let j = first; j < last; j++) { const ph = 2 * Math.PI * h * (g.t[j] - ta) / T; re += g.A[j] * Math.cos(ph); im -= g.A[j] * Math.sin(ph); }
        const amp = Math.hypot(re, im);
        if (h % 2) odd += amp; else even += amp;
      }
      if (odd > 0) ratios.push(even / odd);
    }
    return { ratio: ratios.length ? mean(ratios) : NaN, strides: ratios.length };
  }

  /* Analytic signal, as scipy.signal.hilbert: the FFT with negative frequencies removed and
     positive ones doubled, transformed back. Its size (|re + i·im|) is the amplitude of the
     swing at each moment, and its angle advances one turn per cycle. Returns {re, im}. */
  function hilbert(A) {
    const n = A.length, X = fft(A);
    for (let k = 1; k < n; k++) {
      const g = 2 * k < n ? 2 : 2 * k === n ? 1 : 0;
      X.re[k] *= g; X.im[k] *= g;
    }
    return ifft(X.re, X.im);
  }

  // The walking band: 0.5 to 3.5 Hz holds both stride (about 1 Hz) and step (about 2 Hz) rates.
  const GAIT_BAND = [0.5, 3.5];
  /* The spectrum of a prepared channel: Welch over segments of p.specSeg seconds (default
     8 s, or the whole recording if shorter), on an even grid. Zero-padded to bins of at most
     0.01 Hz so the peak is read precisely; the true resolution is about 1 / segment length.
     Returns {f, psd, fs, resampled, segment (s)} plus the dominant frequency in the walking
     band: peak {freq, power, clear}, clear when it stands at least 5× above the band's median. */
  function spectrum(A, t, p) {
    const g = evenGrid(A, t), nperseg = Math.min(g.A.length, Math.max(8, Math.round((p.specSeg || 8) * g.fs)));
    let nfft = 1; while (nfft < Math.max(nperseg, Math.ceil(g.fs / 0.01))) nfft *= 2;
    const r = welch(g.A, g.fs, { nperseg, nfft });
    return Object.assign(r, { fs: g.fs, resampled: g.resampled, segment: nperseg / g.fs, peak: dominantFrequency(r.f, r.psd) });
  }
  function dominantFrequency(f, psd, band = GAIT_BAND) {
    let best = -1; const inBand = [];
    for (let k = 0; k < f.length; k++) if (f[k] >= band[0] && f[k] <= band[1]) { inBand.push(psd[k]); if (best < 0 || psd[k] > psd[best]) best = k; }
    if (best < 0) return { freq: NaN, power: NaN, clear: false };
    return { freq: f[best], power: psd[best], clear: psd[best] >= 5 * median(inBand) };
  }

  /* Frequency-domain methods (#101), shown in the Frequency domain section's two slots: kind
     'whole' (power by frequency over the whole recording) or 'time' (a time x frequency
     picture). They are views only: steps, metrics, the rhythm count and the checks always come
     from Welch's spectrum and the STFT. Each entry: id, kind, name, tagline, credit, params (a
     schema, as for ENVELOPES), and compute(A, t, p, ctx), where ctx holds what the page has
     already computed ({spec, rhythm}), so the default methods cost nothing extra:
       whole -> {f, psd, peak, segment?, fs, resampled?}   (as spectrum)
       time  -> {grid (see stftGrid), line? {t, f} (the main rhythm), window, hop}, or null */
  const FFT_CREDIT = [{ text: 'Cooley & Tukey, 1965', doi: '10.1090/S0025-5718-1965-0178586-1', note: 'FFT' }, { text: 'Bluestein, 1970', doi: '10.1109/TAU.1970.1162132', note: 'FFT of any length' }];
  const TRANSFORMS = [
    {
      id: 'welch', kind: 'whole', name: 'Fourier: Welch\u2019s method', params: [],
      credit: [{ text: 'Welch, 1967', doi: '10.1109/TAU.1967.1161901' }].concat(FFT_CREDIT),
      tagline: 'The average power at each frequency over the whole recording, from half-overlapping segments (Segment length, above). A steady walk shows as a tall peak at its rhythm.',
      compute: (A, t, p, ctx) => (ctx && ctx.spec) || spectrum(A, t, p),
    },
    {
      id: 'stft', kind: 'time', name: 'Short-time Fourier (STFT)', params: [], credit: FFT_CREDIT,
      tagline: 'The Fourier spectrum in a window that slides along the recording (Rhythm-over-time window, above). One window length for every frequency, so it is either sharp in time or sharp in frequency, not both.',
      compute: (A, t, p, ctx) => {
        const r = (ctx && ctx.rhythm) || rhythmOverTime(A, t, p), grid = stftGrid(r);
        return grid && { grid, line: { t: r.t, f: r.freq }, window: r.window, hop: r.hop };
      },
    },
  ];

  /* The signal on an even time grid at the median sampling rate, for methods that assume even
     spacing (IIR and smoothing filters, FFT). Returns {A, t, fs, resampled, jitter, gaps}:
     the input itself when the timestamps vary by under 1%, or when long gaps would make the
     grid over 4 times the recording (gaps: true); otherwise A interpolated onto the grid. */
  function evenGrid(A, t) {
    const n = A.length, dts = [];
    for (let i = 1; i < n; i++) { const d = t[i] - t[i - 1]; if (d > 0) dts.push(d); }
    const md = median(dts), jitter = std(dts) / md;
    const same = { A, t, fs: 1 / md, resampled: false, jitter, gaps: false };
    if (!(jitter > RESAMPLE_JITTER)) return same;
    const m = Math.floor((t[n - 1] - t[0]) / md) + 1;
    if (m > 4 * n) return Object.assign(same, { gaps: true });
    const tg = Float64Array.from({ length: m }, (_, k) => t[0] + k * md);
    return { A: interpAt(t, A, tg), t: tg, fs: 1 / md, resampled: true, jitter, gaps: false };
  }
  function filterEvenly(A, t, fs, run) {
    const g = evenGrid(A, t);
    if (g.gaps) {
      return { A: run(A), applied: true, resampled: false, checks: [{ level: 'warn', title: 'Filtered as if evenly sampled',
        detail: 'The recording has long gaps, so an even grid would be over 4 times its length. The filter treats the samples as evenly spaced, which blurs its cut-off.',
        fix: 'Trim the gaps or split the recording.' }] };
    }
    if (!g.resampled) return { A: run(A), applied: true, resampled: false, checks: [] };
    return { A: interpAt(g.t, run(g.A), t), applied: true, resampled: true, checks: [{ level: 'info', title: 'Resampled for filtering',
      detail: 'Timing varies by ' + Math.round(g.jitter * 100) + '% between samples and the filter needs even spacing, so the signal was interpolated onto an even ' + fmt(g.fs, 1) + ' Hz grid, filtered, and read back at the original timestamps.' }] };
  }


  /* ----------------------------------------------------------- resampling (#52) */
  // Anti-aliasing before going down in rate: scipy.signal.decimate's IIR filter, a Chebyshev
  // type I low-pass of order 8 with 0.05 dB ripple at 0.8 × the new Nyquist frequency.
  const ANTIALIAS = { order: 8, rp: 0.05, fraction: 0.8 };
  const MAX_GRID = 2e6; // samples; beyond this the page would stall
  const RESAMPLE_METHODS = { linear: 'straight lines between samples (like MATLAB interp1)', pchip: 'a monotone cubic through the samples (pchip)' };

  // numpy.interp, operation for operation, so Coza gets the same bits as from the
  // Python port's resample(): xp strictly increasing, x increasing.
  function interpLinear(xp, fp, x) {
    const n = xp.length, out = new Float64Array(x.length);
    let j = 0;
    for (let i = 0; i < x.length; i++) {
      const v = x[i];
      if (v > xp[n - 1] || v === xp[n - 1]) { out[i] = fp[n - 1]; continue; }
      if (v < xp[0]) { out[i] = fp[0]; continue; }
      while (j + 1 < n && xp[j + 1] <= v) j++;
      if (xp[j] === v) { out[i] = fp[j]; continue; }
      const slope = (fp[j + 1] - fp[j]) / (xp[j + 1] - xp[j]);
      let r = slope * (v - xp[j]) + fp[j];
      if (Number.isNaN(r)) { r = slope * (v - xp[j + 1]) + fp[j + 1]; if (Number.isNaN(r) && fp[j] === fp[j + 1]) r = fp[j]; }
      out[i] = r;
    }
    return out;
  }

  // Samples sharing a timestamp averaged into one (interpolation needs one value per time).
  function mergeRepeats(t, A) {
    const ts = [], as = [];
    for (let i = 0; i < t.length;) {
      let j = i + 1, sum = A[i];
      while (j < t.length && t[j] === t[i]) sum += A[j++];
      ts.push(t[i]); as.push(sum / (j - i));
      i = j;
    }
    return { t: Float64Array.from(ts), A: Float64Array.from(as), merged: t.length - ts.length };
  }

  /* A prepared channel on an even grid t0, t0 + 1/fs, … (#52), for analyses that count
     samples (Coza's w and /100) or need even spacing. opts: {mode: 'even' (the
     recording's own median rate) or 'rate', rate (Hz), method: 'linear' | 'pchip',
     antialias}. antialias low-passes below the new Nyquist frequency first when going down
     in rate, on an even grid at the recording's median rate. Same steps as resample() in
     python/lab_step_det.py; linear matches it bit for bit. Returns {applied, A, t, fs, from,
     n, checks, min, max}; settings that can't be used give applied: false and a check. */
  function resampleChannel(ch, opts) {
    const fail = (title, detail, fix) => ({ applied: false, checks: [{ level: 'warn', title, detail, fix }] });
    const fs = opts.mode === 'even' ? ch.fs : Number(opts.rate);
    if (!(fs > 0) || !Number.isFinite(fs)) return fail('Resampling not applied', 'No rate is set.', 'Type a rate in Hz under Resample.');
    const method = RESAMPLE_METHODS[opts.method] ? opts.method : 'linear';
    const t0 = ch.t[0], tau = Float64Array.from(ch.t, v => v - t0);
    const u = mergeRepeats(tau, ch.A);
    const m = Math.floor(u.t[u.t.length - 1] * fs + 1e-9) + 1;
    if (m > MAX_GRID) return fail('Resampling not applied', fmt(fs, 1) + ' Hz would make ' + Math.round(m).toLocaleString('en-US') + ' samples, more than the page can handle (' + MAX_GRID.toLocaleString('en-US') + ').', 'Pick a lower rate.');
    if (m < MIN_ROWS) return fail('Resampling not applied', fmt(fs, 1) + ' Hz would leave only ' + m + ' samples.', 'Pick a higher rate.');
    const dts = [];
    for (let i = 1; i < u.t.length; i++) dts.push(u.t[i] - u.t[i - 1]);
    const md = median(dts), from = 1 / md, down = fs < from;
    let srcT = u.t, srcA = u.A, aa = null;
    if (opts.antialias && down) {
      const g = evenGrid(u.A, u.t), fc = ANTIALIAS.fraction * fs / 2;
      srcT = g.t; srcA = sosfiltfilt(designFilter({ type: 'cheby1', order: ANTIALIAS.order, rp: ANTIALIAS.rp, fs: g.fs, lowpass: fc }).sos, g.A);
      aa = { fc, gaps: g.gaps };
    }
    const xg = Float64Array.from({ length: m }, (_, k) => k / fs);
    const A = method === 'pchip' ? pchip(srcT, srcA, xg) : interpLinear(srcT, srcA, xg);
    const t = Float64Array.from(xg, v => t0 + v);
    let mn = Infinity, mx = -Infinity;
    for (const v of A) { if (v < mn) mn = v; if (v > mx) mx = v; }

    const checks = [{ level: 'info', title: 'Resampled to ' + fmt(fs, fs >= 100 ? 0 : 1) + ' Hz', detail: 'From about ' + fmt(from, from >= 100 ? 0 : 1) + ' Hz (' + ch.A.length + ' samples) to an even grid of ' + m + ' samples, by ' + RESAMPLE_METHODS[method] + '.' +
      (aa ? ' Low-passed at ' + fmt(aa.fc, 1) + ' Hz first (Chebyshev I, order ' + ANTIALIAS.order + ', like scipy decimate) so faster motion can’t fold back in.' : '') +
      ' The filter, every step detector and envelope, and the spectrum use the resampled signal; the plot shows the recording faded behind it.' }];
    if (fs > from * 1.01) checks.push({ level: 'info', title: 'Upsampling adds no information', detail: 'Going from about ' + fmt(from, 0) + ' Hz up to ' + fmt(fs, 0) + ' Hz only draws ' + (method === 'pchip' ? 'curves' : 'lines') + ' between the recorded samples. It can’t recover motion faster than the recording caught.' });
    if (down && fs < from * 0.99 && !aa) checks.push({ level: 'info', title: 'No anti-aliasing', detail: 'Going down to ' + fmt(fs, 0) + ' Hz, anything faster than ' + fmt(fs / 2, 1) + ' Hz in the recording folds back in as slower motion (aliasing). Walking has little above 20 Hz, but impacts can.', fix: 'Turn on Anti-aliasing under Advanced to low-pass first.' });
    if (aa && aa.gaps) checks.push({ level: 'warn', title: 'Anti-aliasing filter run as if evenly sampled', detail: 'The recording has long gaps, so an even grid would be over 4 times its length; the filter’s cut-off is blurred.', fix: 'Trim the gaps or split the recording.' });
    if (u.merged) checks.push({ level: 'info', title: u.merged + ' repeated timestamp' + (u.merged > 1 ? 's' : '') + ' averaged', detail: 'Samples that share a timestamp were averaged into one before resampling, since interpolation needs one value per time.' });
    let gaps = 0, maxGap = 0;
    for (const d of dts) if (d > 5 * md) { gaps++; maxGap = Math.max(maxGap, d); }
    if (gaps) checks.push({ level: 'warn', title: 'Resampling fills ' + gaps + ' gap' + (gaps > 1 ? 's' : ''), detail: 'The longest is ' + fmt(maxGap, 2) + ' s. The resampled signal bridges ' + (gaps > 1 ? 'them' : 'it') + ' with made-up values, so steps found there are not real.', fix: 'Trim the gaps or split the recording.' });
    const rate = cozaRateCheck(fs, true);
    if (rate) checks.push(rate);
    return { applied: true, A, t, fs, from, method, antialias: !!aa, n: m, checks, min: mn, max: mx };
  }

  /* --------------------------------------------------------------- export (#53) */
  // One content model, written as JSON, MATLAB .mat (v5), NumPy .npz or a zip of CSV files.
  // The fields are described in docs/export.md; python/lab_step_det.py --export writes the
  // same model (Coza only). Sample numbers are 1-based, like MATLAB, everywhere.
  const VERSION = '0.1.0'; // as in package.json and pyproject.toml (a test keeps them equal)
  const EXPORT_FORMAT_VERSION = 3;
  // Column types: these names are always text, the rest follow their values (text, true/false
  // or numbers), so a detector's column of step statuses is text.
  const TEXT_COLUMNS = new Set(['metric', 'unit', 'text', 'id', 'kind', 'type', 'name', 'source', 'color', 'params', 'settings', 'plot']);
  function columnKind(name, values) {
    if (TEXT_COLUMNS.has(name)) return 'str';
    const v = values ? Array.from(values).find(x => x !== null && x !== undefined && !(typeof x === 'number' && Number.isNaN(x))) : undefined;
    return typeof v === 'string' ? 'str' : typeof v === 'boolean' ? 'bool' : 'f8';
  }
  const TABLES = ['indicators', 'signals', 'recorded', 'steps', 'metrics', 'notes'], RECORDS = ['about', 'settings', 'params', 'spectrum'];

  /* Every sample any detector marked (or dropped as a weak peak), in time order, and what each
     detector made of it: 'step', 'weak peak' (found, then dropped), or ''. dets: [{id, idx,
     weak}] with 0-based idx. Returns {rows: [sample], status: {id: [..]}}. */
  function stepTable(dets) {
    const rows = Array.from(new Set(dets.flatMap(d => d.idx.concat(d.weak || []))));
    rows.sort((a, b) => a - b);
    const status = {};
    for (const d of dets) {
      const on = new Set(d.idx), weak = new Set(d.weak || []);
      status[d.id] = rows.map(i => (on.has(i) ? 'step' : weak.has(i) ? 'weak peak' : ''));
    }
    return { rows, status };
  }

  /* The metrics table: one row per metric, one column per detector. The rows from
     timingMetrics apply to every detector; the coza_ rows are Coza's own formulas from the
     .m file (samples ÷ 100, Pace), only for Coza. dets: [{id, type, metrics, hr, script}]. */
  function metricRows(dets, stride) {
    const rows = [
      ['steps', 'count', d => d.metrics.steps], ['peaks', 'count', d => d.metrics.peaks],
      ['step_interval', 's (timestamps)', d => d.metrics.stepInterval], ['cadence', 'steps/min', d => d.metrics.cadence],
      [stride ? 'stride_time_variability' : 'step_time_variability', 'ms (SD)', d => d.metrics.variabilityMs],
      ['coefficient_of_variation', '%', d => d.metrics.cv], ['gait_asymmetry', 'even/odd intervals', d => d.metrics.asymmetry],
      ['walking_span', 's', d => d.metrics.span], ['harmonic_ratio', 'even/odd harmonics per stride', d => (d.hr ? d.hr.ratio : NaN)],
      ['coza_average_step_duration', 's (samples/100, Coza’s formula)', d => (d.script ? d.script.avgStepDuration : NaN)],
      ['coza_pace', 'duration*60 (Coza’s formula)', d => (d.script ? d.script.pace : NaN)],
      ['coza_variability', 'samples (SD, Coza’s formula)', d => (d.script ? d.script.variabilitySamples : NaN)],
      ['coza_gait_asymmetry', 'even/odd sample intervals (Coza’s formula)', d => (d.script ? d.script.asymmetry : NaN)],
    ];
    const out = { metric: rows.map(r => r[0]), unit: rows.map(r => r[1]) };
    for (const d of dets) out[d.id] = rows.map(r => { const v = r[2](d); return Number.isFinite(v) ? v : NaN; });
    return out;
  }

  /* The export model (format_version 3; docs/export.md). x: {about, settings, params (the
     page's own controls), spectrum? {}, t, A (the analysed signal), filtered?, recorded? {t, A}
     (before resampling), indicators [{id, kind, type, name, source, color, params, settings}],
     detectors [{id, type, idx, weak, metrics, hr, script}], envelopes [{id, upper, lower,
     mid}], stride, notes [{plot, kind, x, y, text}] (a bare {t, text} is a time note on the
     signal), parts {signals, envelope}}. Ids are short names that
     work as MATLAB fields (coza, coza_modified, threshold_2, …). */
  function buildExport(x) {
    const parts = Object.assign({ signals: true, envelope: false }, x.parts);
    const model = {
      about: Object.assign({ format: 'gaitscope-export', format_version: EXPORT_FORMAT_VERSION, generator: 'gaitscope dashboard', version: VERSION,
        exported: new Date().toISOString(), sample_numbers: '1-based, like MATLAB (sample_matlab)', time: 's from the first sample of the recording' }, x.about),
      settings: x.settings || {}, params: x.params || {},
    };
    if (x.spectrum) model.spectrum = x.spectrum;
    const ind = x.indicators || [];
    model.indicators = { id: ind.map(i => i.id), kind: ind.map(i => i.kind), type: ind.map(i => i.type), name: ind.map(i => i.name),
      source: ind.map(i => i.source || ''), color: ind.map(i => i.color || ''), params: ind.map(i => JSON.stringify(i.params || {})),
      settings: ind.map(i => JSON.stringify(i.settings || {})), // what a detector derived from its params (e.g. its window in samples)
      credit: ind.map(i => creditText(((i.kind === 'envelope' ? ENVELOPES : ALGORITHMS).find(d => d.id === i.type) || {}).credit)) };
    if (parts.signals) {
      model.signals = { time_s: Array.from(x.t), signal: Array.from(x.A) };
      if (x.filtered) model.signals.filtered = Array.from(x.filtered);
      if (parts.envelope) for (const e of x.envelopes || []) for (const k of ['lower', 'upper', 'mid']) if (e[k]) model.signals[e.id + '_' + k] = Array.from(e[k]);
      if (x.recorded) model.recorded = { time_s: Array.from(x.recorded.t), value: Array.from(x.recorded.A) };
    }
    const dets = x.detectors || [], st = stepTable(dets);
    model.steps = { time_s: st.rows.map(i => x.t[i]), sample_matlab: st.rows.map(i => i + 1), value: st.rows.map(i => x.A[i]) };
    for (const d of dets) model.steps[d.id] = st.status[d.id];
    model.metrics = metricRows(dets, x.stride);
    // format 3 (#80): a note is a time, a level or a point, on the signal or the spectrum. time_s
    // repeats x for notes at a time on the signal, as format 2 had it.
    const notes = (x.notes || []).map(noteOf);
    model.notes = { time_s: notes.map(n => (n.plot === 'signal' && n.kind !== 'level' ? n.x : NaN)), plot: notes.map(n => n.plot), kind: notes.map(n => n.kind),
      x: notes.map(n => n.x), y: notes.map(n => n.y), text: notes.map(n => n.text) };
    return model;
  }

  /* A note as {plot: 'signal' | 'spectrum', kind: 'time' | 'level' | 'point', x, y, text} (#80):
     x is the time (s) or frequency (Hz), y the value or power; what a kind doesn't use is NaN.
     A format 1 or 2 note ({t, text} or a row with only time_s) is a time note on the signal. */
  const NOTE_PLOTS = ['signal', 'spectrum'], NOTE_KINDS = ['time', 'level', 'point'];
  function noteOf(n) {
    const plot = NOTE_PLOTS.includes(n.plot) ? n.plot : 'signal', kind = NOTE_KINDS.includes(n.kind) ? n.kind : 'time';
    const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);
    return { plot, kind, x: kind === 'level' ? NaN : num(n.x !== undefined ? n.x : n.t), y: kind === 'time' ? NaN : num(n.y), text: String(n.text === undefined ? '' : n.text) };
  }
  // the notes of a reopened export, whatever its format
  function exportNotes(m) {
    const t = m.notes || {}, n = (t.text || []).length;
    return Array.from({ length: n }, (_, k) => noteOf(t.kind ? { plot: t.plot[k], kind: t.kind[k], x: t.x[k], y: t.y[k], text: t.text[k] } : { t: t.time_s[k], text: t.text[k] }))
      .filter(nt => (nt.kind === 'level' ? Number.isFinite(nt.y) : Number.isFinite(nt.x)) && (nt.kind !== 'point' || Number.isFinite(nt.y)));
  }

  /* Short ids for indicators, usable as MATLAB field names: the type (coza_original → coza,
     coza → coza_modified), then _2, _3 for repeats. */
  const EXPORT_ID = { coza_original: 'coza', coza: 'coza_modified' };
  function indicatorIds(list) {
    const seen = {};
    return list.map(i => {
      const base = (EXPORT_ID[i.type] || i.type).replace(/[^A-Za-z0-9_]/g, '_').replace(/^[^A-Za-z]/, c => 'x' + c).slice(0, 24);
      seen[base] = (seen[base] || 0) + 1;
      return seen[base] > 1 ? base + '_' + seen[base] : base;
    });
  }

  // JSON: one line per part. NaN and ±Infinity become null (JSON has no NaN).
  function exportJson(model) {
    const plain = v => (ArrayBuffer.isView(v) ? Array.from(v) : v);
    const parts = Object.keys(model).map(k => JSON.stringify(k) + ': ' + JSON.stringify(model[k], (key, v) => (typeof v === 'number' && !Number.isFinite(v) ? null : plain(v))));
    return '{\n' + parts.join(',\n') + '\n}\n';
  }
  /* A JSON export read back: number columns with null as NaN. Throws InputError when it is
     not a GaitScope export, or a later format_version than this page knows. */
  function parseExportJson(text) {
    let m;
    try { m = JSON.parse(text); } catch (e) { throw new InputError('This JSON file could not be read: ' + e.message + '.', 'Export it from the dashboard again.'); }
    if (!m || !m.about || m.about.format !== 'gaitscope-export') throw new InputError('This JSON file is not a GaitScope export.', 'Open a .json file saved with Export… → JSON, or the recording itself.');
    if (!(m.about.format_version <= EXPORT_FORMAT_VERSION)) throw new InputError('This export uses format version ' + m.about.format_version + ', newer than this page (' + EXPORT_FORMAT_VERSION + ').', 'Reload the page to get the latest version.');
    if (!m.signals || !Array.isArray(m.signals.time_s) || !Array.isArray(m.signals.signal)) throw new InputError('This export has no signals, so it can’t be reopened.', 'Export again with Signals ticked.');
    for (const k of TABLES) if (m[k]) for (const c of Object.keys(m[k])) if (columnKind(c, m[k][c]) === 'f8') m[k][c] = Float64Array.from(m[k][c], v => (v === null ? NaN : v));
    return m;
  }

  // CSV for a table (columns of equal length) or a record ({key: value} as key,value rows).
  const csvCell = v => { const s = typeof v === 'number' ? (Number.isFinite(v) ? String(v) : '') : String(v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  function tableCsv(table) {
    const cols = Object.keys(table), n = cols.length ? table[cols[0]].length : 0, lines = [cols.map(csvCell).join(',')];
    for (let i = 0; i < n; i++) lines.push(cols.map(c => csvCell(table[c][i])).join(','));
    return lines.join('\n') + '\n';
  }
  const recordCsv = rec => ['key,value'].concat(Object.entries(rec).map(([k, v]) => csvCell(k) + ',' + csvCell(typeof v === 'object' ? JSON.stringify(v) : v))).join('\n') + '\n';

  /* A zip with stored (uncompressed) entries, which is what .npz is too. files: [{name, data
     (Uint8Array)}]. The page only loads pako's inflate, so nothing here is compressed. */
  let crcTable = null;
  function crc32(u8) {
    if (!crcTable) { crcTable = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; } }
    let c = 0xffffffff;
    for (let i = 0; i < u8.length; i++) c = crcTable[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  function zipStore(files, date) {
    const d = date || new Date(), enc = new TextEncoder();
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), day = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    const local = [], central = [];
    let off = 0;
    for (const f of files) {
      const name = enc.encode(f.name), crc = crc32(f.data), size = f.data.length;
      const h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
      h.setUint16(10, time, true); h.setUint16(12, day, true); h.setUint32(14, crc, true); h.setUint32(18, size, true); h.setUint32(22, size, true);
      h.setUint16(26, name.length, true); h.setUint16(28, 0, true);
      local.push(new Uint8Array(h.buffer), name, f.data);
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true);
      c.setUint16(12, time, true); c.setUint16(14, day, true); c.setUint32(16, crc, true); c.setUint32(20, size, true); c.setUint32(24, size, true);
      c.setUint16(28, name.length, true); c.setUint32(42, off, true);
      central.push(new Uint8Array(c.buffer), name);
      off += 30 + name.length + size;
    }
    const cdSize = central.reduce((s, a) => s + a.length, 0), e = new DataView(new ArrayBuffer(22));
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, cdSize, true); e.setUint32(16, off, true);
    return concatBytes(local.concat(central, [new Uint8Array(e.buffer)]));
  }
  function concatBytes(arrs) {
    const out = new Uint8Array(arrs.reduce((s, a) => s + a.length, 0));
    let p = 0; for (const a of arrs) { out.set(a, p); p += a.length; }
    return out;
  }

  // a zip with one CSV per part: about.csv, settings.csv, params.csv, signals.csv, …
  function exportCsvZip(model) {
    const enc = new TextEncoder(), files = [];
    for (const k of RECORDS) if (model[k]) files.push({ name: k + '.csv', data: enc.encode(recordCsv(model[k])) });
    for (const k of TABLES) if (model[k]) files.push({ name: k + '.csv', data: enc.encode(tableCsv(model[k])) });
    return zipStore(files);
  }

  /* NumPy .npz: a zip of .npy files, loadable with np.load(f, allow_pickle=False). about,
     settings and params are 0-d text arrays holding JSON; each table column is its own array,
     named table/column: float64, bool, or fixed-width unicode text (<U). */
  function npyBytes(kind, values) {
    const n = values.length, scalar = !Array.isArray(values) && !ArrayBuffer.isView(values);
    const vals = scalar ? [values] : values;
    let descr, body;
    if (kind === 'f8') { descr = '<f8'; body = new Uint8Array(Float64Array.from(vals).buffer); }
    else if (kind === 'bool') { descr = '|b1'; body = Uint8Array.from(vals, v => (v ? 1 : 0)); }
    else {
      const cps = vals.map(v => Array.from(String(v), ch => ch.codePointAt(0))), w = Math.max(1, ...cps.map(c => c.length));
      descr = '<U' + w; const u = new Uint32Array(vals.length * w);
      cps.forEach((c, i) => u.set(c, i * w));
      body = new Uint8Array(u.buffer);
    }
    let header = "{'descr': '" + descr + "', 'fortran_order': False, 'shape': " + (scalar ? '()' : '(' + n + ',)') + ', }';
    header += ' '.repeat(64 - ((10 + header.length + 1) % 64 || 64)) + '\n';
    const head = new Uint8Array(10 + header.length);
    head.set([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, 1, 0, header.length & 0xff, header.length >> 8]);
    for (let i = 0; i < header.length; i++) head[10 + i] = header.charCodeAt(i);
    return concatBytes([head, body]);
  }
  function exportNpz(model) {
    const files = [];
    for (const k of RECORDS) if (model[k]) files.push({ name: k + '.npy', data: npyBytes('str', JSON.stringify(model[k], (key, v) => (typeof v === 'number' && !Number.isFinite(v) ? null : v))) });
    for (const k of TABLES) if (model[k]) for (const c of Object.keys(model[k])) files.push({ name: k + '/' + c + '.npy', data: npyBytes(columnKind(c, model[k][c]), model[k][c]) });
    return zipStore(files);
  }

  /* MATLAB .mat (v5, uncompressed, like scipy's savemat default), read by MATLAB, Octave,
     scipy.io.loadmat and this page's own parseMat. One struct, gaitscope, with a field per
     part. A record becomes a struct of scalars and text; a table a struct of n×1 columns:
     double, logical, or a cell array of text (struct2table turns it into a table). */
  const MAT_NAME = /^[A-Za-z][A-Za-z0-9_]{0,30}$/;
  function exportMat(model) {
    // a data element: type, byte count, data, padded to 8 bytes
    const el = (type, bytes) => {
      const out = new Uint8Array(8 + bytes.length + (8 - (bytes.length % 8)) % 8), dv = new DataView(out.buffer);
      dv.setUint32(0, type, true); dv.setUint32(4, bytes.length, true); out.set(bytes, 8);
      return out;
    };
    const i32 = a => new Uint8Array(Int32Array.from(a).buffer), ascii = s => Uint8Array.from(s, ch => ch.charCodeAt(0));
    // miMATRIX: array flags (class, logical bit), dimensions, name, then the data elements
    const matrix = (cls, dims, data, opts = {}) => {
      const flags = new Uint8Array(8); new DataView(flags.buffer).setUint32(0, cls | (opts.logical ? 0x0200 : 0), true);
      return el(14, concatBytes([el(6, flags), el(5, i32(dims)), el(1, ascii(opts.name || '')), ...data]));
    };
    const text = v => {
      // UTF-16, as MATLAB's char; characters beyond U+FFFF (emoji) take two units there and
      // scipy can't read them back, so they become U+FFFD
      const str = String(v).replace(/[\u{10000}-\u{10FFFF}]/gu, '\uFFFD'), u = new Uint16Array(str.length);
      for (let i = 0; i < str.length; i++) u[i] = str.charCodeAt(i);
      return matrix(4, str.length ? [1, str.length] : [0, 0], [el(17, new Uint8Array(u.buffer))]); // miUTF16
    };
    const dbl = (vals, dims) => matrix(6, dims, [el(9, new Uint8Array(Float64Array.from(vals).buffer))]);
    const logical = (vals, dims) => matrix(9, dims, [el(2, Uint8Array.from(vals, v => (v ? 1 : 0)))], { logical: true });
    const struct = (fields, name) => {
      const names = Object.keys(fields), nameBytes = new Uint8Array(32 * names.length);
      names.forEach((n, k) => {
        if (!MAT_NAME.test(n)) throw new Error('Not a MATLAB field name: ' + n);
        nameBytes.set(ascii(n), 32 * k);
      });
      // field name length: a small data element (tag and value in 8 bytes), as MATLAB writes
      // it; Octave reads no padding after this one
      const len = new Uint8Array(8), dv = new DataView(len.buffer);
      dv.setUint32(0, (4 << 16) | 5, true); dv.setInt32(4, 32, true);
      return matrix(2, [1, 1], [len, el(1, nameBytes), ...names.map(n => fields[n])], { name });
    };
    const value = v => (typeof v === 'boolean' ? logical([v], [1, 1]) : typeof v === 'number' ? dbl([v], [1, 1])
      : v && typeof v === 'object' ? record(v) : text(v === null || v === undefined ? '' : v));
    const record = rec => struct(Object.fromEntries(Object.entries(rec).map(([k, v]) => [k, value(v)])));
    const column = (name, vals) => {
      const n = vals.length, kind = columnKind(name, vals);
      if (kind === 'f8') return dbl(vals, [n, 1]);
      if (kind === 'bool') return logical(vals, [n, 1]);
      return matrix(1, [n, 1], Array.from(vals, text)); // a cell array of text
    };
    const fields = {};
    for (const k of RECORDS) if (model[k]) fields[k] = record(model[k]);
    for (const k of TABLES) if (model[k]) fields[k] = struct(Object.fromEntries(Object.keys(model[k]).map(c => [c, column(c, model[k][c])])));
    // 128-byte header: text, subsystem offset, version 0x0100, 'IM' (little-endian)
    const head = new Uint8Array(128).fill(32);
    head.set(ascii(('MATLAB 5.0 MAT-file, Platform: gaitscope ' + VERSION + ', Created on: ' + new Date().toUTCString()).slice(0, 116)));
    head.fill(0, 116, 124); head.set([0x00, 0x01, 0x49, 0x4d], 124);
    return concatBytes([head, struct(fields, 'gaitscope')]);
  }

  /* Envelopes: curves drawn around the signal the algorithm sees, to show how the size of
     each swing changes. A view only: they never change the detected steps or metrics.
     compute(A, t, p) -> {upper?, lower?, mid?}, arrays with one value per sample; midName
     names the midline in the legend.
     p: {fs, envWindow (s, sliding and dynamic), envPeakWindow (s, peak-trough)} */
  // Samples that are the highest (isMax) or lowest within ±half samples, a run of equal values
  // counted once at its first sample (Coza's tie rule); the first and last samples are skipped.
  function localExtrema(A, half, isMax) {
    const M = windowExtreme(A, half, half, isMax), L = windowExtreme(A, half, -1, isMax), out = [];
    for (let i = 1; i < A.length - 1; i++) if (A[i] === M[i] && (isMax ? A[i] > L[i] : A[i] < L[i])) out.push(i);
    return out;
  }
  // Monotone cubic through (xs, ys), as scipy's PchipInterpolator: slopes are a weighted
  // harmonic mean of the neighbouring secants (0 where they change sign), so the curve never
  // overshoots between points; the end slopes use scipy's three-point rule. Evaluated at td,
  // held flat before the first point and after the last.
  function pchip(xs, ys, td) {
    const n = xs.length, out = new Float64Array(td.length);
    if (n === 1) return out.fill(ys[0]);
    const h = [], m = [];
    for (let k = 0; k < n - 1; k++) { h.push(xs[k + 1] - xs[k]); m.push((ys[k + 1] - ys[k]) / h[k]); }
    const d = new Float64Array(n);
    if (n === 2) d[0] = d[1] = m[0];
    else {
      for (let k = 1; k < n - 1; k++) {
        if (Math.sign(m[k - 1]) !== Math.sign(m[k]) || m[k - 1] === 0 || m[k] === 0) { d[k] = 0; continue; }
        const w1 = 2 * h[k] + h[k - 1], w2 = h[k] + 2 * h[k - 1];
        d[k] = (w1 + w2) / (w1 / m[k - 1] + w2 / m[k]);
      }
      const edge = (h0, h1, m0, m1) => {
        const e = ((2 * h0 + h1) * m0 - h0 * m1) / (h0 + h1);
        if (Math.sign(e) !== Math.sign(m0)) return 0;
        if (Math.sign(m0) !== Math.sign(m1) && Math.abs(e) > 3 * Math.abs(m0)) return 3 * m0;
        return e;
      };
      d[0] = edge(h[0], h[1], m[0], m[1]);
      d[n - 1] = edge(h[n - 2], h[n - 3], m[n - 2], m[n - 3]);
    }
    let k = 0;
    for (let i = 0; i < td.length; i++) {
      const x = td[i];
      if (x <= xs[0]) { out[i] = ys[0]; continue; }
      if (x >= xs[n - 1]) { out[i] = ys[n - 1]; continue; }
      while (k + 1 < n - 1 && xs[k + 1] <= x) k++;
      while (k > 0 && xs[k] > x) k--;
      const u = (x - xs[k]) / h[k], u2 = u * u, u3 = u2 * u;
      out[i] = (2 * u3 - 3 * u2 + 1) * ys[k] + (u3 - 2 * u2 + u) * h[k] * d[k] + (-2 * u3 + 3 * u2) * ys[k + 1] + (u3 - u2) * h[k] * d[k + 1];
    }
    return out;
  }
  // Straight lines (or a monotone cubic) through the given samples, held flat past the ends.
  function joinPoints(idx, A, t, smooth) {
    if (!idx.length) return null;
    const xs = Float64Array.from(idx, i => t[i]), ys = Float64Array.from(idx, i => A[i]);
    return smooth ? pchip(xs, ys, t) : interpAt(xs, ys, t);
  }
  // Moving mean and SD (population, N in the denominator: the RMS around the mean) over
  // A[i-half .. i+half], shortened at the ends. The running sums are of A minus its overall
  // mean, so a large offset (gravity) doesn't swamp the variance.
  function movingMeanSd(A, half) {
    const n = A.length, mu = mean(A), s1 = new Float64Array(n + 1), s2 = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) { const d = A[i] - mu; s1[i + 1] = s1[i] + d; s2[i + 1] = s2[i] + d * d; }
    const m = new Float64Array(n), sd = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const lo = Math.max(0, i - half), hi = Math.min(n - 1, i + half), c = hi - lo + 1;
      const m1 = (s1[hi + 1] - s1[lo]) / c;
      m[i] = mu + m1;
      sd[i] = Math.sqrt(Math.max(0, (s2[hi + 1] - s2[lo]) / c - m1 * m1));
    }
    return { mean: m, sd };
  }
  // Moving percentiles q and 100 − q (numpy's default linear interpolation between ranks)
  // over A[i-half .. i+half], shortened at the ends; a sorted copy of the window slides along.
  function movingPercentiles(A, half, q) {
    const n = A.length, win = [], lower = new Float64Array(n), upper = new Float64Array(n);
    const find = v => { let lo = 0, hi = win.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (win[mid] < v) lo = mid + 1; else hi = mid; } return lo; };
    const at = pct => { const r = pct / 100 * (win.length - 1), k = Math.floor(r); return k + 1 < win.length ? win[k] + (r - k) * (win[k + 1] - win[k]) : win[k]; };
    for (let j = 0; j <= Math.min(half, n - 1); j++) win.splice(find(A[j]), 0, A[j]);
    for (let i = 0; i < n; i++) {
      lower[i] = at(q); upper[i] = at(100 - q);
      if (i - half >= 0) win.splice(find(A[i - half]), 1);
      if (i + 1 + half < n) win.splice(find(A[i + 1 + half]), 0, A[i + 1 + half]);
    }
    return { lower, upper };
  }
  const P_ENV_WIN = { key: 'envWindow', label: 'Window', abbr: 'window', min: 0.2, max: 3, step: 0.1, default: 1, unit: 's', dec: 1 };
  const ENVELOPES = [
    {
      id: 'sliding', name: 'Sliding window', params: [P_ENV_WIN], credit: [],
      tagline: 'The highest and lowest value within a window around each moment.',
      compute: (A, t, p) => {
        const h = halfWindow(p.envWindow, p.fs);
        return { upper: windowExtreme(A, h, h, true), lower: windowExtreme(A, h, h, false) };
      },
      label: p => 'Envelope, sliding ' + fmt(p.envWindow, 1) + ' s',
    },
    {
      id: 'peaktrough', name: 'Peak-trough',
      credit: [{ text: 'Fritsch & Carlson, 1980', doi: '10.1137/0717021', note: 'smooth joins' }],
      params: [{ key: 'envPeakWindow', label: 'Peak window', abbr: 'window', min: 0.1, max: 1, step: 0.05, default: 0.3, unit: 's', dec: 2, hint: 'A peak is the highest point within this window; the same for troughs.' },
        { key: 'envSmooth', label: 'Smooth joins', abbr: 'smooth', type: 'bool', default: false, hint: 'A monotone cubic through the peaks instead of straight lines. It never overshoots between them.' }],
      tagline: 'Lines joining successive peaks, and successive troughs: straight, or a smooth curve that never overshoots.',
      compute: (A, t, p) => {
        const h = halfWindow(p.envPeakWindow, p.fs);
        return { upper: joinPoints(localExtrema(A, h, true), A, t, p.envSmooth), lower: joinPoints(localExtrema(A, h, false), A, t, p.envSmooth) };
      },
      label: p => 'Envelope, peak-trough' + (p.envSmooth ? ' (smooth)' : ''),
    },
    {
      id: 'dynamic', name: 'Dynamic threshold', params: [P_ENV_WIN], credit: [CREDIT.zhao],
      tagline: 'The midpoint of the sliding max and min: where an adaptive threshold would sit.',
      // the same dynamicThreshold that Peak-to-valley counts steps with
      compute: (A, t, p) => dynamicThreshold(A, halfWindow(p.envWindow, p.fs)),
      label: p => 'Envelope, sliding ' + fmt(p.envWindow, 1) + ' s',
      midName: 'Dynamic threshold (envelope)',
    },
    {
      id: 'meansd', name: 'Mean \u00b1 k\u00b7SD', credit: [],
      params: [P_ENV_WIN, { key: 'envK', label: 'k (standard deviations)', abbr: 'k', min: 0.25, max: 3, step: 0.25, default: 1, unit: 'SD', dec: 2, hint: 'k = 1: activity (RMS around the mean). k = 0.5: Threshold peaks\u2019 cut-off, following the signal.' }],
      tagline: 'The moving mean \u00b1 k standard deviations. With k = 1 it shows how hard the person moves at each moment (the RMS around the mean); with k = 0.5 its upper line is where Threshold peaks\u2019 cut-off would sit if it followed the signal.',
      compute: (A, t, p) => {
        const { mean: m, sd } = movingMeanSd(A, halfWindow(p.envWindow, p.fs));
        return { mid: m, upper: m.map((v, i) => v + p.envK * sd[i]), lower: m.map((v, i) => v - p.envK * sd[i]) };
      },
      label: p => 'Envelope, mean \u00b1 ' + fmt(p.envK, 2) + '\u00b7SD, ' + fmt(p.envWindow, 1) + ' s',
      midName: 'Moving mean',
    },
    {
      id: 'hilbert', name: 'Hilbert envelope', params: [],
      credit: [{ text: 'Gabor, 1946', doi: '10.1049/ji-3-2.1946.0074', note: 'analytic signal' },
        { text: 'Marple, 1999', doi: '10.1109/78.782222', note: 'computed with the FFT' }],
      tagline: 'The amplitude of the swing at each moment, from the analytic signal (a frequency-domain method): a smooth band that follows every swing. It rings at the ends of the recording.',
      // on an even grid, around the signal's mean; uneven recordings are read back at their own timestamps
      compute: (A, t) => {
        const g = evenGrid(A, t), mu = mean(g.A), z = hilbert(g.A.map(v => v - mu));
        let amp = z.re.map((v, i) => Math.hypot(v, z.im[i]));
        if (g.resampled) amp = interpAt(g.t, amp, t);
        return { upper: amp.map(a => mu + a), lower: amp.map(a => mu - a) };
      },
      label: () => 'Envelope, Hilbert amplitude around the mean',
    },
    {
      id: 'percentile', name: 'Percentile band', credit: [],
      params: [P_ENV_WIN, { key: 'envPct', label: 'Lower percentile (upper is 100 minus it)', abbr: 'pct', min: 1, max: 25, step: 1, default: 10, unit: 'ordinal', dec: 0 }],
      tagline: 'The 10th and 90th percentile (a setting) within a window around each moment: like the sliding max and min, but one spike can\u2019t stretch it.',
      compute: (A, t, p) => movingPercentiles(A, halfWindow(p.envWindow, p.fs), p.envPct),
      label: p => 'Envelope, ' + ORDINAL(p.envPct) + '\u2013' + ORDINAL(100 - p.envPct) + ' percentile, ' + fmt(p.envWindow, 1) + ' s',
    },
  ];

  /* Synthetic demo walk: 5 columns like the course's Walking.mat (t, x, y, z, |a|), and its
     true step count (#81): the cycles of x's noise-free recipe, one peak each, counted while
     the walk fades in and out, so the faint first and last steps count too. */
  function demoWalk() {
    const fs = 100, dur = 22, n = fs * dur;
    let seed = 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
    const t = new Float64Array(n), x = new Float64Array(n), y = new Float64Array(n), z = new Float64Array(n), m = new Float64Array(n);
    let tt = 0, phase = 0, steps = 0, prev2 = 0, prev1 = 0;
    for (let i = 0; i < n; i++) {
      tt += (1 + 0.3 * rnd()) / fs; t[i] = tt;
      const env = Math.min(1, Math.max(0, (tt - 2) / 1.2)) * Math.min(1, Math.max(0, (20 - tt) / 1.2));
      const f = 0.92 + 0.04 * Math.sin(tt / 3);
      phase += 2 * Math.PI * f / fs;
      const r = n => Math.round(n * 100) / 100;
      const clean = env * (9 * Math.sin(phase) + 2.5 * Math.sin(2 * phase + 0.6));
      if (i >= 2 && prev1 > 0 && prev1 >= prev2 && prev1 > clean) steps++; // a peak of the recipe at i - 1
      prev2 = prev1; prev1 = clean;
      x[i] = r(clean + 0.35 * rnd());
      y[i] = r(env * (-4 + 5 * Math.pow(Math.max(0, Math.sin(phase - 0.4)), 3) * 2 - 2 * Math.cos(phase)) + 0.35 * rnd());
      z[i] = r(env * (1.8 * Math.sin(4 * phase) + 1.1 * Math.sin(2 * phase)) + 0.5 * rnd());
      m[i] = r(Math.hypot(x[i], y[i], z[i]));
    }
    return { names: ['time', 'x', 'y', 'z', 'magnitude'], cols: [t, x, y, z, m], steps };
  }

  const api = { InputError, MAX_BYTES, defaultParams, paramSummary, VERSION, EXPORT_FORMAT_VERSION, stepTable, indicatorIds, metricRows, buildExport, exportJson, parseExportJson, exportCsvZip, exportNpz, exportMat, zipStore, crc32, tableCsv, recordingCsv, recordingChecks, STANDARD_GRAVITY, PHONE_POSITIONS, resampleChannel, interpLinear, cozaRateCheck, ANTIALIAS, parseMat, isMat73, parseMat73, matCandidates, matToColumns, parseCsv, isZip, parseZip, readPhyphoxZip, buildDataset,
    prepareChannel, detectOriginal, originalMetrics, detectCoza, timingMetrics, ALGORITHMS, WEAK_RATIO, RHYTHM_RATIO, windowExtreme, windowSamples,
    lowpass, designFilter, sosfiltfilt, dynamicThreshold, detectThresholdPeaks, detectPeakToValley, detectZeroCrossing,
    FILTERS, filterLabel, applyFilter, interpAt, evenGrid, fft, ifft, spectrogram, welch, rhythmOverTime, spectralSteps, spectrogramImage, stftGrid, gridImage, SPECTRO_DB, TRANSFORMS, pngBytes, base64, spectrum, dominantFrequency, GAIT_BAND, filterGain, hilbert, harmonicRatio, oddWindow, movingAverage, movingMedian, savgol, notchSos, dwt, idwt, waveletDenoise, DB4, gravitySplit, datasetRate, ENVELOPES, localExtrema, halfWindow, movingMeanSd, movingPercentiles, pchip,
    median, mean, std, fmt, demoWalk, looksLikeText, creditText, noteOf, exportNotes, NOTE_KINDS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.StepCore = api;
})(typeof self !== 'undefined' ? self : this);
